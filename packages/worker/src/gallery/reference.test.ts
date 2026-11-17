// The templates produce the reference pages' markup (docs/gallery/design.md: the reference pages are "the markup the
// Worker's templates must produce"). Each page is rendered from the data its reference page shows and compared element
// by element: tag, every attribute (links and times included) and the element's own text. Only the differences that
// are on purpose are rewritten first: the stylesheet and icon links, the font preloads, the placeholder cursors and the
// version.
import { describe, expect, it } from "vitest";

import archivedHtml from "../../../../docs/gallery/reference/archived.html?raw";
import artifactHtml from "../../../../docs/gallery/reference/artifact.html?raw";
import confirmDeleteHtml from "../../../../docs/gallery/reference/confirm-delete.html?raw";
import confirmPublicHtml from "../../../../docs/gallery/reference/confirm-public.html?raw";
import confirmResultHtml from "../../../../docs/gallery/reference/confirm-result.html?raw";
import consentErrorHtml from "../../../../docs/gallery/reference/consent-error.html?raw";
import consentHtml from "../../../../docs/gallery/reference/consent.html?raw";
import indexHtml from "../../../../docs/gallery/reference/index.html?raw";
import viewerHtml from "../../../../docs/gallery/reference/viewer.html?raw";
import rootPackage from "../../../../package.json" with { type: "json" };
import type {
  ArtifactJson,
  ConfirmationArtifact,
  GalleryArtifact,
  GalleryList,
  ListedArtifact,
  VersionJson,
} from "../operations.ts";
import { assetPath } from "./assets.ts";
import { timeZone } from "./format.ts";
import {
  artifactPage,
  consentErrorPage,
  consentPage,
  deletePage,
  listPage,
  resultPage,
  visibilityPage,
  type Chrome,
  type ConsentView,
} from "./pages.ts";
import { byClass, decodeEntities, parseHtml, textOf, type HtmlNode } from "./test-html.ts";
import { viewerPage, type ViewerView } from "./viewer.ts";

import viewerCss from "./viewer.css?raw";

/**
 * The time the reference pages' relative times count from: "2 hours ago" for 09:12. The reference pages show times in
 * UTC, the zone of a request without one.
 */
const CHROME: Chrome = {
  counts: { active: 24, archived: 7 },
  now: Date.parse("2026-11-16T11:12:00Z"),
  archiveAfterDays: 30,
  zone: timeZone(undefined),
};

function artifact(
  id: string,
  fields: Partial<ArtifactJson> & Pick<ArtifactJson, "title" | "updated_at">,
): ArtifactJson {
  return {
    id,
    description: "",
    public: false,
    archived: false,
    archive: null,
    latest_version: 1,
    created_at: fields.updated_at,
    url: `https://${id}-art.example.com/`,
    public_url: fields.public === true ? `https://${id}-pub.example.com/` : null,
    gallery_url: `https://artifacts.example.com/a/${id}`,
    ...fields,
  };
}

const listed = (published_by: string, json: ArtifactJson): ListedArtifact => ({ ...json, published_by });

const INDEX: GalleryList = {
  counts: CHROME.counts,
  next_cursor: "1763284320000.aaaaaaaaaaaaaaaaaaaaaaaaaa",
  artifacts: [
    listed(
      "codex",
      artifact("ak2x7m4q9wz3c5v8b2n6r4t7y1", {
        title: "Quarterly revenue chart",
        description: "Interactive bar chart of Q3 revenue by region, with a toggle for year-over-year.",
        public: true,
        latest_version: 3,
        updated_at: "2026-11-16T09:12:00.000Z",
      }),
    ),
    listed(
      "claude-code",
      artifact("bk2x7m4q9wz3c5v8b2n6r4t7y1", {
        title: "Tokyo trip itinerary",
        description: "Day-by-day plan with a map and a budget table.",
        latest_version: 7,
        updated_at: "2026-11-16T06:02:00.000Z",
      }),
    ),
    listed(
      "gemini-cli",
      artifact("ck2x7m4q9wz3c5v8b2n6r4t7y1", {
        title: "Regex playground",
        description: "Paste a pattern and test strings; matches highlight as you type.",
        updated_at: "2026-11-15T10:30:00.000Z",
      }),
    ),
    listed(
      "claude-code",
      artifact("dk2x7m4q9wz3c5v8b2n6r4t7y1", {
        title: "家計簿の月次サマリー（2026年10月）",
        description: "カテゴリ別の支出グラフと前月比の表。",
        latest_version: 4,
        updated_at: "2026-11-13T08:00:00.000Z",
      }),
    ),
    listed(
      "codex",
      artifact("ek2x7m4q9wz3c5v8b2n6r4t7y1", {
        title: "MCP latency dashboard",
        description:
          "p50/p95 latency per tool call from the last 24 hours of logs, grouped by client and tool name, with a toggle for errors only.",
        public: true,
        latest_version: 12,
        updated_at: "2026-11-10T12:00:00.000Z",
      }),
    ),
    listed(
      "script",
      artifact("fk2x7m4q9wz3c5v8b2n6r4t7y1", {
        title: "Untitled sketch",
        latest_version: 2,
        updated_at: "2026-11-04T12:00:00.000Z",
      }),
    ),
  ],
};

const ARCHIVED: GalleryList = {
  counts: CHROME.counts,
  next_cursor: "1754000000000.aaaaaaaaaaaaaaaaaaaaaaaaaa",
  artifacts: [
    listed(
      "claude-code",
      artifact("gk2x7m4q9wz3c5v8b2n6r4t7y1", {
        title: "Conference talk notes",
        description: "Slides outline and speaker notes for the October meetup.",
        archived: true,
        latest_version: 5,
        updated_at: "2026-10-06T12:00:00.000Z",
      }),
    ),
    listed(
      "codex",
      artifact("hk2x7m4q9wz3c5v8b2n6r4t7y1", {
        title: "Color palette explorer",
        description: "Generates accessible palettes from one seed color.",
        archived: true,
        archive: "archived",
        public: true,
        latest_version: 2,
        updated_at: "2026-11-07T12:00:00.000Z",
      }),
    ),
    listed(
      "gemini-cli",
      artifact("ik2x7m4q9wz3c5v8b2n6r4t7y1", {
        title: "Old landing page draft",
        archived: true,
        latest_version: 9,
        updated_at: "2026-08-16T12:00:00.000Z",
      }),
    ),
  ],
};

const ID = "ak2x7m4q9wz3c5v8b2n6r4t7y1";

function version(
  number: number,
  created_at: string,
  published_by: string,
  title: string,
  files: number,
  bytes: number,
) {
  const json: VersionJson = {
    number,
    created_at,
    published_by,
    title,
    description: "",
    file_count: files,
    total_bytes: bytes,
    url: `https://${ID}-art.example.com/_v/${number}/`,
  };
  return json;
}

const file = (path: string, content_type: string, size: number) => ({
  path,
  content_type,
  size,
  sha256: "0".repeat(64),
});

const V3 = version(3, "2026-11-16T09:12:00.000Z", "codex", "Quarterly revenue chart", 4, 48_200);

const ARTIFACT: GalleryArtifact = {
  counts: CHROME.counts,
  artifact: artifact(ID, {
    title: "Quarterly revenue chart",
    description:
      "Interactive bar chart of Q3 revenue by region, with a toggle for year-over-year. Data comes from the finance export of October 31.",
    public: true,
    latest_version: 3,
    created_at: "2026-11-14T18:40:00.000Z",
    updated_at: "2026-11-16T09:12:00.000Z",
  }),
  latest: {
    ...V3,
    files: [
      file("index.html", "text/html; charset=utf-8", 3_100),
      file("chart.js", "text/javascript; charset=utf-8", 38_700),
      file("style.css", "text/css; charset=utf-8", 1_900),
      file("data/q3.json", "application/json; charset=utf-8", 4_500),
    ],
  },
  first: version(1, "2026-11-14T18:40:00.000Z", "claude-code", "Q3 revenue (draft)", 2, 12_400),
  versions: {
    versions: [
      V3,
      version(2, "2026-11-15T21:03:00.000Z", "codex", "Quarterly revenue chart", 4, 47_900),
      version(1, "2026-11-14T18:40:00.000Z", "claude-code", "Q3 revenue (draft)", 2, 12_400),
    ],
    next_cursor: "1",
  },
};

/** The confirmation pages' artifact: the artifact page's, private, with its latest version. */
const CONFIRMATION: ConfirmationArtifact = {
  artifact: { ...ARTIFACT.artifact, public: false, public_url: null },
  latest: V3,
  publicUrl: `https://${ID}-pub.example.com/`,
};

/**
 * The consent page of the reference: Claude Code, identified by its CIMD document's domain, signing in to MCP from a
 * loopback port. The reference shows the handle as `…`.
 */
const CONSENT: ConsentView = {
  clientName: "Claude Code",
  clientDomain: "client.example.com",
  redirectHost: "localhost",
  loopback: true,
  resource: { kind: "mcp", url: "https://artifacts-api.example.com/mcp" },
  publisher: "claude-code",
  handle: "…",
};

/**
 * The reference pages load Google Fonts and the repository's gallery.css and icons, and show the icon from the
 * repository; the Worker serves them itself, at their fingerprinted paths.
 */
const ASSET_LINKS = new Map([
  [
    "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
    assetPath("fonts.css"),
  ],
  ["../../../packages/worker/src/gallery/gallery.css", assetPath("gallery.css")],
  ["../../../packages/worker/src/gallery/favicon.ico", "/favicon.ico"],
  ["../../../packages/worker/src/gallery/icon.svg", assetPath("icon.svg")],
]);

const isPreload = (node: HtmlNode) => node.tag === "link" && node.attributes.get("rel") === "preload";

/** The Worker preloads the fonts it serves; the reference pages, which load Google Fonts, preload none. */
function withoutPreloads(node: HtmlNode): HtmlNode {
  return { ...node, children: node.children.filter((child) => !isPreload(child)).map(withoutPreloads) };
}

/**
 * The reference pages show the version they were drawn with; the Worker shows the root package's, which every release
 * changes.
 */
const REFERENCE_VERSION = "v0.3.0";
const VERSION = `v${rootPackage.version}`;
const VERSIONS = new Map([
  [VERSION, REFERENCE_VERSION],
  [`artifacts ${VERSION}`, `artifacts ${REFERENCE_VERSION}`],
]);

/**
 * What the comparison sees of an element: its tag, its attributes (classes sorted, an `allow` policy's features
 * spaced as one line), its own text runs (whitespace
 * collapsed, entities decoded) and its child elements. `urls` rewrites the `href`s and `src`s that differ on purpose,
 * `texts` the text runs.
 */
type Shape = { tag: string; attributes: Record<string, string>; text: string[]; children: Shape[] };

function shape(
  node: HtmlNode,
  urls: ReadonlyMap<string, string>,
  texts: ReadonlyMap<string, string> = new Map(),
): Shape {
  const attributes: Record<string, string> = {};
  for (const [name, value] of [...node.attributes].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (name === "class") attributes[name] = value.split(/\s+/).toSorted().join(" ");
    // The formatter writes a permissions policy one feature per line, ending each with `;`.
    else if (name === "allow")
      attributes[name] = value
        .split(";")
        .map((feature) => feature.trim())
        .filter(Boolean)
        .join("; ");
    else if (name === "href" || name === "src") attributes[name] = urls.get(value) ?? value;
    else attributes[name] = value;
  }
  const text: string[] = [];
  let run = "";
  const flush = () => {
    const collapsed = decodeEntities(run).replace(/\s+/g, " ").trim();
    if (collapsed !== "") text.push(texts.get(collapsed) ?? collapsed);
    run = "";
  };
  const children: Shape[] = [];
  for (const child of node.children) {
    if (child.tag === "#text") {
      run += child.text;
      continue;
    }
    flush();
    children.push(shape(child, urls, texts));
  }
  flush();
  return { tag: node.tag, attributes, text, children };
}

/**
 * Each page with its reference and the hrefs that differ on purpose: the reference's placeholder cursors (`…`) are the
 * data's cursors here, and the version pager also lands on the version history (`#versions`). The data uses the
 * reference's IDs and origins, and CHROME.now makes the relative times the reference's, so nothing else is rewritten.
 */
const PAGES = [
  ["index.html", indexHtml, () => listPage(CHROME, "active", INDEX), [[`?cursor=${INDEX.next_cursor}`, "?cursor=…"]]],
  [
    "archived.html",
    archivedHtml,
    () => listPage(CHROME, "archived", ARCHIVED),
    [[`?cursor=${ARCHIVED.next_cursor}`, "?cursor=…"]],
  ],
  [
    "artifact.html",
    artifactHtml,
    () => artifactPage(CHROME, ARTIFACT),
    [[`?versions_cursor=${ARTIFACT.versions.next_cursor}#versions`, "?versions_cursor=…"]],
  ],
  ["consent.html", consentHtml, () => consentPage(CONSENT), []],
  // The reference shows the error of a transaction that expired, was used, or belongs to another browser.
  ["consent-error.html", consentErrorHtml, () => consentErrorPage("transaction"), []],
  ["confirm-public.html", confirmPublicHtml, () => visibilityPage(CONFIRMATION), []],
  ["confirm-delete.html", confirmDeleteHtml, () => deletePage(CONFIRMATION), []],
  // The reference shows the result of making the artifact public.
  ["confirm-result.html", confirmResultHtml, () => resultPage({ change: "public", artifact: ARTIFACT.artifact }), []],
] as const;

describe("templates and reference pages", () => {
  it.each(PAGES)("renders the elements, attributes and text of %s", async (_name, reference, render, cursors) => {
    const [want, got] = await Promise.all([parseHtml(reference), parseHtml(render().text)]);
    // The parse keeps nesting: the document is one `html` element with `head` and `body`, not a flat list.
    expect(shape(want, ASSET_LINKS).children.map((html) => html.children.map((child) => child.tag))).toEqual([
      ["head", "body"],
    ]);
    expect(shape(withoutPreloads(got), new Map(cursors), VERSIONS)).toEqual(shape(want, ASSET_LINKS));
  });

  // Make private is the same screen with its own texts (design.md section 10): the reference's elements and attributes,
  // the state the form posts aside.
  it("renders the page for a public artifact with the elements of confirm-public.html", async () => {
    const [want, got] = await Promise.all([
      parseHtml(confirmPublicHtml),
      parseHtml(visibilityPage({ ...CONFIRMATION, artifact: ARTIFACT.artifact }).text),
    ]);
    const untexted = (node: Shape): Shape => ({ ...node, text: [], children: node.children.map(untexted) });
    const posted = shape(withoutPreloads(got), new Map());
    const input = posted.children
      .flatMap(function all(node): Shape[] {
        return [node, ...node.children.flatMap(all)];
      })
      .find((node) => node.tag === "input");
    expect(input?.attributes).toEqual({ name: "public", type: "hidden", value: "false" });
    if (input !== undefined) input.attributes.value = "true";
    expect(untexted(posted)).toEqual(untexted(shape(want, ASSET_LINKS)));
  });

  it.each(PAGES)(
    "renders the text of %s as a reader sees it, spaces between elements included",
    async (_name, reference, render) => {
      const [want, got] = await Promise.all([parseHtml(reference), parseHtml(render().text)]);
      expect(textOf(got).replace(VERSION, REFERENCE_VERSION)).toEqual(textOf(want));
    },
  );
});

/**
 * The viewer's reference page shows the artifact page's artifact, private, pinned to v2 of 3 with the menu and the
 * history open.
 */
const VIEWER: ViewerView = {
  app: "https://artifacts.example.com",
  direct: "/_v/2/?_viewer=off",
  zone: CHROME.zone,
  data: {
    artifact: { ...ARTIFACT.artifact, public: false, public_url: null },
    shown: ARTIFACT.versions.versions[1] ?? V3,
    history: ARTIFACT.versions.versions,
  },
};

const VIEWER_CSS_LINK = "../../../packages/worker/src/gallery/viewer.css";

/**
 * The frame page inlines viewer.css, which the reference page links; and it carries the frame's script, which would
 * load the reference page into its own iframe, where the reference page runs one that opens the menu and the history.
 * Both are rewritten away before the comparison; the stylesheet is compared with viewer.css on its own.
 */
function linked(node: HtmlNode): HtmlNode {
  const children = node.children
    .filter((child) => child.tag !== "script")
    .map((child) =>
      child.tag === "style"
        ? {
            tag: "link",
            attributes: new Map([
              ["rel", "stylesheet"],
              ["href", VIEWER_CSS_LINK],
            ]),
            children: [],
            text: "",
          }
        : linked(child),
    );
  return { ...node, children };
}

const headOf = (root: HtmlNode) => root.children.flatMap((html) => html.children).find((node) => node.tag === "head");

describe("the viewer's template and reference page", () => {
  it("renders the elements, attributes and text of viewer.html", async () => {
    const [want, got] = await Promise.all([parseHtml(viewerHtml), parseHtml(viewerPage(VIEWER).text)]);
    expect(shape(linked(got), new Map(), VERSIONS)).toEqual(shape(linked(want), new Map()));
  });

  it("renders the text of viewer.html as a reader sees it, spaces between elements included", async () => {
    const [want, got] = await Promise.all([parseHtml(viewerHtml), parseHtml(viewerPage(VIEWER).text)]);
    expect(textOf(linked(got)).replace(VERSION, REFERENCE_VERSION)).toEqual(textOf(linked(want)));
  });

  it("inlines viewer.css as it is, and the reference page links it", async () => {
    const [want, got] = await Promise.all([parseHtml(viewerHtml), parseHtml(viewerPage(VIEWER).text)]);
    const inline = headOf(got)?.children.find((child) => child.tag === "style");
    expect(
      inline?.children
        .map((child) => child.text)
        .join("")
        .trim(),
    ).toBe(viewerCss.trim());
    const link = headOf(want)?.children.find((child) => child.tag === "link");
    expect(link?.attributes.get("href")).toBe(VIEWER_CSS_LINK);
  });

  // The other items navigate in the same tab, or open a confirmation in a popup: a trailing icon would promise
  // something they do not do (docs/gallery/design.md, `menu-item`).
  it("ends only History, which opens a list, with a trailing icon", async () => {
    for (const root of await Promise.all([parseHtml(viewerHtml), parseHtml(viewerPage(VIEWER).text)])) {
      const trailed = byClass(root, "menu-item").filter((item) => byClass(item, "menu-item__trailing").length > 0);
      expect(trailed.map(textOf)).toEqual(["History"]);
    }
  });
});
