// The templates produce the reference pages' markup (docs/gallery/design.md: the reference pages are "the markup the
// Worker's templates must produce"). Each page is rendered from the data its reference page shows and compared element
// by element: tag, every attribute (links and times included) and the element's own text. Only the differences that
// are on purpose are rewritten first: the stylesheet links and the placeholder cursors.
import { describe, expect, it } from "vitest";

import archivedHtml from "../../../../docs/gallery/reference/archived.html?raw";
import artifactHtml from "../../../../docs/gallery/reference/artifact.html?raw";
import indexHtml from "../../../../docs/gallery/reference/index.html?raw";
import type { ArtifactJson, GalleryArtifact, GalleryList, ListedArtifact, VersionJson } from "../operations.ts";
import { artifactPage, listPage, type Chrome } from "./pages.ts";
import { decodeEntities, parseHtml, textOf, type HtmlNode } from "./test-html.ts";

/** The time the reference pages' relative times count from: "2 hours ago" for 09:12. */
const CHROME: Chrome = {
  counts: { active: 24, archived: 7 },
  now: Date.parse("2026-11-16T11:12:00Z"),
  archiveAfterDays: 30,
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

/** The reference pages load Google Fonts and the repository's gallery.css; the Worker serves both itself. */
const STYLESHEETS = new Map([
  [
    "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
    "/assets/fonts.css",
  ],
  ["../../../packages/worker/src/gallery/gallery.css", "/assets/gallery.css"],
]);

/**
 * What the comparison sees of an element: its tag, its attributes (classes sorted), its own text runs (whitespace
 * collapsed, entities decoded) and its child elements. `hrefs` rewrites the links that differ on purpose.
 */
type Shape = { tag: string; attributes: Record<string, string>; text: string[]; children: Shape[] };

function shape(node: HtmlNode, hrefs: ReadonlyMap<string, string>): Shape {
  const attributes: Record<string, string> = {};
  for (const [name, value] of [...node.attributes].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (name === "class") attributes[name] = value.split(/\s+/).toSorted().join(" ");
    else if (name === "href") attributes[name] = hrefs.get(value) ?? value;
    else attributes[name] = value;
  }
  const text: string[] = [];
  let run = "";
  const flush = () => {
    const collapsed = decodeEntities(run).replace(/\s+/g, " ").trim();
    if (collapsed !== "") text.push(collapsed);
    run = "";
  };
  const children: Shape[] = [];
  for (const child of node.children) {
    if (child.tag === "#text") {
      run += child.text;
      continue;
    }
    flush();
    children.push(shape(child, hrefs));
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
] as const;

describe("templates and reference pages", () => {
  it.each(PAGES)("renders the elements, attributes and text of %s", async (_name, reference, render, cursors) => {
    const [want, got] = await Promise.all([parseHtml(reference), parseHtml(render().text)]);
    // The parse keeps nesting: the document is one `html` element with `head` and `body`, not a flat list.
    expect(shape(want, STYLESHEETS).children.map((html) => html.children.map((child) => child.tag))).toEqual([
      ["head", "body"],
    ]);
    expect(shape(got, new Map(cursors))).toEqual(shape(want, STYLESHEETS));
  });

  it.each(PAGES)(
    "renders the text of %s as a reader sees it, spaces between elements included",
    async (_name, reference, render) => {
      const [want, got] = await Promise.all([parseHtml(reference), parseHtml(render().text)]);
      expect(textOf(got)).toEqual(textOf(want));
    },
  );
});
