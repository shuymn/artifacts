/**
 * The gallery's pages and the consent pages (design.md sections 7 and 10). Each template produces the markup of its
 * reference page (docs/gallery/reference/), element for element and class for class; reference.test.ts holds them to
 * it. Every value goes through `html`, which escapes it (ISO-5). No page has a script or a frame, and only the consent
 * page has a form.
 */

import rootPackage from "../../../../package.json" with { type: "json" };
import type {
  ArchiveCounts,
  ArtifactJson,
  GalleryArtifact,
  GalleryList,
  ListedArtifact,
  VersionJson,
} from "../operations.ts";
import { assetPath } from "./assets.ts";
import { byteSize, relativeTime, utcMinute } from "./format.ts";
import { html, type Markup, type Value } from "./html.ts";

/** The section a page belongs to: `/` lists active artifacts, `/archived` archived ones. */
export type Section = "active" | "archived";

/** What every page shows besides its own content. */
export type Chrome = {
  readonly counts: ArchiveCounts;
  /** The time relative times count from. */
  readonly now: number;
  /** ARCHIVE_AFTER_DAYS, for the archive's explanations. */
  readonly archiveAfterDays: number;
};

const STYLESHEETS = ["fonts.css", "gallery.css"].map(
  (name) => html`<link rel="stylesheet" href="${assetPath(name)}" />`,
);

/**
 * The fonts the top of every page uses (docs/gallery/design.md, "Ground rules"), preloaded so they load with the
 * stylesheets rather than after them. Sans 400 (body text), Sans 600 (headings, titles) and Mono 400 (counts, meta)
 * carry most of the text and load at a font's default priority; Sans 500 (links, badges) and Mono 600 (the brand) load
 * at low priority. Mono 500 is not used and is not preloaded.
 */
const PRELOADS = (
  [
    ["fonts/ibm-plex-sans-latin-400-normal.woff2", null],
    ["fonts/ibm-plex-sans-latin-600-normal.woff2", null],
    ["fonts/ibm-plex-mono-latin-400-normal.woff2", null],
    ["fonts/ibm-plex-sans-latin-500-normal.woff2", html`fetchpriority="low"`],
    ["fonts/ibm-plex-mono-latin-600-normal.woff2", html`fetchpriority="low"`],
  ] as const
).map(
  ([name, priority]) =>
    html`<link rel="preload" href="${assetPath(name)}" as="font" type="font/woff2" crossorigin ${priority} />`,
);

/**
 * The icon (docs/gallery/design.md, "Icon"): the SVG where a browser takes one, the ICO elsewhere. The ICO's
 * `sizes="32x32"` keeps Chrome from choosing it over the SVG.
 */
const ICONS = html`<link rel="icon" href="/favicon.ico" sizes="32x32" />
  <link rel="icon" href="${assetPath("icon.svg")}" type="image/svg+xml" />`;

/**
 * The release version: the root package's, which the build inlines into the Worker as it does into the CLI. The Worker
 * is deployed from the release branch, whose package.json carries the release's version.
 */
const VERSION: string = rootPackage.version;

/**
 * The header's brand (docs/gallery/design.md, "Components"): the icon and the wordmark in one link, then the version.
 * The icon's `alt` is empty because the link's text names it, and its `width` and `height` hold its place until it
 * loads.
 */
const BRAND = html`<div class="brand">
  <a class="brand__link" href="/"
    ><img class="brand__icon" src="${assetPath("icon.svg")}" alt="" width="16" height="16" />artifacts</a
  >
  <span class="brand__version">v${VERSION}</span>
</div>`;

/** Each section's nav tab: its label and the list it links to. */
const SECTIONS: Readonly<Record<Section, { readonly label: string; readonly href: string }>> = {
  active: { label: "Active", href: "/" },
  archived: { label: "Archived", href: "/archived" },
};

const sectionOf = (artifact: ArtifactJson): Section => (artifact.archived ? "archived" : "active");

/** A whole page: its title, the header (the brand, then `nav` when given) and `main`. */
function frame(title: string, nav: Markup | null, main: Markup): Markup {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width" />
        <meta name="text-scale" content="scale" />
        <title>${title} · artifacts</title>
        ${PRELOADS} ${STYLESHEETS} ${ICONS}
      </head>
      <body>
        <header class="site-header">${BRAND} ${nav}</header>
        ${main}
      </body>
    </html> `;
}

/**
 * A gallery page, with the sections' tabs in its header. The current section's tab carries `aria-current`: `page` on
 * its list, `true` on an artifact in it (docs/gallery/design.md, "Components").
 */
function document(title: string, chrome: Chrome, current: Section, page: "list" | "artifact", main: Markup): Markup {
  const tab = (section: Section) => {
    const { label, href } = SECTIONS[section];
    const ariaCurrent =
      section !== current ? null : page === "list" ? html`aria-current="page"` : html`aria-current="true"`;
    return html`<a class="nav-tab" href="${href}" ${ariaCurrent}
      >${label} <span class="nav-tab__count">${chrome.counts[section]}</span></a
    >`;
  };
  return frame(
    title,
    html`<nav class="site-nav" aria-label="Sections">${tab("active")} ${tab("archived")}</nav>`,
    main,
  );
}

function time(iso: string, text?: string): Markup {
  const minute = utcMinute(iso);
  return html`<time datetime="${minute.datetime}">${text ?? minute.text}</time>`;
}

/** The badges after a title, Archived before Public, each after a space as in the reference pages. */
function badges(artifact: ArtifactJson): Value {
  return [
    artifact.archived && html` <span class="badge badge--archived">Archived</span>`,
    artifact.public && html` <span class="badge badge--public">Public</span>`,
  ];
}

/** Why an archived artifact is archived (design.md section 5): its setting, or its age. */
function archiveReason(artifact: ArtifactJson, chrome: Chrome): string {
  return artifact.archive === "archived"
    ? "archived by hand"
    : `archived: no updates for ${chrome.archiveAfterDays} days`;
}

/** The artifact page's archive state: the setting or the age that decides it, and what follows from it. */
function archiveState(artifact: ArtifactJson, chrome: Chrome): string {
  const days = chrome.archiveAfterDays;
  if (artifact.archive === "archived") return "Archived by hand";
  if (artifact.archive === "kept") return "Active · kept out of the archive by hand";
  if (artifact.archived) return `Archived · no updates for ${days} days`;
  return `Active · archives automatically after ${days} days without updates`;
}

/**
 * The start of a description for a list row, which shows one line and ends it with an ellipsis: the first
 * `DESCRIPTION_START` characters, more than one line holds, so a row does not carry up to 16 KiB of text.
 */
const DESCRIPTION_START = 200;

function startOf(text: string): string {
  const characters = Array.from(text);
  return characters.length <= DESCRIPTION_START ? text : `${characters.slice(0, DESCRIPTION_START).join("")}…`;
}

function row(artifact: ListedArtifact, chrome: Chrome): Markup {
  const reason = artifact.archived ? ` · ${archiveReason(artifact, chrome)}` : "";
  return html` <li class="artifact-row">
    <div class="artifact-row__summary">
      <div class="artifact-row__title-line">
        <a class="artifact-row__title" href="/a/${artifact.id}">${artifact.title}</a>
        ${badges(artifact)}
      </div>
      ${artifact.description !== "" && html`<p class="artifact-row__description">${startOf(artifact.description)}</p>`}
      <p class="artifact-row__meta">
        v${artifact.latest_version} · updated
        ${time(artifact.updated_at, relativeTime(artifact.updated_at, chrome.now))} by ${artifact.published_by}${reason}
      </p>
    </div>
    <a class="artifact-row__open" href="${artifact.url}">Open ↗</a>
  </li>`;
}

const LIST_HEADINGS: Readonly<Record<Section, { readonly title: string; readonly lead: (days: number) => string }>> = {
  active: { title: "Artifacts", lead: () => "Most recently updated first" },
  archived: {
    title: "Archived",
    lead: (days) => `Archived by hand, or not updated for ${days} days. Every link still works.`,
  },
};

/** `/` and `/archived`: a page of artifacts and a link to the next. */
export function listPage(chrome: Chrome, section: Section, list: GalleryList): Markup {
  const heading = LIST_HEADINGS[section];
  const items: Value =
    list.artifacts.length === 0
      ? html`<p>${section === "active" ? "No artifacts." : "No archived artifacts."}</p>`
      : html`<ul class="artifact-list" role="list">
          ${list.artifacts.map((artifact) => row(artifact, chrome))}
        </ul>`;
  const main = html`<main class="page">
    <hgroup class="page-heading">
      <h1>${heading.title}</h1>
      <p>${heading.lead(chrome.archiveAfterDays)}</p>
    </hgroup>
    ${items} ${pager("Pagination", "cursor", list.next_cursor, "Older →")}
  </main>`;
  return document(heading.title, chrome, section, "list", main);
}

function pager(label: string, parameter: string, cursor: string | null, text: string, fragment = ""): Value {
  if (cursor === null) return null;
  const href = `?${parameter}=${encodeURIComponent(cursor)}${fragment}`;
  return html`<nav class="pager" aria-label="${label}"><a href="${href}">${text}</a></nav>`;
}

function infoLink(label: string, url: string): Markup {
  return html` <div class="info-row">
    <dt>${label}</dt>
    <dd class="info-row__link"><a href="${url}">${url} ↗</a></dd>
  </div>`;
}

function infoText(label: string, value: Value): Markup {
  return html` <div class="info-row">
    <dt>${label}</dt>
    <dd>${value}</dd>
  </div>`;
}

/** A description shown whole: its line breaks as `<br>`, every line escaped. */
function lines(text: string): Value {
  return text.split(/\r\n|\r|\n/).map((line, index) => (index === 0 ? line : html`<br />${line}`));
}

function cell(label: string, value: Value, kind?: string): Markup {
  const classes = kind === undefined ? null : html`class="${kind}"`;
  return html` <td role="cell" ${classes} data-label="${label}">${value}</td>`;
}

function table(id: string, columns: readonly string[], body: readonly Markup[]): Markup {
  return html`<div class="data-table" role="region" tabindex="0" aria-labelledby="${id}">
    <table role="table">
      <thead role="rowgroup">
        <tr role="row">
          ${columns.map((column) => html` <th scope="col" role="columnheader">${column}</th>`)}
        </tr>
      </thead>
      <tbody role="rowgroup">
        ${body}
      </tbody>
    </table>
  </div>`;
}

const VERSION_COLUMNS = ["Version", "Published", "By", "Title", "Files", "Size", "Pinned"] as const;
const FILE_COLUMNS = ["Path", "Type", "Size"] as const;

function versionRow(version: VersionJson): Markup {
  return html` <tr role="row">
    ${[
      cell("Version", `v${version.number}`, "cell--mono"),
      cell("Published", time(version.created_at), "cell--muted"),
      cell("By", version.published_by),
      cell("Title", version.title, "cell--grow"),
      cell("Files", version.file_count, "cell--muted"),
      cell("Size", byteSize(version.total_bytes), "cell--muted"),
      cell("Pinned", html`<a href="${version.url}">View ↗</a>`, "cell--link"),
    ]}
  </tr>`;
}

/** `/a/<id>`: the artifact, a page of its version history, and its latest version's files. */
export function artifactPage(chrome: Chrome, data: GalleryArtifact): Markup {
  const { artifact, latest, first, versions } = data;
  const section = sectionOf(artifact);
  const back = SECTIONS[section];
  const files = latest.files ?? [];
  const main = html`<main class="page page--detail">
    <a class="back-link" href="${back.href}">← ${section === "active" ? "Artifacts" : back.label}</a>
    <header class="artifact-heading">
      <div class="artifact-heading__title">
        <h1>${artifact.title}</h1>
        ${badges(artifact)}
      </div>
      ${artifact.description !== "" && html`<p class="artifact-heading__description">${lines(artifact.description)}</p>`}
    </header>
    <dl class="info">
      ${[
        infoLink("Artifact URL", artifact.url),
        artifact.public_url === null
          ? infoText("Public URL", "Not public")
          : infoLink("Public URL", artifact.public_url),
        infoText("Latest", html`v${latest.number} · ${time(latest.created_at)} by ${latest.published_by}`),
        infoText("Created", html`${time(artifact.created_at)} by ${first.published_by}`),
        infoText("Archive", archiveState(artifact, chrome)),
      ]}
    </dl>
    <section class="section">
      <h2 class="section-heading" id="versions">
        Versions <span class="section-heading__count">${artifact.latest_version}</span>
      </h2>
      ${table("versions", VERSION_COLUMNS, versions.versions.map(versionRow))}
      ${pager("Version pagination", "versions_cursor", versions.next_cursor, "Older versions →", "#versions")}
    </section>
    <section class="section">
      <h2 class="section-heading" id="files">
        Files in v${latest.number} <span class="section-heading__count">${files.length}</span>
      </h2>
      ${table(
        "files",
        FILE_COLUMNS,
        files.map(
          (file) =>
            html` <tr role="row">
              ${[
                cell("Path", file.path, "cell--mono cell--grow"),
                cell("Type", file.content_type, "cell--muted"),
                cell("Size", byteSize(file.size), "cell--muted"),
              ]}
            </tr>`,
        ),
      )}
    </section>
  </main>`;
  return document(artifact.title, chrome, section, "artifact", main);
}

/** What the consent page shows of an authorization request (design.md section 7, "Authorize and consent"). */
export type ConsentView = {
  /** The client's name, as the library describes it: its client ID when it gave none. */
  readonly clientName: string;
  /** The host of a CIMD client's URL; undefined for a client that registered itself (DCR). */
  readonly clientDomain: string | undefined;
  /** The redirect URI's host, where the code goes, and whether it is a loopback host. */
  readonly redirectHost: string;
  readonly loopback: boolean;
  /** The grant's resource: its kind and URL. */
  readonly resource: { readonly kind: "mcp" | "v1"; readonly url: string };
  /** The publisher name the field starts with. */
  readonly publisher: string;
  /** The consent transaction's handle, posted back with the form. */
  readonly handle: string;
};

const RESOURCE_NAMES = { mcp: "MCP", v1: "REST API" } as const;

/**
 * The publisher name the consent page proposes for a client (design.md section 7): its name lowercased, each run of
 * other characters turned into `-`, cut to 32 characters, `client` if nothing is left.
 */
export function proposedPublisher(clientName: string): string {
  const name = clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 32);
  return name === "" ? "client" : name;
}

/**
 * `GET /oauth/authorize`: the client and its request, the publisher name, and Allow and Deny. The rule of the field
 * stands above the input as its description; the message below shows only while the input matches `:user-invalid`, and
 * without script the browser's own validation names a bad value on submit. The pattern escapes its `-`: browsers
 * compile `pattern` with the `v` flag, under which `[a-z0-9-]` is invalid and the browser skips the check.
 */
export function consentPage(view: ConsentView): Markup {
  const app =
    view.clientDomain === undefined
      ? `${view.clientName}, registered itself; the name is not verified`
      : `${view.clientName}, identified by ${view.clientDomain}`;
  const main = html`<main class="page page--narrow">
    <hgroup class="page-heading">
      <h1>Allow access?</h1>
      <p>An app asks for access to your artifacts. Check it before you allow it.</p>
    </hgroup>
    <dl class="info">
      ${[
        infoText("App", app),
        infoText("Sends access to", view.redirectHost),
        infoText("Resource", `${RESOURCE_NAMES[view.resource.kind]} at ${view.resource.url}`),
        infoText("Allows", "Reading, publishing, making public and deleting every artifact"),
      ]}
    </dl>
    ${
      view.loopback &&
      html`<p class="notice">
        ${view.redirectHost} is an app on this computer: allow only if you just started signing in from it.
      </p>`
    }
    <form class="form" method="post" action="/oauth/authorize">
      <input type="hidden" name="handle" value="${view.handle}" />
      <div class="field">
        <label class="field__label" for="publisher">Publisher name</label>
        <p class="field__help" id="publisher-help">
          Shown as who published each version. 1 to 32 lowercase letters, digits or hyphens.
        </p>
        <input
          class="field__input"
          id="publisher"
          name="publisher"
          type="text"
          value="${view.publisher}"
          required
          pattern="[a-z0-9\\-]{1,32}"
          maxlength="32"
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          aria-describedby="publisher-help"
        />
        <p class="field__message">Enter 1 to 32 lowercase letters, digits or hyphens.</p>
      </div>
      <div class="form__actions">
        <button class="button button--primary" type="submit" name="decision" value="approve">Allow</button>
        <button class="button button--secondary" type="submit" name="decision" value="deny" formnovalidate>Deny</button>
      </div>
    </form>
  </main>`;
  return frame("Allow access", null, main);
}

/** Why the consent page cannot go on; each answers with its own text in the error page's frame. */
export type ConsentErrorKind =
  | "transaction"
  | "publisher"
  | "request"
  | "client_on_deployment"
  | "redirect_on_deployment"
  | "redirect_form"
  | "client_unverifiable"
  | "form"
  | "unavailable"
  | "internal";

const RESTART = "Start signing in again from the app.";

const CONSENT_ERRORS: Readonly<
  Record<ConsentErrorKind, { readonly title: string; readonly heading: string; readonly text: string }>
> = {
  transaction: {
    title: "Sign-in can’t continue",
    heading: "This sign-in can’t continue",
    text: `The request expired, was already used, or was opened in another browser. ${RESTART}`,
  },
  publisher: {
    title: "Publisher name not valid",
    heading: "The publisher name isn’t valid",
    text: "A publisher name is 1 to 32 lowercase letters, digits or hyphens. Go back, correct it and allow again.",
  },
  request: {
    title: "Sign-in can’t continue",
    heading: "This sign-in can’t continue",
    text: `The app’s sign-in request isn’t one this server accepts. ${RESTART}`,
  },
  client_on_deployment: {
    title: "Sign-in can’t continue",
    heading: "This sign-in can’t continue",
    text: "The app identifies itself with an address on this server, where an artifact could pose as it. This server doesn’t accept it.",
  },
  redirect_on_deployment: {
    title: "Sign-in can’t continue",
    heading: "This sign-in can’t continue",
    text: "The app asks to send access to an address on this server, where an artifact could read it. This server doesn’t accept it.",
  },
  redirect_form: {
    title: "Sign-in can’t continue",
    heading: "This sign-in can’t continue",
    text: "The app asks to send access to an address this server doesn’t accept: it takes https with a domain name, or http on this computer.",
  },
  client_unverifiable: {
    title: "Sign-in can’t continue",
    heading: "This sign-in can’t continue",
    text: `The app’s description could not be fetched or checked at its address. ${RESTART}`,
  },
  form: {
    title: "Sign-in can’t continue",
    heading: "This sign-in can’t continue",
    text: `The form arrived incomplete. ${RESTART}`,
  },
  unavailable: {
    title: "Sign-in unavailable",
    heading: "Sign-in is unavailable",
    text: "The server could not complete this step. Wait a moment, then start signing in again from the app.",
  },
  internal: {
    title: "Sign-in failed",
    heading: "Sign-in failed",
    text: `Something went wrong on the server. ${RESTART}`,
  },
};

/** The consent page's error page: the same frame, a heading and what to do next. */
export function consentErrorPage(kind: ConsentErrorKind): Markup {
  const error = CONSENT_ERRORS[kind];
  const main = html`<main class="page page--narrow">
    <hgroup class="page-heading">
      <h1>${error.heading}</h1>
      <p>${error.text}</p>
    </hgroup>
  </main>`;
  return frame(error.title, null, main);
}
