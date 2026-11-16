// The gallery on the app host (design.md section 10; docs/gallery/design.md): its pages, their data, paging, the
// headers of every response and the escaping of artifact text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessVerifier, type AccessOutcome } from "../access.ts";
import { newArtifactId } from "../id.ts";
import { createWorker } from "../index.ts";
import {
  APP_AUD,
  APP_HOST,
  BucketProbe,
  captureLogs,
  clearStorage,
  CONTENT_SUFFIX,
  DatabaseProbe,
  DAY_MS,
  never,
  PUBLIC_SUFFIX,
  START,
  TOKENS,
  World,
} from "../test-support.ts";
import { assetPath, assetTag, fingerprintAssets, GALLERY_ASSETS, type AssetSources } from "./assets.ts";
import iconSvg from "./icon.svg?raw";
import { serveGalleryAsset } from "./route.ts";
import { byClass, elements, parseHtml, textOf, type HtmlNode } from "./test-html.ts";

import css from "./gallery.css?raw";

// The lists show every live artifact, and storage is shared by the tests of a file.
beforeEach(async () => {
  await clearStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const HOUR_MS = 3_600_000;

/** An Access verifier that throws, so the request reaches the Worker's outer error handler. */
class ThrowingVerifier extends AccessVerifier {
  override verify(): Promise<AccessOutcome> {
    return Promise.reject(new Error("verifier failed"));
  }
}
const UNKNOWN_ID = "abcdefghijklmnopqrstuvwxyz";

/** A request to the app host with a valid app JWT unless `jwt` is null. */
async function app(
  world: World,
  path: string,
  options: { jwt?: null; method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.jwt !== null) headers.set("Cf-Access-Jwt-Assertion", await world.jwt({ aud: APP_AUD }));
  return world.fetch(`https://${APP_HOST}${path}`, { method: options.method ?? "GET", headers });
}

/** A page's parsed document; fails the test unless the page answered 200. */
async function page(world: World, path: string): Promise<HtmlNode> {
  const response = await app(world, path);
  expect({ path, status: response.status }).toEqual({ path, status: 200 });
  return parseHtml(await response.text());
}

const titlesOf = (doc: HtmlNode) => byClass(doc, "artifact-row__title").map(textOf);
const one = (nodes: HtmlNode[]): HtmlNode => {
  expect(nodes).toHaveLength(1);
  return nodes[0] ?? { tag: "", attributes: new Map(), children: [], text: "" };
};
/** The path and query the page's pager links to from `current`, if it has a pager. */
function nextPage(doc: HtmlNode, current: string): string | undefined {
  const pager = byClass(doc, "pager")[0];
  const href =
    pager === undefined
      ? undefined
      : elements(pager)
          .find((node) => node.tag === "a")
          ?.attributes.get("href");
  if (href === undefined) return undefined;
  const url = new URL(href, `https://${APP_HOST}${current}`);
  return url.pathname + url.search;
}

/** The info card's rows, label to text. */
const infoOf = (doc: HtmlNode) =>
  Object.fromEntries(
    byClass(doc, "info-row").map((row) => {
      const [label, value] = row.children.filter((child) => child.tag !== "#text");
      return [label === undefined ? "" : textOf(label), value === undefined ? "" : textOf(value)];
    }),
  );

/** A table's body rows, each as its cells' texts. */
const tableOf = (doc: HtmlNode, id: string) => {
  const region = elements(doc).find((node) => node.attributes.get("aria-labelledby") === id);
  const body = elements(region ?? one([])).find((node) => node.tag === "tbody");
  return elements(body ?? one([]))
    .filter((node) => node.tag === "tr")
    .map((row) =>
      elements(row)
        .filter((cell) => cell.tag === "td")
        .map(textOf),
    );
};

const navOf = (doc: HtmlNode) =>
  byClass(doc, "nav-tab").map((tab) => ({ text: textOf(tab), current: tab.attributes.get("aria-current") ?? null }));

async function create(world: World, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await world.created({ title, files: { "index.html": `<p>${title}</p>` }, ...extra });
  return created.artifact.id;
}

describe("section 10: the pages", () => {
  it("lists active artifacts on / and archived ones on /archived, in the API's order, with why each is archived", async () => {
    const world = new World();
    world.clock.now = START - 50 * DAY_MS;
    const kept = await create(world, "Kept old");
    expect((await world.patch(kept, { archive: "kept" })).status).toBe(200);
    world.clock.now = START - 40 * DAY_MS;
    await create(world, "Aged out");
    world.clock.now = START + HOUR_MS;
    await create(world, "Recent");
    world.clock.now = START + 2 * HOUR_MS;
    const byHand = await create(world, "By hand");
    expect((await world.patch(byHand, { archive: "archived" })).status).toBe(200);
    world.clock.now = START + 3 * HOUR_MS;
    const shared = await create(world, "Shared", { description: "Line one\nline two" });
    expect((await world.patch(shared, { public: true })).status).toBe(200);

    const active = await page(world, "/");
    expect(titlesOf(active)).toEqual(["Shared", "Recent", "Kept old"]);
    const api = await (await world.api("GET", "/v1/artifacts")).json<{ artifacts: { title: string }[] }>();
    expect(api.artifacts.map((artifact) => artifact.title)).toEqual(titlesOf(active));
    expect(navOf(active)).toEqual([
      { text: "Active 3", current: "page" },
      { text: "Archived 2", current: null },
    ]);
    const rows = byClass(active, "artifact-row");
    expect(rows.map((row) => byClass(row, "badge").map(textOf))).toEqual([["Public"], [], []]);
    expect(byClass(rows[0] ?? one([]), "artifact-row__description").map(textOf)).toEqual(["Line one line two"]);
    expect(byClass(rows[1] ?? one([]), "artifact-row__description")).toEqual([]);
    expect(byClass(active, "artifact-row__meta").map(textOf)).toEqual([
      "v1 · updated just now by codex",
      "v1 · updated 2 hours ago by codex",
      "v1 · updated 50 days ago by codex",
    ]);
    const open = byClass(active, "artifact-row__open").map((link) => link.attributes.get("href"));
    expect(open[0]).toBe(`https://${shared}${CONTENT_SUFFIX}/`);
    expect(byClass(active, "artifact-row__title")[0]?.attributes.get("href")).toBe(`/a/${shared}`);
    expect(byClass(active, "pager")).toEqual([]);

    const archived = await page(world, "/archived");
    expect(titlesOf(archived)).toEqual(["By hand", "Aged out"]);
    expect(navOf(archived)).toEqual([
      { text: "Active 3", current: null },
      { text: "Archived 2", current: "page" },
    ]);
    expect(byClass(archived, "artifact-row__meta").map(textOf)).toEqual([
      "v1 · updated 1 hour ago by codex · archived by hand",
      "v1 · updated 40 days ago by codex · archived: no updates for 30 days",
    ]);
    expect(byClass(archived, "artifact-row").map((row) => byClass(row, "badge").map(textOf))).toEqual([
      ["Archived"],
      ["Archived"],
    ]);
  });

  it("shows an artifact: text, URLs, public and archive state, the version history and the latest files", async () => {
    const world = new World();
    const created = await world.created({
      title: "First title",
      description: "Line one\nline two",
      files: { "index.html": "<p>v1</p>", "style.css": "body{}" },
    });
    const id = created.artifact.id;
    world.clock.now = START + HOUR_MS + 30_000;
    const update = await world.update(
      id,
      {
        base_version: 1,
        title: "Second title",
        files: { "data/x.json": { body: "{}".repeat(600), type: "application/json" } },
      },
      TOKENS.claude,
    );
    expect(update.status).toBe(201);
    world.clock.now = START + 3 * HOUR_MS;

    const doc = await page(world, `/a/${id}`);
    expect(textOf(one(elements(doc).filter((node) => node.tag === "title")))).toBe("Second title · artifacts");
    expect(textOf(one(elements(doc).filter((node) => node.tag === "h1")))).toBe("Second title");
    const description = one(byClass(doc, "artifact-heading__description"));
    expect(description.children.map((child) => (child.tag === "#text" ? child.text : `<${child.tag}>`))).toEqual([
      "Line one",
      "<br>",
      "line two",
    ]);
    expect(infoOf(doc)).toEqual({
      "Artifact URL": `https://${id}${CONTENT_SUFFIX}/ ↗`,
      "Public URL": "Not public",
      Latest: "v2 · 2026-11-16 10:00 by claude",
      Created: "2026-11-16 09:00 by codex",
      Archive: "Active · archives automatically after 30 days without updates",
    });
    expect(textOf(one(elements(doc).filter((node) => node.attributes.get("id") === "versions")))).toBe("Versions 2");
    expect(tableOf(doc, "versions")).toEqual([
      ["v2", "2026-11-16 10:00", "claude", "Second title", "3", "1.2 KB", "View ↗"],
      ["v1", "2026-11-16 09:00", "codex", "First title", "2", "15 B", "View ↗"],
    ]);
    const pinned = elements(doc).filter((node) => node.tag === "a" && textOf(node) === "View ↗");
    expect(pinned.map((link) => link.attributes.get("href"))).toEqual([
      `https://${id}${CONTENT_SUFFIX}/_v/2/`,
      `https://${id}${CONTENT_SUFFIX}/_v/1/`,
    ]);
    const time = elements(doc).find((node) => node.tag === "time");
    expect(time?.attributes.get("datetime")).toBe("2026-11-16T10:00:00Z");
    expect(textOf(one(elements(doc).filter((node) => node.attributes.get("id") === "files")))).toBe("Files in v2 3");
    expect(tableOf(doc, "files")).toEqual([
      ["data/x.json", "application/json", "1.2 KB"],
      ["index.html", "text/html; charset=utf-8", "9 B"],
      ["style.css", "text/css; charset=utf-8", "6 B"],
    ]);
    expect(byClass(doc, "badge")).toEqual([]);

    expect((await world.patch(id, { public: true, archive: "kept" })).status).toBe(200);
    const shared = await page(world, `/a/${id}`);
    expect(infoOf(shared)).toMatchObject({
      "Public URL": `https://${id}${PUBLIC_SUFFIX}/ ↗`,
      Archive: "Active · kept out of the archive by hand",
    });
    expect(byClass(shared, "badge").map(textOf)).toEqual(["Public"]);
  });

  it("marks the artifact's section and links back to it", async () => {
    const world = new World();
    const byHand = await create(world, "By hand");
    await world.patch(byHand, { archive: "archived" });
    const aged = await create(world, "Aged");
    world.clock.now = START + 31 * DAY_MS;
    const fresh = await create(world, "Fresh");

    const states = [];
    for (const id of [byHand, aged, fresh]) {
      const doc = await page(world, `/a/${id}`);
      const back = one(byClass(doc, "back-link"));
      states.push({
        nav: navOf(doc).map((tab) => tab.current),
        back: [back.attributes.get("href"), textOf(back)],
        archive: infoOf(doc).Archive,
        badges: byClass(doc, "badge").map(textOf),
      });
    }
    expect(states).toEqual([
      { nav: [null, "true"], back: ["/archived", "← Archived"], archive: "Archived by hand", badges: ["Archived"] },
      {
        nav: [null, "true"],
        back: ["/archived", "← Archived"],
        archive: "Archived · no updates for 30 days",
        badges: ["Archived"],
      },
      {
        nav: ["true", null],
        back: ["/", "← Artifacts"],
        archive: "Active · archives automatically after 30 days without updates",
        badges: [],
      },
    ]);
  });

  it("shows the start of a long description in a row and the whole of it on the artifact page", async () => {
    const world = new World();
    const description = "あ".repeat(150) + "b".repeat(100);
    const id = await create(world, "Long", { description });
    const row = textOf(one(byClass(await page(world, "/"), "artifact-row__description")));
    expect(row).toBe(`${"あ".repeat(150)}${"b".repeat(50)}…`);
    expect(textOf(one(byClass(await page(world, `/a/${id}`), "artifact-heading__description")))).toBe(description);
  });

  it("says so when a list is empty", async () => {
    const world = new World();
    const doc = await page(world, "/");
    expect(byClass(doc, "artifact-list")).toEqual([]);
    expect(textOf(one(elements(doc).filter((node) => node.tag === "main")))).toContain("No artifacts.");
    expect(textOf(await page(world, "/archived"))).toContain("No archived artifacts.");
  });
});

// AC-5 in the local runtime: every artifact and version is reachable through the page links, 50 per page.
describe("section 10: paging", () => {
  it("lists 50 artifacts per page and reaches every one through the links", async () => {
    const world = new World();
    const ids: string[] = [];
    for (let index = 0; index < 52; index++) {
      world.clock.now = START + index * 1000;
      ids.push(await create(world, `Artifact ${index}`));
    }
    const seen: string[] = [];
    const pages: number[] = [];
    let url: string | undefined = "/";
    while (url !== undefined) {
      const doc = await page(world, url);
      const links = byClass(doc, "artifact-row__title").map((link) => link.attributes.get("href") ?? "");
      pages.push(links.length);
      seen.push(...links);
      expect(navOf(doc)[0]?.text).toBe("Active 52");
      url = nextPage(doc, url);
    }
    expect(pages).toEqual([50, 2]);
    expect(seen).toEqual(ids.toReversed().map((id) => `/a/${id}`));
  });

  it("shows the version history 50 per page and reaches every version through the links", async () => {
    const world = new World();
    const id = await create(world, "Many versions");
    for (let base = 1; base < 52; base++) {
      world.clock.now = START + base * 1000;
      await world.updated(id, { base_version: base, files: { "index.html": `<p>${base + 1}</p>` } });
    }
    const seen: string[] = [];
    const pages: number[] = [];
    const links: string[] = [];
    let url: string | undefined = `/a/${id}`;
    while (url !== undefined) {
      const doc = await page(world, url);
      const rows = tableOf(doc, "versions");
      pages.push(rows.length);
      seen.push(...rows.map((row) => row[0] ?? ""));
      expect(textOf(one(elements(doc).filter((node) => node.attributes.get("id") === "files")))).toBe("Files in v52 1");
      links.push(...byClass(doc, "pager").map((pager) => elements(pager)[0]?.attributes.get("href") ?? ""));
      url = nextPage(doc, url);
    }
    expect(pages).toEqual([50, 2]);
    // The link lands on the version history, below the artifact's details.
    expect(links).toEqual(["?versions_cursor=3#versions"]);
    expect(seen).toEqual(Array.from({ length: 52 }, (_, index) => `v${52 - index}`));
  });
});

// Each page shows its rows, the archive counts and (on an artifact) the latest files and version 1 from one D1 batch,
// a single snapshot, so an update between reads cannot mix two states on one page.
describe("section 10: one snapshot per page", () => {
  it("reads each page in one D1 batch and the assets without D1", async () => {
    const world = new World();
    const id = await create(world, "Page");
    for (let base = 1; base < 52; base++) await world.updated(id, { base_version: base });
    await world.patch(await create(world, "Old"), { archive: "archived" });
    const db = new DatabaseProbe();
    world.env = { ...world.env, DB: db.binding };
    const batches: Record<string, number> = {};
    for (const path of [
      "/",
      "/?cursor=1.aaaaaaaaaaaaaaaaaaaaaaaaaa",
      "/archived",
      `/a/${id}`,
      `/a/${id}?versions_cursor=3`,
      assetPath("gallery.css"),
    ]) {
      const before = db.batches;
      expect({ path, status: (await app(world, path)).status }).toEqual({ path, status: 200 });
      batches[path] = db.batches - before;
    }
    expect(Object.values(batches)).toEqual([1, 1, 1, 1, 1, 0]);
  });
});

describe("section 10: what answers 404", () => {
  it("answers 404 for a deleted or unknown artifact, a malformed cursor and any other path", async () => {
    const world = new World();
    const id = await create(world, "Live");
    const gone = await create(world, "Gone");
    expect((await world.api("DELETE", `/v1/artifacts/${gone}`)).status).toBe(204);
    expect(titlesOf(await page(world, "/"))).toEqual(["Live"]);

    for (const path of [
      `/a/${gone}`,
      `/a/${UNKNOWN_ID}`,
      `/a/${id.toUpperCase()}`,
      `/a/${id}/`,
      `/a/${id}/index.html`,
      "/a/",
      "/a",
      "/archived/",
      "/index.html",
      "/favicon.png",
      "/assets/favicon.ico",
      "/assets/",
      "/assets/fonts/other.woff2",
      // A path that names no current asset, under any fingerprint or none.
      "/assets/other.css",
      "/assets/other.0000000000000000.css",
      `${assetPath("gallery.css")}x`,
      assetPath("gallery.css").replace(/\.css$/, ".svg"),
      "/?cursor=",
      "/?cursor=bad",
      `/archived?cursor=1.${id}x`,
      `/a/${id}?versions_cursor=0`,
      `/a/${id}?versions_cursor=01`,
    ]) {
      const response = await app(world, path);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    }
  });
});

// PL-12, ISO-5: artifact text cannot break out of its element or attribute.
describe("ISO-5: escaping artifact text", () => {
  const TITLE = `"><script>alert(1)</script><img src=x onerror=alert(1)>'&amp;`;
  const DESCRIPTION = `</p><iframe src="https://evil.example.org"></iframe>' onmouseover='alert(1)\n<svg onload=alert(1)>`;
  const PATH = `"><script>x</script>' onfocus='x.html`;
  const TYPE = `text/plain; x="<b onmouseover=alert(1)>&amp;"`;
  const ALLOWED = new Set(
    "html head meta title link body header a nav span main hgroup h1 p ul li div dl dt dd br section h2 table thead tbody tr th td time".split(
      " ",
    ),
  );

  function expectInert(doc: HtmlNode) {
    const found = elements(doc);
    expect(found.map((node) => node.tag).filter((tag) => !ALLOWED.has(tag))).toEqual([]);
    expect(found.flatMap((node) => [...node.attributes.keys()]).filter((name) => name.startsWith("on"))).toEqual([]);
  }

  it("keeps titles, descriptions, paths and content types as text on every page", async () => {
    const world = new World();
    const created = await world.created({
      title: TITLE,
      description: DESCRIPTION,
      files: { "index.html": "x", [PATH]: { body: "y", type: TYPE } },
    });
    const id = created.artifact.id;

    const list = await page(world, "/");
    expectInert(list);
    expect(titlesOf(list)).toEqual([TITLE]);
    expect(byClass(list, "artifact-row__description").map(textOf)).toEqual([DESCRIPTION.replace(/\s+/g, " ")]);

    const detail = await page(world, `/a/${id}`);
    expectInert(detail);
    expect(textOf(one(elements(detail).filter((node) => node.tag === "title")))).toBe(`${TITLE} · artifacts`);
    expect(textOf(one(elements(detail).filter((node) => node.tag === "h1")))).toBe(TITLE);
    const description = one(byClass(detail, "artifact-heading__description"));
    expect(description.children.filter((child) => child.tag !== "#text").map((child) => child.tag)).toEqual(["br"]);
    expect(textOf(description)).toBe(DESCRIPTION.split("\n").join(""));
    expect(tableOf(detail, "files")).toEqual([
      [PATH, TYPE, "1 B"],
      ["index.html", "text/html; charset=utf-8", "1 B"],
    ]);
    expect(tableOf(detail, "versions")[0]?.[3]).toBe(TITLE);

    await world.patch(id, { archive: "archived" });
    const archived = await page(world, "/archived");
    expectInert(archived);
    expect(titlesOf(archived)).toEqual([TITLE]);
  });

  it("sends a CSP that forbids scripts, forms and framing on every response, refusals and failures included", async () => {
    const world = new World({ keyTimeoutMs: 50 });
    const id = await create(world, "Page");
    const etag = (await app(world, assetPath("gallery.css"))).headers.get("ETag") ?? "";
    const responses = [
      await app(world, "/"),
      await app(world, "/archived"),
      await app(world, `/a/${id}`),
      await app(world, assetPath("gallery.css")),
      await app(world, assetPath("gallery.css"), { headers: { "If-None-Match": etag } }),
      await app(world, "/", { method: "HEAD" }),
      await app(world, "/nothing"),
      await app(world, "/", { method: "POST" }),
      await app(world, "/", { jwt: null }),
    ];
    // The outer handler's 500: Access verification itself throws.
    const failing = createWorker({
      now: () => START,
      newId: newArtifactId,
      sleep: async () => {},
      timeouts: { r2Ms: 2_000, d1ReadMs: 2_000 },
      access: new ThrowingVerifier({ fetch: world.keys.fetch, now: () => START }),
    });
    captureLogs();
    responses.push(await failing.fetch(new Request(`https://${APP_HOST}/`), world.env));
    const unreachable = new World({ keyTimeoutMs: 50 });
    unreachable.keys.mode = "hang";
    responses.push(await app(unreachable, "/"));
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 304, 200, 404, 405, 403, 500, 503,
    ]);
    for (const response of responses) {
      const policy = response.headers.get("Content-Security-Policy") ?? "";
      const directives = policy.split(";").map((directive) => directive.trim());
      expect(directives).toEqual(
        expect.arrayContaining([
          "default-src 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
        ]),
      );
      expect(
        directives.filter((directive) => /^(script|frame|child|worker|connect|object)-src/.test(directive)),
      ).toEqual([]);
      // Images, the icon among them, load from the app host only.
      expect(directives.filter((directive) => directive.startsWith("img-src"))).toEqual(["img-src 'self'"]);
    }
  });
});

describe("section 10: headers", () => {
  // PL-10, ISO-2, ISO-4 on every gallery response; section 6's `private, no-cache` for the app host, and its immutable
  // cache for fingerprinted assets.
  it("sends the app host's headers and no cookie on pages and assets", async () => {
    const world = new World();
    const id = await create(world, "Page");
    const IMMUTABLE = "private, max-age=31536000, immutable";
    for (const [path, cache] of [
      ["/", "private, no-cache"],
      ["/archived", "private, no-cache"],
      [`/a/${id}`, "private, no-cache"],
      ["/favicon.ico", "private, no-cache"],
      [assetPath("gallery.css"), IMMUTABLE],
      [assetPath("fonts.css"), IMMUTABLE],
      [assetPath("icon.svg"), IMMUTABLE],
      [assetPath("fonts/ibm-plex-mono-latin-500-normal.woff2"), IMMUTABLE],
    ] as const) {
      const response = await app(world, path);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect({ path, cache: response.headers.get("Cache-Control") }).toEqual({ path, cache });
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.has("Set-Cookie")).toBe(false);
      expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
    }
    expect((await app(world, "/")).headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("answers HEAD with GET's headers and no body", async () => {
    const world = new World();
    const id = await create(world, "Page");
    for (const path of ["/", `/a/${id}`, assetPath("fonts/ibm-plex-sans-latin-400-normal.woff2"), "/favicon.ico"]) {
      const get = await app(world, path);
      const head = await app(world, path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect([...head.headers]).toEqual([...get.headers]);
      expect(Number(get.headers.get("Content-Length"))).toBe((await get.arrayBuffer()).byteLength);
      expect(await head.text()).toBe("");
    }
  });

  // ACC-1: Access comes before any page or asset, and before storage.
  it("refuses every gallery path without an app JWT, before storage", async () => {
    const world = new World();
    const db = new DatabaseProbe();
    const bucket = new BucketProbe();
    world.env = { ...world.env, DB: db.binding, FILES: bucket.binding };
    for (const path of [
      "/",
      "/archived",
      `/a/${UNKNOWN_ID}`,
      assetPath("gallery.css"),
      assetPath("fonts.css"),
      "/favicon.ico",
      assetPath("icon.svg"),
    ]) {
      expect((await app(world, path, { jwt: null })).status).toBe(403);
    }
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
  });

  // RES-2: the gallery's reads have the D1 read timeout.
  it("answers 503 when a read times out", async () => {
    const world = new World({ timeouts: { r2Ms: 2_000, d1ReadMs: 50 } });
    const id = await create(world, "Page");
    const db = new DatabaseProbe();
    db.behave = () => never();
    world.env = { ...world.env, DB: db.binding };
    for (const path of ["/", "/archived", `/a/${id}`]) {
      expect({ path, status: (await app(world, path)).status }).toEqual({ path, status: 503 });
    }
  });
});

/** A page's preload link for a font, by the font's file name without `ibm-plex-` and `-normal.woff2`. */
const preloadOf = (name: string) => ({
  rel: "preload",
  href: assetPath(`fonts/ibm-plex-${name}-normal.woff2`),
  as: "font",
  type: "font/woff2",
  crossorigin: "",
});

describe("docs/gallery/design.md: stylesheets, fonts and icon", () => {
  it("serves gallery.css as it is in the repository", async () => {
    const world = new World();
    const response = await app(world, assetPath("gallery.css"));
    expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await response.text()).toBe(css);
  });

  it("declares IBM Plex Sans and Mono with font-display: optional, each font at its fingerprinted path as woff2", async () => {
    const world = new World();
    const fonts = await (await app(world, assetPath("fonts.css"))).text();
    const faces = [...fonts.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "");
    const families = faces.map((face) => {
      const family = /font-family:\s*"([^"]+)"/.exec(face)?.[1];
      const weight = /font-weight:\s*(\d+)/.exec(face)?.[1];
      expect(face).toMatch(/font-display:\s*optional;/);
      return `${family} ${weight}`;
    });
    expect(families).toEqual([
      "IBM Plex Sans 400",
      "IBM Plex Sans 500",
      "IBM Plex Sans 600",
      "IBM Plex Mono 400",
      "IBM Plex Mono 500",
      "IBM Plex Mono 600",
    ]);
    for (const face of faces) {
      const src = /url\("([^"]+)"\) format\("woff2"\)/.exec(face)?.[1] ?? "";
      const path = new URL(src, `https://${APP_HOST}${assetPath("fonts.css")}`).pathname;
      expect(path).toMatch(/^\/assets\/fonts\/ibm-plex-(sans|mono)-latin-[456]00-normal\.[0-9a-f]{16}\.woff2$/);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app(world, path);
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
        expect(response.headers.get("Content-Type")).toBe("font/woff2");
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes.byteLength).toBeGreaterThan(10_000);
        expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
      }
    }
  });

  it("links the icon on every page: the SVG, and the ICO with sizes, both from the app host", async () => {
    const world = new World();
    const id = await create(world, "Page");
    for (const path of ["/", "/archived", `/a/${id}`]) {
      const head = one(elements(await page(world, path)).filter((node) => node.tag === "head"));
      const icons = elements(head)
        .filter((node) => node.tag === "link" && node.attributes.get("rel") === "icon")
        .map((node) => Object.fromEntries(node.attributes));
      expect(icons).toEqual([
        { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
        { rel: "icon", href: assetPath("icon.svg"), type: "image/svg+xml" },
      ]);
    }
  });

  it("serves icon.svg as it is in the repository and favicon.ico as an ICO of 16 and 32 px PNG images", async () => {
    const world = new World();
    const svg = await app(world, assetPath("icon.svg"));
    expect(svg.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await svg.text()).toBe(iconSvg);

    const ico = await app(world, "/favicon.ico");
    expect(ico.headers.get("Content-Type")).toBe("image/vnd.microsoft.icon");
    const view = new DataView(await ico.arrayBuffer());
    // ICONDIR: reserved 0, type 1 (icon), two images; each ICONDIRENTRY points at a PNG of its size.
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 2]);
    const images = [0, 1].map((index) => {
      const entry = 6 + 16 * index;
      const offset = view.getUint32(entry + 12, true);
      const png = new Uint8Array(view.buffer, offset, view.getUint32(entry + 8, true));
      expect(png.slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      // The PNG's own IHDR width and height.
      const header = new DataView(png.buffer, png.byteOffset + 16, 8);
      return [view.getUint8(entry), view.getUint8(entry + 1), header.getUint32(0), header.getUint32(4)];
    });
    expect(images).toEqual([
      [16, 16, 16, 16],
      [32, 32, 32, 32],
    ]);
  });

  // favicon.ico keeps its URL, so it revalidates rather than being cached as immutable.
  it("revalidates the icon at /favicon.ico by its ETag", async () => {
    const world = new World();
    const first = await app(world, "/favicon.ico");
    const etag = first.headers.get("ETag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await app(world, "/favicon.ico", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(again.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(again.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    const other = await app(world, assetPath("fonts.css"), { headers: { "If-None-Match": etag } });
    expect(other.status).toBe(200);
  });

  it("links the stylesheets at their fingerprinted paths and preloads the fonts the pages use", async () => {
    const world = new World();
    const id = await create(world, "Page");
    for (const path of ["/", "/archived", `/a/${id}`]) {
      const head = one(elements(await page(world, path)).filter((node) => node.tag === "head"));
      const links = elements(head).filter((node) => node.tag === "link");
      const stylesheets = links.filter((node) => node.attributes.get("rel") === "stylesheet");
      expect(stylesheets.map((node) => node.attributes.get("href"))).toEqual([
        assetPath("fonts.css"),
        assetPath("gallery.css"),
      ]);
      for (const href of [assetPath("fonts.css"), assetPath("gallery.css"), assetPath("icon.svg")]) {
        expect(href).toMatch(/^\/assets\/[a-z]+\.[0-9a-f]{16}\.(css|svg)$/);
      }
      const preloads = links
        .filter((node) => node.attributes.get("rel") === "preload")
        .map((node) => Object.fromEntries(node.attributes));
      expect(preloads).toEqual([
        preloadOf("sans-latin-400"),
        preloadOf("sans-latin-600"),
        preloadOf("mono-latin-400"),
        { ...preloadOf("sans-latin-500"), fetchpriority: "low" },
        { ...preloadOf("mono-latin-600"), fetchpriority: "low" },
      ]);
      // Each preload is a file fonts.css names, so the font loads once.
      const fonts = await (await app(world, assetPath("fonts.css"))).text();
      for (const preload of preloads) expect(fonts).toContain(`url("${preload.href}")`);
    }
  });
});

describe("design.md section 6: fingerprinted asset paths", () => {
  const FONT = "fonts/ibm-plex-sans-latin-400-normal.woff2";
  const sources = (change: Partial<AssetSources> = {}): AssetSources => ({
    galleryCss: "body { color: red; }",
    fontsCss: `@font-face { src: url("${FONT}") format("woff2"); }`,
    iconSvg: "<svg></svg>",
    fonts: new Map([[FONT, new Uint8Array([1, 2, 3]).buffer]]),
    ...change,
  });

  it("changes a file's path when its bytes change, and fonts.css's when a font's do", async () => {
    const base = await fingerprintAssets(sources());
    const paths = (assets: typeof base) => Object.fromEntries(assets.paths);
    expect(paths(base)).toEqual({
      [FONT]: expect.stringMatching(/^\/assets\/fonts\/ibm-plex-sans-latin-400-normal\.[0-9a-f]{16}\.woff2$/),
      "fonts.css": expect.stringMatching(/^\/assets\/fonts\.[0-9a-f]{16}\.css$/),
      "gallery.css": expect.stringMatching(/^\/assets\/gallery\.[0-9a-f]{16}\.css$/),
      "icon.svg": expect.stringMatching(/^\/assets\/icon\.[0-9a-f]{16}\.svg$/),
    });
    // The same bytes, the same paths.
    expect(paths(await fingerprintAssets(sources()))).toEqual(paths(base));

    const restyled = await fingerprintAssets(sources({ galleryCss: "body { color: blue; }" }));
    expect(restyled.paths.get("gallery.css")).not.toBe(base.paths.get("gallery.css"));
    expect(paths(restyled)).toEqual({ ...paths(base), "gallery.css": restyled.paths.get("gallery.css") });

    const font = await fingerprintAssets(sources({ fonts: new Map([[FONT, new Uint8Array([1, 2, 4]).buffer]]) }));
    expect(font.paths.get(FONT)).not.toBe(base.paths.get(FONT));
    expect(font.paths.get("fonts.css")).not.toBe(base.paths.get("fonts.css"));
    expect(font.paths.get("gallery.css")).toBe(base.paths.get("gallery.css"));
    // fonts.css names the font's new path.
    const fontsCss = font.files.get(font.paths.get("fonts.css") ?? "")?.body;
    expect(fontsCss).toBe(`@font-face { src: url("${font.paths.get(FONT)}") format("woff2"); }`);
  });

  it("refuses a fonts.css that names a font not bundled", async () => {
    await expect(fingerprintAssets(sources({ fonts: new Map() }))).rejects.toThrow(/not bundled/);
  });
});

// A page from one deployment can load its assets after the next deployment is live, and the release before
// fingerprints named unhashed paths. The Worker keeps only the current bytes, so such a path gets them, revalidated.
/** An asset path under another fingerprint, and with none. */
const outdated = (path: string) => path.replace(/\.[0-9a-f]{16}\./, ".0000000000000000.");
const unhashed = (path: string) => path.replace(/\.[0-9a-f]{16}\./, ".");

/** The bytes with one more: another fingerprint. */
function changed(body: string | ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(typeof body === "string" ? new TextEncoder().encode(body) : body);
  const out = new Uint8Array(bytes.byteLength + 1);
  out.set(bytes);
  return out.buffer;
}

describe("design.md section 6: asset paths from another deployment", () => {
  const IMMUTABLE = "private, max-age=31536000, immutable";

  it("serves the current file, revalidated, at an outdated or unhashed path", async () => {
    const world = new World();
    for (const path of GALLERY_ASSETS.paths.values()) {
      const current = await app(world, path);
      const etag = current.headers.get("ETag") ?? "";
      const bytes = await current.arrayBuffer();
      for (const stale of [outdated(path), unhashed(path)]) {
        const response = await app(world, stale);
        expect({ stale, status: response.status }).toEqual({ stale, status: 200 });
        expect({ stale, cache: response.headers.get("Cache-Control") }).toEqual({ stale, cache: "private, no-cache" });
        expect(response.headers.get("Content-Type")).toBe(current.headers.get("Content-Type"));
        expect(response.headers.get("ETag")).toBe(etag);
        expect(await response.arrayBuffer()).toEqual(bytes);
        const again = await app(world, stale, { headers: { "If-None-Match": etag } });
        expect(again.status).toBe(304);
        expect(again.headers.get("Cache-Control")).toBe("private, no-cache");
      }
    }
  });

  it("answers a page of one deployment with the next deployment's files, cached as immutable only at their own paths", async () => {
    const world = new World();
    // Deployment A is the one bundled; deployment B changes every file.
    const head = one(elements(await page(world, "/")).filter((node) => node.tag === "head"));
    const fontsOfA = await (await app(world, assetPath("fonts.css"))).text();
    const urlsOfA = new Set([
      ...elements(head)
        .filter((node) => node.tag === "link")
        .map((node) => node.attributes.get("href") ?? "")
        .filter((href) => href !== "/favicon.ico"),
      ...[...fontsOfA.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? ""),
    ]);
    expect([...urlsOfA].toSorted()).toEqual([...GALLERY_ASSETS.paths.values()].toSorted());

    const fonts = [...GALLERY_ASSETS.named].filter(([name]) => name.startsWith("fonts/"));
    const nameOf = new Map([...GALLERY_ASSETS.paths].map(([name, path]) => [path, name]));
    const b = await fingerprintAssets({
      galleryCss: `${css}\n/* B */\n`,
      // fonts.css as in the repository: A's, with each font named again by its name.
      fontsCss: fontsOfA.replace(/url\("([^"]+)"\)/g, (_, path: string) => `url("${nameOf.get(path) ?? path}")`),
      iconSvg: `${iconSvg}\n`,
      fonts: new Map(fonts.map(([name, asset]) => [name, changed(asset.body)])),
    });

    for (const url of urlsOfA) {
      const name = nameOf.get(url) ?? "";
      const wanted = b.named.get(name);
      expect(b.paths.get(name)).not.toBe(url);
      const response = await serveGalleryAsset(new Request(`https://${APP_HOST}${url}`), url, b);
      expect({ url, status: response?.status }).toEqual({ url, status: 200 });
      expect({ url, cache: response?.headers.get("Cache-Control") }).toEqual({ url, cache: "private, no-cache" });
      expect(response?.headers.get("ETag")).toBe(wanted === undefined ? "" : await assetTag(wanted));
      const body = new Uint8Array((await response?.arrayBuffer()) ?? new ArrayBuffer(0));
      const want = wanted === undefined ? "" : wanted.body;
      expect(body).toEqual(typeof want === "string" ? new TextEncoder().encode(want) : new Uint8Array(want));
    }
    // B's fonts.css, served at A's path, names B's fonts.
    const stale = await serveGalleryAsset(new Request(`https://${APP_HOST}/`), assetPath("fonts.css"), b);
    const named = [...((await stale?.text()) ?? "").matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? "");
    expect(named.toSorted()).toEqual(fonts.map(([name]) => b.paths.get(name) ?? "").toSorted());

    for (const path of b.paths.values()) {
      const response = await serveGalleryAsset(new Request(`https://${APP_HOST}${path}`), path, b);
      expect({ path, status: response?.status, cache: response?.headers.get("Cache-Control") }).toEqual({
        path,
        status: 200,
        cache: IMMUTABLE,
      });
    }
  });
});

// Design.md section 10: a page revalidates by an ETag over its rendered bytes, after Access and a successful query.
describe("section 10: page validators", () => {
  const SAME_ON_304 = [
    "cache-control",
    "content-security-policy",
    "cross-origin-resource-policy",
    "etag",
    "referrer-policy",
    "x-content-type-options",
  ];

  it("answers a matching If-None-Match with 304 and the 200's headers", async () => {
    const world = new World();
    const id = await create(world, "Page");
    for (const path of ["/", "/archived", `/a/${id}`, `/a/${id}?versions_cursor=1`]) {
      const first = await app(world, path);
      expect({ path, status: first.status }).toEqual({ path, status: 200 });
      const etag = first.headers.get("ETag") ?? "";
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
        for (const method of ["GET", "HEAD"]) {
          const again = await app(world, path, { method, headers: { "If-None-Match": header } });
          expect({ path, header, method, status: again.status }).toEqual({ path, header, method, status: 304 });
          expect(await again.text()).toBe("");
          const kept = (response: Response) => SAME_ON_304.map((name) => [name, response.headers.get(name)]);
          expect(kept(again)).toEqual(kept(first));
        }
      }
      expect((await app(world, path, { headers: { "If-None-Match": '"other"' } })).status).toBe(200);
    }
  });

  it("changes the tag when the page's bytes change: a relative time, a count", async () => {
    const world = new World();
    await create(world, "Page");
    const tagOf = async () => (await app(world, "/")).headers.get("ETag") ?? "";
    const first = await tagOf();
    expect(await tagOf()).toBe(first);

    world.clock.now += 3 * HOUR_MS;
    const later = await tagOf();
    expect(later).not.toBe(first);
    expect((await app(world, "/", { headers: { "If-None-Match": first } })).status).toBe(200);

    await world.patch(await create(world, "Old"), { archive: "archived" });
    const counted = await tagOf();
    expect(counted).not.toBe(later);
    expect((await app(world, "/", { headers: { "If-None-Match": later } })).status).toBe(200);
  });

  it("sends no tag and no 304 on a refusal, a 404, a failed read or a redirect", async () => {
    const world = new World({ timeouts: { r2Ms: 2_000, d1ReadMs: 50 } });
    const id = await create(world, "Page");
    const etag = (await app(world, "/")).headers.get("ETag") ?? "";
    const matching = { "If-None-Match": "*" };
    const responses = [
      // Before Access: no JWT.
      await app(world, "/", { jwt: null, headers: { "If-None-Match": etag } }),
      await app(world, `/a/${UNKNOWN_ID}`, { headers: matching }),
      await app(world, "/nothing", { headers: matching }),
      await app(world, "/?cursor=bad", { headers: matching }),
      // The browser hosts' only redirect: a directory on a content host.
      await world.fetch(`https://${id}${CONTENT_SUFFIX}/_v/1`, {
        headers: { "Cf-Access-Jwt-Assertion": await world.jwt({ aud: "content-audience" }), ...matching },
      }),
    ];
    const db = new DatabaseProbe();
    db.behave = () => never();
    world.env = { ...world.env, DB: db.binding };
    responses.push(await app(world, "/", { headers: { "If-None-Match": etag } }));
    expect(responses.map((response) => response.status)).toEqual([403, 404, 404, 404, 308, 503]);
    for (const response of responses) expect(response.headers.has("ETag")).toBe(false);
  });
});
