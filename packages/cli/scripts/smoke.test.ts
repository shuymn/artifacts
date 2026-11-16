// Smoke tests of the release binary: the archive scripts/build.ts made for this host is unpacked, and the binary in it
// runs as a user runs it, against a local server standing in for the API. `pnpm --filter @artifacts/cli run build`
// makes the archive first; CI runs these on each platform's own runner (.github/workflows/cli-binaries.yml).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import rootPackage from "../../../package.json" with { type: "json" };
import { encodePath } from "../src/api.ts";
import { HELP } from "../src/cli.ts";
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
