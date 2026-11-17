// Smoke tests of the release binary: the archive scripts/build.ts made for this host is unpacked, and the binary in it
// runs as a user runs it, against a local server standing in for the API and, for `login`, its OAuth side, with a
// stand-in for the system's opener on PATH playing the browser. `pnpm --filter @artifacts/cli run build` makes the
// archive first; CI runs these on each platform's own runner (.github/workflows/cli-binaries.yml).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import rootPackage from "../../../package.json" with { type: "json" };
import { encodePath } from "../src/api.ts";
import { HELP } from "../src/cli.ts";
import { exists, StandIn } from "../src/login-test-support.ts";
import { artifact, ID, local, tempDir, TOKEN, version, writeTree, type Ran } from "../src/test-support.ts";
import { archiveName, binaryName, tarCommand, target } from "./release.ts";

const { tag, platform } = target({ version: rootPackage.version, os: process.platform, arch: process.arch });
const ARCHIVE = join(fileURLToPath(new URL("../dist/", import.meta.url)), archiveName(tag, platform));
/** The environment without the developer's configuration, so each test gives the binary its own. */
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ARTIFACTS_")));

let unpacked: string;
let binary: string;

beforeAll(async () => {
  unpacked = await mkdtemp(join(tmpdir(), "artifacts-smoke-"));
  execFileSync(tarCommand(), ["-xf", ARCHIVE, "-C", unpacked]);
  binary = join(unpacked, binaryName(platform));
});

afterAll(async () => {
  if (unpacked !== undefined) await rm(unpacked, { recursive: true, force: true });
});

/** Runs the binary in `cwd`, killed if it is still running after 30 s. */
function artifacts(args: readonly string[], options: { env?: Record<string, string>; cwd?: string } = {}) {
  return new Promise<Ran>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd ?? unpacked,
      env: { ...BASE_ENV, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Every file below `root`, by its /-separated relative path. */
async function files(root: string): Promise<Record<string, Buffer>> {
  const found: Record<string, Buffer> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found[path.slice(root.length + 1).replaceAll("\\", "/")] = await readFile(path);
  }
  return found;
}

describe("the release archive", () => {
  it("holds the binary alone, at its root", () => {
    const listed = execFileSync(tarCommand(), ["-tf", ARCHIVE], { encoding: "utf8" });
    expect(listed.split(/\r?\n/).filter((line) => line !== "")).toEqual([binaryName(platform)]);
  });
});

describe("the binary", () => {
  it("prints the root package's version for exactly --version", async () => {
    expect(await artifacts(["--version"])).toEqual({ status: 0, stdout: `${rootPackage.version}\n`, stderr: "" });
  });

  it("prints the help", async () => {
    expect(await artifacts(["--help"])).toEqual({ status: 0, stdout: HELP, stderr: "" });
  });

  it("exits 2 on a usage error and 1 on an error", async () => {
    const usage = await artifacts(["bogus"]);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('unknown command "bogus"');
    const unconfigured = await artifacts(["list"]);
    expect(unconfigured.status).toBe(1);
    expect(unconfigured.stderr).toContain("set ARTIFACTS_API_URL");
  });

  it("generates a token and its API_TOKENS entry", async () => {
    const { status, stdout } = await artifacts(["token", "smoke"]);
    expect(status).toBe(0);
    const [token = "", entry = "", ...rest] = stdout.split("\n");
    expect(rest).toEqual([""]);
    expect(token).toMatch(/^art_[a-z2-7]{32}$/);
    expect(entry).toBe(`"smoke": "${createHash("sha256").update(token).digest("hex")}"`);
  });

  it("reads neither .env nor bunfig.toml from the directory it runs in", async () => {
    const cwd = await tempDir();
    await writeTree(cwd, {
      ".env": `ARTIFACTS_API_URL=http://127.0.0.1:9\nARTIFACTS_TOKEN=${TOKEN}\n`,
      "bunfig.toml": 'preload = ["./preload.ts"]\n',
      "preload.ts": 'console.error("preloaded");\n',
    });
    const { status, stderr } = await artifacts(["list"], { cwd });
    expect(status).toBe(1);
    expect(stderr).toBe(
      "artifacts: set ARTIFACTS_API_URL to the API origin, such as https://artifacts-api.example.com\n",
    );
  });

  it("publishes a directory to the API and pulls it back unchanged", async () => {
    const stored = new Map<string, Uint8Array>();
    const listing = () => version([...stored].map(([path, bytes]) => ({ path, body: bytes })));
    const seen: string[] = [];
    const env = await local(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      seen.push(`${request.method} ${url.pathname}`);
      const sent = await body(request);
      const answer = (status: number, value: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return answer(401, { error: { code: "unauthorized" } });
      if (request.method === "POST" && url.pathname === "/v1/artifacts") {
        const form = await new Response(sent, {
          headers: { "Content-Type": request.headers["content-type"] ?? "" },
        }).formData();
        const metaPart = form.get("meta");
        if (typeof metaPart !== "string") return answer(400, { error: { code: "invalid_request" } });
        const meta: { title: string; files: { path: string }[] } = JSON.parse(metaPart);
        const parts = form.getAll("file");
        for (const [index, { path }] of meta.files.entries()) {
          const part = parts[index];
          if (part instanceof Blob) stored.set(path, new Uint8Array(await part.arrayBuffer()));
        }
        return answer(201, { artifact: artifact(ID, meta.title), version: listing() });
      }
      if (request.method === "GET" && url.pathname === `/v1/artifacts/${ID}`) {
        return answer(200, { artifact: artifact(ID), version: listing() });
      }
      const prefix = `/v1/artifacts/${ID}/versions/1/files/`;
      const file = url.pathname.startsWith(prefix)
        ? stored.get(url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/"))
        : undefined;
      if (request.method === "GET" && file !== undefined) {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        return response.end(file);
      }
      return answer(404, { error: { code: "not_found" } });
    });

    const source = await tempDir();
    await writeTree(source, {
      "index.html": '<link href="css/site.css"><img src="img/logo.png">',
      "css/site.css": "body{color:red}",
      "img/logo.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]),
      "100% café.txt": "encoded",
    });
    const published = await artifacts(["publish", source, "--title", "Smoke"], { env });
    expect(published).toMatchObject({ status: 0, stderr: "" });
    expect(published.stdout).toContain(`created ${ID} version 1`);

    const destination = join(await tempDir(), "pulled");
    const pulled = await artifacts(["pull", ID, destination], { env });
    expect(pulled).toMatchObject({ status: 0, stderr: "" });
    expect(await files(destination)).toEqual(await files(source));
    expect(seen).toEqual([
      "POST /v1/artifacts",
      `GET /v1/artifacts/${ID}`,
      ...[...stored.keys()].map((path) => `GET /v1/artifacts/${ID}/versions/1/files/${encodePath(path)}`),
    ]);
  });
});

/** A configuration directory holding a credentials file the CLI must not read: garbage, readable by anyone. */
async function unreadableLogin(): Promise<string> {
  const home = await tempDir();
  await mkdir(join(home, "artifacts"), { recursive: true });
  const file = join(home, "artifacts", "credentials.json");
  await writeFile(file, "not a stored login");
  await chmod(file, 0o644);
  return home;
}

describe("export", () => {
  it("writes the archive to <id>-v<n>.zip in the directory it runs in and never replaces it", async () => {
    const archive = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);
    const seen: string[] = [];
    const env = await local((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      if (request.url === `/v1/artifacts/${ID}`) {
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ artifact: artifact(ID), version: version([]) }));
      }
      if (request.url === `/v1/artifacts/${ID}/versions/1/export`) {
        response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": String(archive.byteLength) });
        return response.end(archive);
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ error: { code: "not_found", message: "m" } }));
    });
    const cwd = await tempDir();
    const exported = await artifacts(["export", ID], { env, cwd });
    expect(exported).toEqual({
      status: 0,
      stdout: `exported ${ID} version 1 to ${ID}-v1.zip (4096 bytes)\n`,
      stderr: "",
    });
    expect(await readdir(cwd)).toEqual([`${ID}-v1.zip`]);
    expect(new Uint8Array(await readFile(join(cwd, `${ID}-v1.zip`)))).toEqual(archive);

    const again = await artifacts(["export", ID], { env, cwd });
    expect(again).toMatchObject({ status: 1, stdout: "" });
    expect(again.stderr).toContain(`"${ID}-v1.zip" exists; export does not replace it`);
    expect(seen).toEqual([
      `GET /v1/artifacts/${ID}`,
      `GET /v1/artifacts/${ID}/versions/1/export`,
      `GET /v1/artifacts/${ID}`,
    ]);
  });

  // Windows has no signals to send: Node's kill ends the process there without one.
  it.runIf(process.platform !== "win32")("removes its part when SIGINT stops the download", async () => {
    const env = await local((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": "4096" });
      response.write(new Uint8Array(1024));
    });
    const cwd = await tempDir();
    const child = spawn(binary, ["export", ID, "--version", "1"], {
      cwd,
      env: { ...BASE_ENV, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    // The part holds the first bytes once the download is under way.
    for (let tries = 0; tries < 300; tries++) {
      const [part] = await readdir(cwd);
      if (part !== undefined && (await stat(join(cwd, part))).size > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill("SIGINT");
    expect(await closed).toBe(1);
    expect(stderr).toBe("artifacts: interrupted; the partial download was removed\n");
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("the credential", () => {
  it("is ARTIFACTS_TOKEN when it is set, and a credentials file placed beforehand is not read", async () => {
    const seen: (string | undefined)[] = [];
    const env = await local((request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ artifacts: [], next_cursor: null }));
    });
    const ran = await artifacts(["list"], { env: { ...env, XDG_CONFIG_HOME: await unreadableLogin() } });
    expect(ran).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(seen).toEqual([`Bearer ${TOKEN}`]);
  });
});

describe.runIf(process.platform === "win32")("on Windows", () => {
  it("refuses login and logout, naming ARTIFACTS_TOKEN", async () => {
    const env = { ARTIFACTS_API_URL: "https://artifacts-api.example.com", XDG_CONFIG_HOME: await tempDir() };
    for (const command of ["login", "logout"]) {
      const ran = await artifacts([command], { env });
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain(`${command} is not offered on Windows`);
      expect(ran.stderr).toContain("set ARTIFACTS_TOKEN to an API token");
    }
  });

  it("without ARTIFACTS_TOKEN names only it, without reading a credentials file", async () => {
    const env = { ARTIFACTS_API_URL: "https://artifacts-api.example.com", XDG_CONFIG_HOME: await unreadableLogin() };
    expect(await artifacts(["list"], { env })).toEqual({
      status: 1,
      stdout: "",
      stderr: "artifacts: set ARTIFACTS_TOKEN to an API token\n",
    });
  });
});

/** The URL the opener stand-in was given, once it has written all of it (the last parameter is `resource`). */
async function openedUrl(path: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const text = (await exists(path)) ? await readFile(path, "utf8") : "";
    if (text.includes("&resource=")) return text;
    if (Date.now() > deadline) throw new Error("the opener was not run");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.runIf(process.platform !== "win32")("login", () => {
  it("signs in through the system's opener, refreshes for a command and signs out", async () => {
    const standIn = await StandIn.start();
    // Tokens that expire within a minute: the next command refreshes them first.
    standIn.expiresIn = 30;
    const home = await tempDir();
    const bin = await tempDir();
    const opened = join(bin, "opened");
    const opener = join(bin, process.platform === "darwin" ? "open" : "xdg-open");
    await writeFile(opener, `#!/bin/sh\nprintf '%s' "$1" > "${opened}"\n`);
    await chmod(opener, 0o755);
    const env = {
      ARTIFACTS_API_URL: standIn.origin,
      XDG_CONFIG_HOME: home,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    };

    const signingIn = artifacts(["login"], { env });
    const url = await openedUrl(opened);
    standIn.approve(url);
    const signedIn = await signingIn;
    expect(signedIn).toMatchObject({ status: 0, stdout: `signed in to ${standIn.origin}\n` });
    expect(signedIn.stderr).toContain(url);
    const file = join(home, "artifacts", "credentials.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "artifacts"))).mode & 0o777).toBe(0o700);

    expect(await artifacts(["list"], { env })).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(1);

    const grant = (await readFile(file, "utf8")).match(/"access_token": "owner:([^:]+):/)?.[1];
    expect(await artifacts(["logout"], { env })).toEqual({
      status: 0,
      stdout: `signed out of ${standIn.origin}\n`,
      stderr: "",
    });
    expect(standIn.requests.at(-1)).toBe(`DELETE /v1/grants/${grant}`);
    expect(standIn.grants.size).toBe(0);
    const list = await artifacts(["list"], { env });
    expect(list.status).toBe(1);
    expect(list.stderr).toContain("sign in with artifacts login");
  });
});
