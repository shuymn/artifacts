// The gallery on the app host (design.md section 10; docs/gallery/design.md): its pages, their data, paging, the
// headers of every response and the escaping of artifact text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_AUD,
  APP_HOST,
  BucketProbe,
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
      "/favicon.ico",
      "/assets/",
      "/assets/fonts/other.woff2",
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

  it("sends a CSP that forbids scripts, forms and framing on every response", async () => {
    const world = new World();
    const id = await create(world, "Page");
    for (const path of ["/", "/archived", `/a/${id}`, "/assets/gallery.css", "/nothing"]) {
      const policy = (await app(world, path)).headers.get("Content-Security-Policy") ?? "";
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
    }
  });
});

describe("section 10: headers", () => {
  // PL-10, ISO-2, ISO-4 on every gallery response; section 6's `private, no-cache` for the app host.
  it("sends the app host's headers and no cookie on pages and assets", async () => {
    const world = new World();
    const id = await create(world, "Page");
    for (const path of ["/", "/archived", `/a/${id}`, "/assets/gallery.css", "/assets/fonts.css"]) {
      const response = await app(world, path);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
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
    for (const path of ["/", `/a/${id}`, "/assets/fonts/ibm-plex-sans-latin-400-normal.woff2"]) {
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
    for (const path of ["/", "/archived", `/a/${UNKNOWN_ID}`, "/assets/gallery.css", "/assets/fonts.css"]) {
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

describe("docs/gallery/design.md: stylesheets and fonts", () => {
  it("serves gallery.css as it is in the repository", async () => {
    const world = new World();
    const response = await app(world, "/assets/gallery.css");
    expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await response.text()).toBe(css);
  });

  it("declares IBM Plex Sans and Mono with font-display: swap, each font served as woff2", async () => {
    const world = new World();
    const fonts = await (await app(world, "/assets/fonts.css")).text();
    const faces = [...fonts.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "");
    const families = faces.map((face) => {
      const family = /font-family:\s*"([^"]+)"/.exec(face)?.[1];
      const weight = /font-weight:\s*(\d+)/.exec(face)?.[1];
      expect(face).toMatch(/font-display:\s*swap;/);
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
      const path = new URL(src, `https://${APP_HOST}/assets/fonts.css`).pathname;
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

  it("revalidates an asset by its ETag", async () => {
    const world = new World();
    const first = await app(world, "/assets/gallery.css");
    const etag = first.headers.get("ETag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await app(world, "/assets/gallery.css", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(again.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    const other = await app(world, "/assets/fonts.css", { headers: { "If-None-Match": etag } });
    expect(other.status).toBe(200);
  });
});
