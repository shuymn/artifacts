// The viewer frame on private content hosts (design.md section 6, "The viewer frame"): which request gets the frame
// page (PL-52), its validator and `Vary` (PL-53, SRV-3), and its markup, links and headers (PL-54, ISO-2 to ISO-5,
// SRV-1). The script's behavior in browsers is PL-55, in browser/viewer.spec.ts.
import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.ts";
import { encodeBase64 } from "./encoding.ts";
import favicon from "./gallery/favicon.ico";
import { byClass, elements, parseHtml, textOf, type HtmlNode } from "./gallery/test-html.ts";
import { isArtifactId, newArtifactId } from "./id.ts";
import { lookupForViewer, type OperationDeps } from "./operations.ts";
import { resolveRequestPath } from "./paths.ts";
import { BucketProbe, World, type FileSpec } from "./test-support.ts";

const DOCUMENT = { "Sec-Fetch-Dest": "document" };
const FRAMED_VARY = "Sec-Fetch-Dest, Accept-Encoding";
const APP = "https://artifacts.example.com";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-cache",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** An artifact with `versions` versions, each `index.html` naming its number, and other files in every version. */
async function artifact(
  world: World,
  options: { versions?: number; title?: string; files?: Record<string, FileSpec> } = {},
): Promise<string> {
  const created = await world.created({
    title: options.title ?? "Chart",
    files: { "index.html": "<title>v1</title>", ...options.files },
  });
  const id = created.artifact.id;
  for (let number = 2; number <= (options.versions ?? 1); number++) {
    world.clock.now += 3_600_000;
    await world.updated(id, { base_version: number - 1, files: { "index.html": `<title>v${number}</title>` } });
  }
  return id;
}

/** Whether a response is the frame page rather than a file: the Worker's page with its policy. */
async function isFrame(response: Response): Promise<boolean> {
  const body = await response.clone().text();
  return response.headers.has("Content-Security-Policy") && body.includes('<body class="viewer"');
}

async function page(response: Response): Promise<HtmlNode> {
  expect(response.status).toBe(200);
  return parseHtml(await response.text());
}

const one = (nodes: HtmlNode[]): HtmlNode => {
  expect(nodes).toHaveLength(1);
  const [node] = nodes;
  if (node === undefined) throw new Error("no node");
  return node;
};
const attr = (node: HtmlNode, name: string) => node.attributes.get(name);
const byTag = (root: HtmlNode, tag: string) => elements(root).filter((node) => node.tag === tag);

/** The history's versions as listed: each link's text and whether it is marked. */
function historyOf(root: HtmlNode): { text: string; href: string | undefined; current: boolean }[] {
  const history = one(byClass(root, "viewer-history"));
  const list = one(byTag(history, "ul"));
  return byTag(list, "a").map((link) => ({
    text: textOf(link),
    href: attr(link, "href"),
    current: attr(link, "aria-current") === "page",
  }));
}

describe("PL-52: which request gets the frame page", () => {
  it.each([
    ["document", true],
    ["iframe", false],
    ["embed", false],
    ["object", false],
    ["empty", false],
    [null, false],
  ])("Sec-Fetch-Dest %j gets the frame: %j", async (destination, framed) => {
    const world = new World();
    const id = await artifact(world);
    const headers: Record<string, string> = destination === null ? {} : { "Sec-Fetch-Dest": destination };
    const response = await world.content(id, "/", { headers });
    expect(response.status).toBe(200);
    expect(await isFrame(response)).toBe(framed);
    const body = await response.text();
    expect(body.includes('<body class="viewer"')).toBe(framed);
    expect(body === "<title>v1</title>").toBe(!framed);
  });

  it.each([
    ["?_viewer=off", false],
    ["?a=1&_viewer=off", false],
    ["?_viewer=off&a=1", false],
    ["?_viewer=on", true],
    ["?_viewer=", true],
    ["?_viewer=OFF", true],
    ["?a=1", true],
  ])("the query %s gets the frame: %j", async (query, framed) => {
    const world = new World();
    const id = await artifact(world);
    const response = await world.content(id, `/${query}`, { headers: DOCUMENT });
    expect(response.status).toBe(200);
    expect(await isFrame(response)).toBe(framed);
    // Either way, the file is the same: the query never selects one.
    const file = await world.content(id, `/${query}`, { headers: { "Sec-Fetch-Dest": "iframe" } });
    expect(await file.text()).toBe("<title>v1</title>");
  });

  it.each([
    ["page.html", undefined, true],
    ["page.xhtml", "application/xhtml+xml; charset=utf-8", true],
    ["page.htm", "TEXT/HTML;charset=utf-8", true],
    ["page.txt", "text/plain; charset=utf-8", false],
    ["page.svg", "image/svg+xml", false],
  ])("a document request for %s (%s) gets the frame: %j", async (path, type, framed) => {
    const world = new World();
    const body = "<p>page</p>";
    const id = await artifact(world, { files: { [path]: type === undefined ? body : { body, type } } });
    const response = await world.content(id, `/${path}`, { headers: DOCUMENT });
    expect(response.status).toBe(200);
    expect(await isFrame(response)).toBe(framed);
    // SRV-1: the frame page is the Worker's own HTML whatever the file's type; the file keeps its stored type.
    expect(response.headers.get("Content-Type")).toBe(framed ? "text/html; charset=utf-8" : type);
    const file = await world.content(id, `/${path}`, { headers: { "Sec-Fetch-Dest": "iframe" } });
    expect(file.headers.get("Content-Type")).toBe(type ?? "text/html; charset=utf-8");
    expect(await file.text()).toBe(body);
  });

  it("frames the latest and a pinned version, each naming its own", async () => {
    const world = new World();
    const id = await artifact(world, { versions: 2 });
    const latest = await page(await world.content(id, "/", { headers: DOCUMENT }));
    const pinned = await page(await world.content(id, "/_v/1/", { headers: DOCUMENT }));
    expect(textOf(one(byClass(latest, "viewer-header__version")))).toBe("v2 · latest");
    expect(textOf(one(byClass(pinned, "viewer-header__version")))).toBe("v1 of 2");
    const file = await world.content(id, "/_v/1/", { headers: { "Sec-Fetch-Dest": "iframe" } });
    expect(await file.text()).toBe("<title>v1</title>");
  });

  it("answers a directory, a missing file and the icon fallback as without the frame", async () => {
    const world = new World();
    const id = await artifact(world, { files: { "docs/index.html": "<p>docs</p>" } });
    const directory = await world.content(id, "/docs", { headers: DOCUMENT });
    expect(directory.status).toBe(308);
    expect(directory.headers.get("Location")).toBe("/docs/");
    expect(directory.headers.has("Content-Security-Policy")).toBe(false);
    const missing = await world.content(id, "/nothing.html", { headers: DOCUMENT });
    expect(missing.status).toBe(404);
    expect(missing.headers.has("Content-Security-Policy")).toBe(false);
    const icon = await world.content(id, "/favicon.ico", { headers: DOCUMENT });
    expect(icon.status).toBe(200);
    expect(icon.headers.get("Content-Type")).toBe("image/vnd.microsoft.icon");
    expect(new Uint8Array(await icon.arrayBuffer())).toEqual(new Uint8Array(favicon));
  });

  it("never frames the public host", async () => {
    const world = new World();
    const id = await artifact(world, { versions: 2 });
    expect((await world.patch(id, { public: true })).status).toBe(200);
    for (const path of ["/", "/_v/1/", "/index.html"]) {
      const response = await world.public(id, path, { headers: DOCUMENT });
      expect(response.status).toBe(200);
      expect(response.headers.has("Content-Security-Policy")).toBe(false);
      expect(response.headers.get("Vary")).toBe("Accept-Encoding");
      expect(await response.text()).toMatch(/^<title>v[12]<\/title>$/);
    }
  });

  // PUB-1: under publicOnly the frame's lookup, like lookupServedFile, finds nothing of a private artifact. Serving
  // calls it on private hosts only, so the test calls it directly.
  it("hides a private artifact's file and icon fallback from the frame's lookup under publicOnly", async () => {
    const world = new World();
    const id = await artifact(world);
    if (!isArtifactId(id)) throw new Error("not an artifact ID");
    const parsed = parseConfig(world.env);
    if (!parsed.ok) throw new Error("test configuration");
    const deps: OperationDeps = {
      db: world.env.DB,
      bucket: world.env.FILES,
      config: parsed.config,
      now: () => world.clock.now,
      newId: newArtifactId,
      sleep: async () => {},
      timeouts: { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 2_000 },
    };
    const find = async (pathname: string, fallback: boolean) => {
      const path = resolveRequestPath(pathname);
      if (path === undefined) throw new Error(`unresolved: ${pathname}`);
      const result = await lookupForViewer(deps, { id, path, publicOnly: true }, fallback);
      return result.ok ? result.value.lookup.kind : result.error.code;
    };
    expect([await find("/index.html", false), await find("/favicon.ico", true)]).toEqual(["not_found", "not_found"]);
    expect((await world.patch(id, { public: true })).status).toBe(200);
    expect([await find("/index.html", false), await find("/favicon.ico", true)]).toEqual(["file", "absent"]);
  });

  it("leaves REST's file route unchanged", async () => {
    const world = new World();
    const id = await artifact(world);
    const response = await world.api("GET", `/v1/artifacts/${id}/versions/1/files/index.html`, { headers: DOCUMENT });
    expect(response.status).toBe(200);
    expect(response.headers.has("Content-Security-Policy")).toBe(false);
    expect(await response.text()).toBe("<title>v1</title>");
  });
});

const vary = async (response: Promise<Response>) => (await response).headers.get("Vary");

describe("PL-53, SRV-3: validators and Vary of HTML on a private host", () => {
  it("matches the frame's ETag only for a document and the file's only for another destination", async () => {
    const world = new World();
    const id = await artifact(world);
    const frame = await world.content(id, "/", { headers: DOCUMENT });
    const file = await world.content(id, "/", { headers: { "Sec-Fetch-Dest": "iframe" } });
    const frameTag = frame.headers.get("ETag") ?? "";
    const fileTag = file.headers.get("ETag") ?? "";
    expect(frameTag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(frameTag).not.toBe(fileTag);

    const frame304 = await world.content(id, "/", { headers: { ...DOCUMENT, "If-None-Match": frameTag } });
    expect(frame304.status).toBe(304);
    // The 304 has the 200's headers but the body's own.
    const { "content-length": _, "content-type": __, ...frameHeaders } = Object.fromEntries(frame.headers);
    expect(Object.fromEntries(frame304.headers)).toEqual(frameHeaders);
    expect(frameHeaders).toEqual({
      ...PRIVATE_HEADERS,
      "content-security-policy": expect.stringMatching(/^script-src 'sha256-[A-Za-z0-9+/]{43}='$/),
      etag: frameTag,
      vary: FRAMED_VARY,
    });
    const fileGetsFrameTag = await world.content(id, "/", {
      headers: { "Sec-Fetch-Dest": "iframe", "If-None-Match": frameTag },
    });
    expect(fileGetsFrameTag.status).toBe(200);
    expect(await fileGetsFrameTag.text()).toBe("<title>v1</title>");

    const file304 = await world.content(id, "/", { headers: { "Sec-Fetch-Dest": "iframe", "If-None-Match": fileTag } });
    expect(file304.status).toBe(304);
    expect(Object.fromEntries(file304.headers)).toEqual({ ...PRIVATE_HEADERS, etag: fileTag, vary: FRAMED_VARY });
    const frameGetsFileTag = await world.content(id, "/", { headers: { ...DOCUMENT, "If-None-Match": fileTag } });
    expect(frameGetsFileTag.status).toBe(200);
    expect(await isFrame(frameGetsFileTag)).toBe(true);
  });

  it("varies on Sec-Fetch-Dest for HTML on a private host only", async () => {
    const world = new World();
    const id = await artifact(world, { files: { "notes.txt": "notes" } });
    expect(await vary(world.content(id, "/?_viewer=off", { headers: DOCUMENT }))).toBe(FRAMED_VARY);
    expect(await vary(world.content(id, "/"))).toBe(FRAMED_VARY);
    expect(await vary(world.content(id, "/notes.txt", { headers: DOCUMENT }))).toBe("Accept-Encoding");
    expect((await world.patch(id, { public: true })).status).toBe(200);
    expect(await vary(world.public(id, "/", { headers: DOCUMENT }))).toBe("Accept-Encoding");
  });

  it.each([
    [
      "a publish",
      async (world: World, id: string) => {
        await world.updated(id, { base_version: 1, files: { "other.html": "o" } });
      },
    ],
    [
      "a visibility change",
      async (world: World, id: string) => {
        expect((await world.patch(id, { public: true })).status).toBe(200);
      },
    ],
    [
      "a new title",
      async (world: World, id: string) => {
        await world.updated(id, { base_version: 1, title: "Renamed" });
      },
    ],
  ])("changes the frame's ETag after %s", async (_change, change) => {
    const world = new World();
    const id = await artifact(world);
    const before = (await world.content(id, "/", { headers: DOCUMENT })).headers.get("ETag") ?? "";
    expect((await world.content(id, "/", { headers: { ...DOCUMENT, "If-None-Match": before } })).status).toBe(304);
    await change(world, id);
    const after = await world.content(id, "/", { headers: { ...DOCUMENT, "If-None-Match": before } });
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(before);
  });

  it("answers 404 after a delete and 403 without a JWT, never 304", async () => {
    const world = new World();
    const id = await artifact(world);
    const tag = (await world.content(id, "/", { headers: DOCUMENT })).headers.get("ETag") ?? "";
    const refused = await world.content(id, "/", { jwt: null, headers: { ...DOCUMENT, "If-None-Match": tag } });
    expect(refused.status).toBe(403);
    expect(refused.headers.has("ETag")).toBe(false);
    expect((await world.api("DELETE", `/v1/artifacts/${id}`)).status).toBe(204);
    const deleted = await world.content(id, "/", { headers: { ...DOCUMENT, "If-None-Match": tag } });
    expect(deleted.status).toBe(404);
    expect(deleted.headers.has("ETag")).toBe(false);
    expect(deleted.headers.has("Vary")).toBe(false);
  });

  it.each([
    ["the frame page", DOCUMENT],
    ["the file", { "Sec-Fetch-Dest": "iframe" }],
  ])("answers HEAD with GET's headers for %s", async (_name, headers) => {
    const world = new World();
    const id = await artifact(world);
    const get = await world.content(id, "/", { headers });
    const head = await world.content(id, "/", { headers, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(get.headers));
    expect(await head.text()).toBe("");
  });

  it("reads no object for the frame page", async () => {
    const world = new World();
    const id = await artifact(world);
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    expect((await world.content(id, "/", { headers: DOCUMENT })).status).toBe(200);
    expect((await world.content(id, "/", { headers: DOCUMENT, method: "HEAD" })).status).toBe(200);
    expect(bucket.count("get")).toBe(0);
    expect((await world.content(id, "/", { headers: { "Sec-Fetch-Dest": "iframe" } })).status).toBe(200);
    expect(bucket.count("get")).toBe(1);
  });
});

describe("PL-54: the frame page", () => {
  it("escapes markup in the title and the query", async () => {
    const world = new World();
    const title = `<script>alert(1)</script>"'&`;
    const id = await artifact(world, { title });
    const response = await world.content(id, `/?q=%22%3E%3Cscript%3E`, { headers: DOCUMENT });
    const body = await response.clone().text();
    expect(body).not.toContain("<script>alert");
    expect(body).not.toContain('"><script>');
    const root = await page(response);
    expect(textOf(one(byTag(root, "title")))).toBe(title);
    expect(textOf(one(byClass(root, "viewer-header__title")))).toBe(title);
    // The parser reads a <noscript> as text, as a browser that runs scripts does.
    expect(textOf(one(byTag(root, "noscript")))).toBe(
      '<a class="viewer-header__direct" href="/?q=%22%3E%3Cscript%3E&_viewer=off">Open page directly</a>',
    );
    expect(byTag(root, "script")).toHaveLength(1);
  });

  it.each([
    [3, 3],
    [3, 1],
    [10, 10],
    [10, 1],
    [11, 2],
    [12, 12],
    [12, 3],
    [12, 2],
    [12, 1],
  ])("lists the newest of %i versions, then v%i when shown and older", async (count, shown) => {
    const world = new World();
    const id = await artifact(world, { versions: count });
    const root = await page(await world.content(id, shown === count ? "/" : `/_v/${shown}/`, { headers: DOCUMENT }));
    const newest = Array.from({ length: Math.min(count, 10) }, (_, index) => count - index);
    const numbers = newest.includes(shown) ? newest : [...newest, shown];
    const history = historyOf(root);
    expect(history.map((entry) => Number(/^v(\d+)/.exec(entry.text)?.[1]))).toEqual(numbers);
    expect(history.map((entry) => entry.href)).toEqual(numbers.map((n) => (n === count ? "/" : `/_v/${n}/`)));
    expect(history.map((entry) => entry.current)).toEqual(numbers.map((n) => n === shown));
    expect(textOf(one(byClass(root, "viewer-history__head")))).toBe(`History · ${count} versions`);
  });

  it("writes each version's number, `latest` and its date alone in the history", async () => {
    const world = new World();
    const id = await artifact(world, { versions: 2 });
    const response = await world.content(id, "/", { headers: DOCUMENT });
    // Two spaces after the number: a no-break space and a space.
    expect(await response.clone().text()).toMatch(/>v2&#160; latest · <time/);
    const root = await page(response);
    expect(historyOf(root).map((entry) => entry.text)).toEqual(["v2 latest · 2026-11-16", "v1 2026-11-16"]);
    const times = byTag(one(byClass(root, "viewer-history")), "time").map((time) => attr(time, "datetime"));
    expect(times).toEqual(["2026-11-16T10:00:00Z", "2026-11-16T09:00:00Z"]);
  });

  it("shows the latest and a pinned version in the header and the menu", async () => {
    const world = new World();
    const id = await artifact(world, { versions: 2 });
    const latest = await page(await world.content(id, "/", { headers: DOCUMENT }));
    expect(textOf(one(byClass(latest, "viewer-menu__shown")))).toBe("v2 · updated 2026-11-16 10:00");
    expect(attr(one(byTag(one(byClass(latest, "viewer-menu__shown")), "time")), "datetime")).toBe(
      "2026-11-16T10:00:00Z",
    );
    const pinned = await page(await world.content(id, "/_v/1/", { headers: DOCUMENT }));
    expect(textOf(one(byClass(pinned, "viewer-header__version")))).toBe("v1 of 2");
    expect(textOf(one(byClass(pinned, "viewer-menu__shown")))).toBe("v1 · published 2026-11-16 09:00");
    const exported = elements(pinned).find((node) => attr(node, "id") === "viewer-export");
    expect(exported === undefined ? "" : textOf(exported)).toBe("Export v1 (.zip)");
    expect(exported === undefined ? undefined : attr(exported, "href")).toBe(`${APP}/a/${id}/v/1/export`);
  });

  it("links the app host from the configuration", async () => {
    const world = new World({ vars: { APP_HOST: "gallery.example.net" } });
    const id = await artifact(world);
    const root = await page(await world.content(id, "/", { headers: DOCUMENT }));
    const app = "https://gallery.example.net";
    const links = byTag(root, "a").map((link) => [textOf(link), attr(link, "href"), attr(link, "target") ?? null]);
    expect(links).toEqual([
      ["", `${app}/`, null],
      ["Back to gallery", `${app}/`, null],
      ["Artifact details", `${app}/a/${id}`, null],
      ["Export v1 (.zip)", `${app}/a/${id}/v/1/export`, null],
      ["Make public…", `${app}/a/${id}/public`, "_blank"],
      ["Open page directly", "/?_viewer=off", null],
      ["Delete…", `${app}/a/${id}/delete`, "_blank"],
      ["v1 latest · 2026-11-16", "/", null],
      ["All versions in gallery", `${app}/a/${id}#versions`, null],
    ]);
    expect(attr(one(byClass(root, "viewer-header__home")), "aria-label")).toBe("artifacts");
  });

  it("offers Make private… for a public artifact", async () => {
    const world = new World();
    const id = await artifact(world);
    expect((await world.patch(id, { public: true })).status).toBe(200);
    const root = await page(await world.content(id, "/", { headers: DOCUMENT }));
    const item = byTag(root, "a").find((link) => attr(link, "href") === `${APP}/a/${id}/public`);
    expect(item === undefined ? "" : textOf(item)).toBe("Make private…");
  });

  it("has an iframe without src or sandbox, with allow, and no form", async () => {
    const world = new World();
    const id = await artifact(world);
    const root = await page(await world.content(id, "/", { headers: DOCUMENT }));
    const frame = one(byTag(root, "iframe"));
    expect(Object.fromEntries(frame.attributes)).toEqual({
      class: "viewer__frame",
      id: "viewer-frame",
      title: "Artifact page",
      allow:
        "fullscreen; clipboard-read; clipboard-write; camera; microphone; geolocation; display-capture; autoplay; screen-wake-lock; web-share",
    });
    expect(byTag(root, "form")).toEqual([]);
  });

  it("names its script's SHA-256 in its policy, the same script on every page", async () => {
    const world = new World();
    const first = await artifact(world, { title: "One" });
    const second = await artifact(world, { title: "Two", versions: 3 });
    const scripts: string[] = [];
    const policies: string[] = [];
    for (const [id, path] of [
      [first, "/"],
      [second, "/_v/2/"],
    ] as const) {
      const response = await world.content(id, path, { headers: DOCUMENT });
      policies.push(response.headers.get("Content-Security-Policy") ?? "");
      const script = one(byTag(await page(response), "script"));
      scripts.push(script.children.map((child) => child.text).join(""));
    }
    expect(scripts[1]).toBe(scripts[0]);
    expect(policies[1]).toBe(policies[0]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scripts[0]));
    expect(policies[0]).toBe(`script-src 'sha256-${encodeBase64(new Uint8Array(digest))}'`);
  });

  it("carries the private host's headers and sets no cookie (ISO-2, ISO-4, SRV-1)", async () => {
    const world = new World();
    const id = await artifact(world, { files: { "page.xhtml": { body: "<p/>", type: "application/xhtml+xml" } } });
    const response = await world.content(id, "/page.xhtml", { headers: DOCUMENT });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      ...PRIVATE_HEADERS,
      "content-length": expect.stringMatching(/^\d+$/),
      "content-security-policy": expect.stringMatching(/^script-src 'sha256-[A-Za-z0-9+/]{43}='$/),
      "content-type": "text/html; charset=utf-8",
      etag: expect.stringMatching(/^"[0-9a-f]{32}"$/),
      vary: FRAMED_VARY,
    });
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });
});
