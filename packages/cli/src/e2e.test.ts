// PL-30 end to end: the CLI's requests travel as multipart over HTTP to the Worker in the local runtime (wrangler's
// test harness, with D1 and R2), and the files are read back from the content and public hosts. The harness's
// dispatch keeps each request's absolute URL, so the Worker sees the configured `*.localhost` hosts without DNS.
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";

import type { Fetch } from "./api.ts";
import { cli, tempDir, writeTree, type Ran, type Tree } from "./test-support.ts";

const WORKER = fileURLToPath(new URL("../../worker/", import.meta.url));
const API = "http://api.localhost";
const content = (id: string, path: string) => `http://${id}-art.localhost${path}`;
const publicHost = (id: string, path: string) => `http://${id}-pub.localhost${path}`;

let server: TestHarness;
let env: Record<string, string>;

/** Hands a request the CLI made to the Worker: Node encodes the body exactly as its `fetch` would send it. */
const toWorker: Fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
  const answer = await server.fetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
    ...(init.signal === null || init.signal === undefined ? {} : { signal: init.signal }),
  });
  return new Response(answer.body, { status: answer.status, headers: [...answer.headers] });
};

beforeAll(async () => {
  // The Worker admits the token the CLI's own `token` command generates.
  const generated = await cli(["token", "e2e"]);
  const [token = "", entry = ""] = generated.stdout.split("\n");
  server = createTestHarness({
    root: WORKER,
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          APP_HOST: "app.localhost",
          API_HOST: "api.localhost",
          CONTENT_HOST_SUFFIX: "-art.localhost",
          PUBLIC_HOST_SUFFIX: "-pub.localhost",
          ARCHIVE_AFTER_DAYS: "30",
        },
        secrets: { API_TOKENS: `{${entry}}` },
      },
    ],
  });
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  env = { ARTIFACTS_API_URL: API, ARTIFACTS_TOKEN: token };
}, 120_000);

afterAll(async () => {
  await server?.close();
});

type Sent = { readonly method: string; readonly url: string; readonly meta: Record<string, unknown> | undefined };

/** The CLI against the Worker, recording each request and its multipart `meta`; `around` may replace a call. */
async function run(
  argv: readonly string[],
  options: { around?: (request: Sent, forward: () => Promise<Response>) => Promise<Response>; pageSize?: number } = {},
): Promise<Ran & { sent: Sent[] }> {
  const sent: Sent[] = [];
  const fetch: Fetch = async (input, init) => {
    let meta: Record<string, unknown> | undefined;
    if (init.body instanceof Blob) {
      const form = await new Response(init.body, { headers: new Headers(init.headers) }).formData();
      const part = form.get("meta");
      meta = typeof part === "string" ? JSON.parse(part) : undefined;
    }
    const request = { method: init.method ?? "GET", url: input, meta };
    sent.push(request);
    const forward = () => toWorker(input, init);
    return options.around === undefined ? forward() : options.around(request, forward);
  };
  const ran = await cli(argv, {
    env,
    fetch,
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  return { ...ran, sent };
}

type PublishJson = {
  artifact: { id: string; latest_version: number; title: string; public_url: string | null };
  version: { number: number; files: { path: string; sha256: string; content_type: string }[] };
};

async function publishJson(argv: readonly string[]): Promise<PublishJson> {
  const ran = await run([...argv, "--json"]);
  if (ran.status !== 0) throw new Error(`publish failed: ${ran.stderr}`);
  const parsed: PublishJson = JSON.parse(ran.stdout);
  return parsed;
}

type Listing = { artifacts: { id: string; title: string }[]; next_cursor: null };

/** The IDs of every artifact, archived ones included, with `title`. */
async function titled(title: string): Promise<string[]> {
  const listed: Listing = JSON.parse((await run(["list", "--archived", "include", "--json"])).stdout);
  return listed.artifacts.filter((artifact) => artifact.title === title).map((artifact) => artifact.id);
}

/** Forwards a create, then loses its answer as a reset connection would. */
async function lostAfterCommit(request: Sent, forward: () => Promise<Response>): Promise<Response> {
  if (request.method !== "POST") return forward();
  await forward();
  throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
}

async function tree(files: Tree): Promise<string> {
  const root = await tempDir();
  await writeTree(root, files);
  return root;
}

async function served(url: string): Promise<{ status: number; type: string | null; text: string }> {
  const response = await server.fetch(url);
  return { status: response.status, type: response.headers.get("Content-Type"), text: await response.text() };
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);

describe("publish", () => {
  it("sends every mapped file as multipart and the Worker serves each at its percent-encoded path", async () => {
    const outside = await tree({ "secret.txt": "outside" });
    const root = await tree({
      "index.html": '<link href="real/site.css"><link href="alias/site.css"><img src="img/logo.png">',
      "real/site.css": "body{color:red}",
      alias: { link: "real" },
      "img/logo.png": PNG,
      "back\\slash.css": "a{}",
      "hash#name.js": "1",
      "what?.txt": "q",
      "café.css": "nfd{}",
      "100%.txt": "pct",
      ".env": "SECRET=1",
      ".git/config": "[core]",
    });
    const created = await run(["publish", root, "--title", "Mapped", "--description", "d", "--json"]);
    expect(created).toMatchObject({ status: 0 });
    const { artifact, version } = JSON.parse(created.stdout);
    const id: string = artifact.id;
    expect(version.files.map((file: { path: string }) => file.path).toSorted()).toEqual(
      [
        "100%.txt",
        "alias/site.css",
        "back\\slash.css",
        "café.css".normalize("NFC"),
        "hash#name.js",
        "img/logo.png",
        "index.html",
        "real/site.css",
        "what?.txt",
      ].toSorted(),
    );
    expect(created.sent).toHaveLength(1);
    expect(created.sent[0]?.meta).toMatchObject({ title: "Mapped", description: "d" });

    const expected: [string, string, string][] = [
      ["/", "text/html; charset=utf-8", "<link"],
      ["/real/site.css", "text/css; charset=utf-8", "body{color:red}"],
      ["/alias/site.css", "text/css; charset=utf-8", "body{color:red}"],
      ["/back%5Cslash.css", "text/css; charset=utf-8", "a{}"],
      ["/hash%23name.js", "text/javascript; charset=utf-8", "1"],
      ["/what%3F.txt", "text/plain; charset=utf-8", "q"],
      ["/caf%C3%A9.css", "text/css; charset=utf-8", "nfd{}"],
      ["/100%25.txt", "text/plain; charset=utf-8", "pct"],
      ["/_v/1/alias/site.css", "text/css; charset=utf-8", "body{color:red}"],
    ];
    for (const [path, type, text] of expected) {
      const file = await served(content(id, path));
      expect([path, file.status, file.type, file.text.startsWith(text)]).toEqual([path, 200, type, true]);
    }
    const png = await server.fetch(content(id, "/img/logo.png"));
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
    expect((await served(content(id, "/.env"))).status).toBe(404);

    // AC-2's other half: a link that leaves the directory stops the publish before anything is sent.
    await writeTree(root, { "leak.txt": { link: join(outside, "secret.txt") } });
    const refused = await run(["publish", root, "--title", "Leak"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('the link "leak.txt" leaves the directory');
    expect(refused.sent).toEqual([]);
  });

  it("publishes a single HTML file as index.html", async () => {
    const root = await tree({ "report.html": "<h1>Report</h1>" });
    const { artifact } = await publishJson(["publish", join(root, "report.html"), "--title", "Single"]);
    expect(await served(content(artifact.id, "/"))).toMatchObject({ status: 200, text: "<h1>Report</h1>" });
  });

  it("refuses a directory without index.html, sending nothing", async () => {
    const root = await tree({ "page.html": "x" });
    const ran = await run(["publish", root, "--title", "No entry"]);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("every version needs index.html at its root");
    expect(ran.sent).toEqual([]);
  });
});

describe("update", () => {
  it("sends only new and changed files, removes what the directory lacks, and bases on the version it read", async () => {
    const root = await tree({ "index.html": "<p>1</p>", "a.css": "a{}", "b.js": "b", "same/c.txt": "c" });
    const { artifact } = await publishJson(["publish", root, "--title", "Update"]);
    await writeTree(root, { "a.css": "a{color:blue}", "new.txt": "n" });
    await unlink(join(root, "b.js"));

    const ran = await run(["publish", root, "--id", artifact.id]);
    expect(ran).toMatchObject({ status: 0 });
    expect(ran.stdout).toContain(`published ${artifact.id} version 2 (sent 2, removed 1, unchanged 2)`);
    const [read, post] = ran.sent;
    expect(read).toMatchObject({ method: "GET", url: `${API}/v1/artifacts/${artifact.id}` });
    expect(post?.meta).toEqual({
      base_version: 1,
      files: [{ path: "a.css" }, { path: "new.txt" }],
      remove: ["b.js"],
    });
    expect((await served(content(artifact.id, "/a.css"))).text).toBe("a{color:blue}");
    expect((await served(content(artifact.id, "/b.js"))).status).toBe(404);
    expect((await served(content(artifact.id, "/_v/1/b.js"))).text).toBe("b");
    expect((await served(content(artifact.id, "/same/c.txt"))).text).toBe("c");

    // Nothing changed: nothing is sent, and the version keeps every file.
    const again = await run(["publish", root, "--id", artifact.id, "--title", "Renamed"]);
    expect(again).toMatchObject({ status: 0 });
    expect(again.sent[1]?.meta).toEqual({ base_version: 2, title: "Renamed", files: [], remove: [] });
  });

  it("reports a conflict when another version lands after the read, and does not retry", async () => {
    const root = await tree({ "index.html": "<p>mine</p>" });
    const { artifact } = await publishJson(["publish", root, "--title", "Conflict"]);
    const other = await tree({ "index.html": "<p>theirs</p>" });
    let theirs: Ran | undefined;
    const ran = await run(["publish", root, "--id", artifact.id], {
      around: async (request, forward) => {
        // Another agent publishes from the same base between this CLI's read and its update.
        if (request.method === "POST") theirs = await run(["publish", other, "--id", artifact.id]);
        return forward();
      },
    });
    expect(theirs).toMatchObject({ status: 0 });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("version_conflict: version 2 was published after version 1");
    expect(ran.sent.filter((request) => request.method === "POST")).toHaveLength(1);
    expect((await served(content(artifact.id, "/"))).text).toBe("<p>theirs</p>");
    expect((await served(content(artifact.id, "/_v/3/"))).status).toBe(404);
  });
});

describe("a create whose answer is lost", () => {
  it("takes the artifact it made from the listing instead of creating it twice", async () => {
    const root = await tree({ "index.html": "<p>lost</p>", "x.css": "x" });
    const ran = await run(["publish", root, "--title", "Lost after commit"], { around: lostAfterCommit });
    expect(ran).toMatchObject({ status: 0 });
    expect(ran.stderr).toContain("the create got no answer; the listing shows the artifact it made");
    expect(ran.sent.filter((request) => request.method === "POST")).toHaveLength(1);
    const ids = await titled("Lost after commit");
    expect(ids).toHaveLength(1);
    expect(ran.stdout).toContain(`created ${ids[0]} version 1`);
  });

  it.each([
    ["no answer", () => Promise.reject(new TypeError("fetch failed"))],
    ["a 502 from a proxy", () => Promise.resolve(new Response("bad gateway", { status: 502 }))],
  ])("creates once more when the listing lacks it (%s before the Worker)", async (name, drop) => {
    const title = `Lost before the Worker: ${name}`;
    // An artifact with the same title and other files is not the one this publish made.
    const decoy = await tree({ "index.html": "<p>other</p>" });
    await publishJson(["publish", decoy, "--title", title]);
    const root = await tree({ "index.html": "<p>mine</p>" });
    let posts = 0;
    const ran = await run(["publish", root, "--title", title], {
      around: async (request, forward) => (request.method === "POST" && ++posts === 1 ? drop() : forward()),
    });
    expect(ran).toMatchObject({ status: 0 });
    expect(posts).toBe(2);
    const ids = await titled(title);
    expect(ids).toHaveLength(2);
    const id = ran.stdout.match(/^created ([a-z2-7]{26}) /)?.[1] ?? "";
    expect((await served(content(id, "/"))).text).toBe("<p>mine</p>");
  });

  it("matches the bytes it sent, not the files as they are after the answer was lost", async () => {
    const root = await tree({ "index.html": "<p>sent</p>" });
    const ran = await run(["publish", root, "--title", "Lost, then edited"], {
      around: async (request, forward) => {
        const answer = lostAfterCommit(request, forward);
        // The local file changes while the answer is lost, before the listing is compared.
        if (request.method === "POST") await answer.catch(() => writeTree(root, { "index.html": "<p>edited</p>" }));
        return answer;
      },
    });
    expect(ran).toMatchObject({ status: 0 });
    expect(ran.stderr).toContain("the listing shows the artifact it made");
    expect(ran.sent.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(await titled("Lost, then edited")).toHaveLength(1);
  });

  it("sends the same bytes again when it creates once more", async () => {
    const root = await tree({ "index.html": "<p>sent</p>" });
    let posts = 0;
    const ran = await run(["publish", root, "--title", "Lost, edited, sent again"], {
      around: async (request, forward) => {
        if (request.method !== "POST" || ++posts > 1) return forward();
        await writeTree(root, { "index.html": "<p>edited</p>" });
        throw new TypeError("fetch failed");
      },
    });
    expect(ran).toMatchObject({ status: 0 });
    expect(posts).toBe(2);
    const [id = ""] = await titled("Lost, edited, sent again");
    expect((await served(content(id, "/"))).text).toBe("<p>sent</p>");
  });

  it("gives up after a second lost answer", async () => {
    const root = await tree({ "index.html": "<p>twice</p>" });
    const ran = await run(["publish", root, "--title", "Lost twice"], {
      around: async (request, forward) =>
        request.method === "POST" ? Promise.reject(new TypeError("fetch failed")) : forward(),
    });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("the create got no answer twice");
    expect(await titled("Lost twice")).toEqual([]);
  });
});

describe("list", () => {
  it("follows every page, as text and as JSON", async () => {
    for (let i = 0; i < 5; i++)
      await publishJson(["publish", await tree({ "index.html": `${i}` }), "--title", `L${i}`]);
    const direct = await server.fetch(`${API}/v1/artifacts?limit=100`, {
      headers: { Authorization: `Bearer ${env.ARTIFACTS_TOKEN}` },
    });
    const { artifacts: all }: Listing = JSON.parse(await direct.text());
    const ids = all.map((artifact) => artifact.id);
    expect(ids.length).toBeGreaterThanOrEqual(5);

    const asJson = await run(["list", "--json"], { pageSize: 2 });
    expect(asJson).toMatchObject({ status: 0 });
    const listed: Listing = JSON.parse(asJson.stdout);
    expect(listed.next_cursor).toBeNull();
    expect(listed.artifacts.map((artifact) => artifact.id)).toEqual(ids);
    expect(asJson.sent).toHaveLength(Math.ceil(ids.length / 2));

    const asText = await run(["list"], { pageSize: 2 });
    expect(
      asText.stdout
        .trimEnd()
        .split("\n")
        .map((line) => line.split("  ")[0]),
    ).toEqual(ids);
  });
});

describe("get, public, archive and delete", () => {
  it("reads, shares, archives and deletes an artifact", async () => {
    const root = await tree({ "index.html": "<p>v1</p>" });
    const { artifact } = await publishJson(["publish", root, "--title", "Lifecycle"]);
    const id = artifact.id;
    await writeTree(root, { "index.html": "<p>v2</p>" });
    expect((await run(["publish", root, "--id", id])).status).toBe(0);

    const latest = JSON.parse((await run(["get", id, "--json"])).stdout);
    expect([latest.artifact.latest_version, latest.version.number]).toEqual([2, 2]);
    const first = JSON.parse((await run(["get", id, "--version", "1", "--json"])).stdout);
    expect(first.version.number).toBe(1);
    expect((await run(["get", id])).stdout).toContain(`${id}  Lifecycle\n`);

    const shared = JSON.parse((await run(["public", id, "on", "--json"])).stdout);
    expect(shared.artifact.public_url).toBe(publicHost(id, "/"));
    expect((await served(publicHost(id, "/_v/1/"))).text).toBe("<p>v1</p>");
    expect((await run(["public", id, "off"])).status).toBe(0);
    expect((await served(publicHost(id, "/"))).status).toBe(404);

    expect(JSON.parse((await run(["archive", id, "on", "--json"])).stdout).artifact).toMatchObject({
      archived: true,
      archive: "archived",
    });
    const excluded = JSON.parse((await run(["list", "--json"])).stdout).artifacts.map((a: { id: string }) => a.id);
    const only = JSON.parse((await run(["list", "--archived", "only", "--json"])).stdout).artifacts;
    expect([excluded.includes(id), only.map((a: { id: string }) => a.id)]).toEqual([false, [id]]);
    expect(JSON.parse((await run(["archive", id, "off", "--json"])).stdout).artifact.archive).toBe("kept");
    expect(JSON.parse((await run(["archive", id, "auto", "--json"])).stdout).artifact.archive).toBeNull();
    expect((await served(content(id, "/"))).text).toBe("<p>v2</p>");

    expect(await run(["delete", id, "--json"])).toMatchObject({ status: 0, stdout: `{\n  "deleted": "${id}"\n}\n` });
    expect((await served(content(id, "/"))).status).toBe(404);
    const gone = await run(["get", id]);
    expect([gone.status, gone.stderr]).toEqual([
      1,
      "artifacts: not_found: no live artifact, version or file matches\n",
    ]);
  });
});

describe("pull", () => {
  it("writes a version into a new directory that publishes back unchanged", async () => {
    const files: Tree = {
      "index.html": "<p>pulled</p>",
      "css/site.css": "a{}",
      "back\\slash#?.txt": "odd",
      "img/logo.png": PNG,
    };
    const root = await tree(files);
    const { artifact } = await publishJson(["publish", root, "--title", "Pull"]);
    const target = join(await tempDir(), "copy");
    const pulled = await run(["pull", artifact.id, target]);
    expect(pulled).toMatchObject({ status: 0 });
    for (const [path, body] of Object.entries(files)) {
      expect(new Uint8Array(await readFile(join(target, ...path.split("/"))))).toEqual(
        typeof body === "string" ? new TextEncoder().encode(body) : body,
      );
    }
    const back = await run(["publish", target, "--id", artifact.id]);
    expect(back.sent[1]?.meta).toEqual({ base_version: 1, files: [], remove: [] });

    await writeTree(root, { "index.html": "<p>changed</p>" });
    await publishJson(["publish", root, "--id", artifact.id]);
    const old = join(await tempDir(), "v1");
    expect((await run(["pull", artifact.id, old, "--version", "1"])).status).toBe(0);
    expect(await readFile(join(old, "index.html"), "utf8")).toBe("<p>pulled</p>");

    const busy = await run(["pull", artifact.id, target]);
    expect(busy.status).toBe(1);
    expect(busy.stderr).toContain("is not empty; pull into a new directory");
  });
});
