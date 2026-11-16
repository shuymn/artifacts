// The command line, configuration, token generation and failure paths, against stubbed API answers. The Worker itself
// answers in e2e.test.ts.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Fetch } from "./api.ts";
import { HELP } from "./cli.ts";
import { cli, tempDir, writeTree } from "./test-support.ts";

const TOKEN = `art_${"t".repeat(32)}`;
const ENV = { ARTIFACTS_API_URL: "https://artifacts-api.example.com", ARTIFACTS_TOKEN: TOKEN };
const ID = "a".repeat(26);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function artifact(id: string, title = "t") {
  return {
    id,
    title,
    description: "",
    public: false,
    archived: false,
    archive: null,
    latest_version: 1,
    created_at: "2026-11-16T09:00:00.000Z",
    updated_at: "2026-11-16T09:00:00.000Z",
    url: `https://${id}-art.example.com/`,
    public_url: null,
    gallery_url: `https://artifacts.example.com/a/${id}`,
  };
}

function version(files: { path: string; body: string }[]) {
  return {
    number: 1,
    created_at: "2026-11-16T09:00:00.000Z",
    published_by: "codex",
    title: "t",
    description: "",
    file_count: files.length,
    total_bytes: 0,
    url: `https://${ID}-art.example.com/_v/1/`,
    files: files.map(({ path, body }) => ({
      path,
      size: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
      content_type: "text/plain; charset=utf-8",
    })),
  };
}

/** A fetch that never answers until its request's signal aborts, as a stalled connection does. */
const stalled: Fetch = (_input, init) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

/** A listing whose every page names the same next cursor; past ten pages it stops answering, so a loop ends. */
function looping(): Fetch {
  let pages = 0;
  return async () =>
    ++pages > 10 ? Promise.reject(new TypeError("fetch failed")) : json(200, { artifacts: [], next_cursor: "same" });
}

const SHORT = { requestMs: 50, publishMs: 50, fileMs: 50 };

describe("help", () => {
  it("carries the authoring rule in the words of design.md section 4", async () => {
    const { status, stdout } = await cli(["help"]);
    expect(status).toBe(0);
    expect(stdout).toBe(HELP);
    expect(stdout).toContain(
      "Link between an artifact's files with relative URLs (style.css, img/logo.png), percent-encoding each segment (\\ as\n" +
        "%5C). A root-relative or absolute link to the artifact's own host loads the latest version's file when an older\n" +
        "version is viewed.",
    );
    for (const rule of ["index.html at its root", '"_v/" or "cdn-cgi/"', 'Names starting with "." are skipped']) {
      expect(stdout).toContain(rule);
    }
    expect((await cli([])).stdout).toBe(HELP);
    expect((await cli(["get", "--help"])).stdout).toBe(HELP);
  });
});

describe("usage", () => {
  it.each([
    [["bogus"], 'unknown command "bogus"'],
    [["list", "extra"], "wrong number of arguments; usage: artifacts list"],
    [["get", ID, "--title", "x"], "get does not take --title"],
    [["get", "not-an-id"], "an artifact ID is 26 characters"],
    [["get", ID, "--version", "0"], "--version takes a version number"],
    [["get", ID, "--version", "01"], "--version takes a version number"],
    [["list", "--archived", "all"], "--archived is one of exclude, only, include"],
    [["public", ID, "yes"], "the public setting is one of on, off"],
    [["archive", ID, "never"], "the archive setting is one of on, off, auto"],
    [["publish", "dir"], "creating an artifact needs --title"],
    [["token", "Bad_Name"], "a token name is 1 to 32 characters"],
    [["get", ID, "--nope"], "Unknown option '--nope'"],
  ])("%j is a usage error", async (argv, message) => {
    const { status, stderr } = await cli(argv, { env: ENV });
    expect(status).toBe(2);
    expect(stderr).toContain(message);
  });
});

describe("configuration", () => {
  it.each([
    [{}, "set ARTIFACTS_API_URL"],
    [{ ARTIFACTS_API_URL: "not a url", ARTIFACTS_TOKEN: TOKEN }, "ARTIFACTS_API_URL is not a URL"],
    [{ ARTIFACTS_API_URL: "http://artifacts-api.example.com", ARTIFACTS_TOKEN: TOKEN }, "must use https"],
    [{ ARTIFACTS_API_URL: "https://artifacts-api.example.com/v1", ARTIFACTS_TOKEN: TOKEN }, "without a path"],
    [{ ARTIFACTS_API_URL: "https://artifacts-api.example.com" }, "set ARTIFACTS_TOKEN"],
    [{ ...ENV, ARTIFACTS_TOKEN: `${TOKEN}\n` }, "ARTIFACTS_TOKEN has characters a token cannot have"],
  ])("refuses %j", async (env, message) => {
    const { status, stderr } = await cli(["list"], { env });
    expect(status).toBe(1);
    expect(stderr).toContain(message);
    expect(stderr).not.toContain(TOKEN);
  });

  it("takes http for localhost names and sends the token as a bearer token", async () => {
    const seen: string[] = [];
    const fetch: Fetch = async (input, init) => {
      seen.push(`${input} ${new Headers(init.headers).get("Authorization")}`);
      return json(200, { artifacts: [], next_cursor: null });
    };
    for (const url of ["http://api.localhost:8787", "http://localhost:8787/", "http://127.0.0.1:8787"]) {
      expect((await cli(["list"], { env: { ARTIFACTS_API_URL: url, ARTIFACTS_TOKEN: TOKEN }, fetch })).status).toBe(0);
    }
    expect(seen).toEqual([
      `http://api.localhost:8787/v1/artifacts?limit=100 Bearer ${TOKEN}`,
      `http://localhost:8787/v1/artifacts?limit=100 Bearer ${TOKEN}`,
      `http://127.0.0.1:8787/v1/artifacts?limit=100 Bearer ${TOKEN}`,
    ]);
  });
});

describe("the token is never printed", () => {
  it.each<[string, Fetch]>([
    ["a 401", async () => json(401, { error: { code: "unauthorized", message: "a valid bearer token is required" } })],
    ["an error naming the token", async () => json(500, { error: { code: "internal", message: `echo ${TOKEN}` } })],
    [
      "a network failure whose cause names it",
      async () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED", message: TOKEN } })),
    ],
    ["a body that is not JSON", async () => new Response(TOKEN, { status: 502 })],
  ])("after %s", async (_name, fetch) => {
    for (const argv of [["list"], ["get", ID, "--json"], ["delete", ID], ["public", ID, "on"]]) {
      const { status, stdout, stderr } = await cli(argv, { env: ENV, fetch });
      expect(status).toBe(1);
      expect(stdout + stderr).not.toContain(TOKEN);
    }
  });
});

describe("token", () => {
  it("prints a new token once and the API_TOKENS entry holding its SHA-256", async () => {
    const first = await cli(["token", "codex"]);
    const second = await cli(["token", "codex"]);
    expect(first.status).toBe(0);
    const [token = "", entry = "", ...rest] = first.stdout.split("\n");
    expect(rest).toEqual([""]);
    expect(token).toMatch(/^art_[a-z2-7]{32}$/);
    expect(entry).toBe(`"codex": "${createHash("sha256").update(token).digest("hex")}"`);
    expect(JSON.parse(`{${entry}}`)).toEqual({ codex: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(second.stdout.split("\n")[0]).not.toBe(token);
    expect(first.stderr).toContain("shown once");
  });
});

describe("list", () => {
  it("follows every page with the cursor it was given and stops at a repeated cursor", async () => {
    const urls: string[] = [];
    const pages = [
      { artifacts: [artifact("b".repeat(26))], next_cursor: "c1" },
      { artifacts: [artifact("c".repeat(26))], next_cursor: "c2" },
      { artifacts: [artifact("d".repeat(26))], next_cursor: null },
    ];
    const fetch: Fetch = async (input) => {
      urls.push(input);
      return json(200, pages[urls.length - 1]);
    };
    const { status, stdout } = await cli(["list", "--archived", "include", "--json"], { env: ENV, fetch, pageSize: 1 });
    expect(status).toBe(0);
    expect(urls.map((url) => new URL(url).search)).toEqual([
      "?limit=1&archived=include",
      "?limit=1&archived=include&cursor=c1",
      "?limit=1&archived=include&cursor=c2",
    ]);
    expect(JSON.parse(stdout)).toEqual({ artifacts: pages.flatMap((page) => page.artifacts), next_cursor: null });

    const loop = await cli(["list"], { env: ENV, fetch: looping() });
    expect(loop.status).toBe(1);
    expect(loop.stderr).toContain("the API repeated a listing cursor");
  });
});

describe("timeouts", () => {
  it("ends a request that gets no answer", async () => {
    const { status, stderr } = await cli(["get", ID], { env: ENV, fetch: stalled, timeouts: SHORT });
    expect(status).toBe(1);
    expect(stderr).toContain("the API did not answer within 0.05 s");
  });

  it("ends a create whose answer and listing both stall, without creating again", async () => {
    const root = await tempDir();
    await writeTree(root, { "index.html": "x" });
    let posts = 0;
    const fetch: Fetch = (input, init) => {
      if (init.method === "POST") posts++;
      return stalled(input, init);
    };
    const { status, stderr } = await cli(["publish", root, "--title", "t"], { env: ENV, fetch, timeouts: SHORT });
    expect(status).toBe(1);
    expect(stderr).toContain("the create got no answer and the artifacts could not be listed");
    expect(posts).toBe(1);
  });

  it("ends a download that stalls and removes its partial file", async () => {
    const files = [
      { path: "index.html", body: "<p>x</p>" },
      { path: "slow.css", body: "a{}" },
    ];
    const fetch: Fetch = async (input, init) => {
      if (!input.includes("/files/")) return json(200, { artifact: artifact(ID), version: version(files) });
      if (input.endsWith("/index.html")) return new Response("<p>x</p>");
      // A body that sends one chunk, then nothing until the request's timeout aborts it.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a"));
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body);
    };
    const target = join(await tempDir(), "out");
    const { status, stderr } = await cli(["pull", ID, target], { env: ENV, fetch, timeouts: SHORT });
    expect(status).toBe(1);
    expect(stderr).toContain('the download of "slow.css" did not finish in time');
    expect(await readdir(target)).toEqual(["index.html"]);
    expect(await readFile(join(target, "index.html"), "utf8")).toBe("<p>x</p>");
  });
});

describe("pull", () => {
  it("refuses bytes that differ from the listing and removes the file", async () => {
    const fetch: Fetch = async (input) =>
      input.includes("/files/")
        ? new Response("tampered")
        : json(200, { artifact: artifact(ID), version: version([{ path: "index.html", body: "original" }]) });
    const target = join(await tempDir(), "out");
    const { status, stderr } = await cli(["pull", ID, target], { env: ENV, fetch });
    expect(status).toBe(1);
    expect(stderr).toContain(`the bytes of "index.html" differ from the version's listing`);
    expect(await readdir(target)).toEqual([]);
  });

  it("refuses a version holding a file and a file below a directory of the same name, before writing", async () => {
    const files = [
      { path: "index.html", body: "x" },
      { path: "docs", body: "d" },
      { path: "docs/index.html", body: "y" },
    ];
    const fetch: Fetch = async () => json(200, { artifact: artifact(ID), version: version(files) });
    const parent = await tempDir();
    const { status, stderr } = await cli(["pull", ID, join(parent, "out")], { env: ENV, fetch });
    expect(status).toBe(1);
    expect(stderr).toContain('a file "docs" and a file below it, "docs/index.html"');
    expect(await readdir(parent)).toEqual([]);
  });
});
