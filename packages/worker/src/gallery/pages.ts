/**
 * The gallery's pages, the consent pages and the confirmation pages (design.md sections 7 and 10). Each template
 * produces the markup of its reference page (docs/gallery/reference/), element for element and class for class;
 * reference.test.ts holds them to it. Every value goes through `html`, which escapes it (ISO-5). No page has a frame;
 * only the consent page and the confirmation pages have a form, and only the confirmation pages and their result page
 * a script: one constant script each, which the CSP admits by its hash.
 */

import rootPackage from "../../../../package.json" with { type: "json" };
import type {
  ArchiveCounts,
  ArtifactJson,
  ConfirmationArtifact,
  GalleryArtifact,
  GalleryList,
  ListedArtifact,
  VersionJson,
} from "../operations.ts";
import { assetPath } from "./assets.ts";
import { byteSize, instant, minuteIn, relativeTime, type TimeZone } from "./format.ts";
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
  /** The zone times are shown in: the request's (format.ts). */
  readonly zone: TimeZone;
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
export const VERSION: string = rootPackage.version;

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

/** A whole page: its title, the header (the brand, then `nav` when given), `main`, then `script` when given. */
function frame(title: string, nav: Markup | null, main: Markup, script: Markup | null = null): Markup {
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
        ${main} ${script}
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

/** A time to the minute in the request's zone, which its `title` names; `datetime` is its UTC instant. */
function time(iso: string, chrome: Chrome): Markup {
  const minute = minuteIn(chrome.zone, iso);
  return html`<time datetime="${minute.datetime}" title="${chrome.zone.name}">${minute.text}</time>`;
}

/** A time relative to now, which no zone changes. */
function relative(iso: string, chrome: Chrome): Markup {
  return html`<time datetime="${instant(iso)}">${relativeTime(iso, chrome.now)}</time>`;
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
        v${artifact.latest_version} · updated ${relative(artifact.updated_at, chrome)} by
        ${artifact.published_by}${reason}
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

/** An info row whose value is a link; `opener` marks the result page's target (`data-opener`). */
function infoAction(label: string, href: string, text: string, opener = false): Markup {
  return html` <div class="info-row">
    <dt>${label}</dt>
    <dd class="info-row__link"><a href="${href}" ${opener && html`data-opener`}>${text}</a></dd>
  </div>`;
}

/** An info row linking a URL of another host, which it shows. */
function infoLink(label: string, url: string, opener = false): Markup {
  return infoAction(label, url, `${url} ↗`, opener);
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

function versionRow(version: VersionJson, chrome: Chrome): Markup {
  return html` <tr role="row">
    ${[
      cell("Version", `v${version.number}`, "cell--mono"),
      cell("Published", time(version.created_at, chrome), "cell--muted"),
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
        infoAction("Visibility", `/a/${artifact.id}/public`, artifact.public ? "Make private…" : "Make public…"),
        infoAction("Download", `/a/${artifact.id}/v/${latest.number}/export`, `Export v${latest.number} (.zip)`),
        infoAction("Deletion", `/a/${artifact.id}/delete`, "Delete…"),
        infoText("Latest", html`v${latest.number} · ${time(latest.created_at, chrome)} by ${latest.published_by}`),
        infoText("Created", html`${time(artifact.created_at, chrome)} by ${first.published_by}`),
        infoText("Archive", archiveState(artifact, chrome)),
      ]}
    </dl>
    <section class="section">
      <h2 class="section-heading" id="versions">
        Versions <span class="section-heading__count">${artifact.latest_version}</span>
      </h2>
      ${table(
        "versions",
        VERSION_COLUMNS,
        versions.versions.map((version) => versionRow(version, chrome)),
      )}
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

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * A confirmation page's form: it posts to its own path, with the desired state (never a toggle) when it has a field,
 * and pairs its button with Cancel, a link to the artifact's page, which the page's script turns into closing the
 * window when a window opened it.
 */
function confirmForm(id: string, action: "public" | "delete", field: Value, button: Markup): Markup {
  return html`<form class="form" method="post" action="/a/${id}/${action}">
    ${field}
    <div class="form__actions">
      ${button}
      <a class="button button--secondary" href="/a/${id}">Cancel</a>
    </div>
  </form>`;
}

/**
 * The confirmation pages' one script (design.md section 10), the same bytes on both pages, which the CSP admits by
 * their hash. When a window opened this one (the viewer's popup), a click on Cancel closes it instead of following the
 * link; it follows the link in a tab without an opener, on a click with a modifier key, and where the browser keeps
 * the window open.
 */
const CONFIRM_SCRIPT = html`<script>
  document.querySelector(".form__actions a").addEventListener("click", (event) => {
    if (window.opener === null || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    window.close();
    if (window.closed) event.preventDefault();
  });
</script>`;

/** The script's text, whose SHA-256 the confirmation pages' CSP names. */
export const CONFIRM_SCRIPT_TEXT = CONFIRM_SCRIPT.text.slice("<script>".length, -"</script>".length);

/** The texts of `/a/<id>/public`, by the state the form asks for. */
const VISIBILITY = {
  true: {
    title: "Make public",
    heading: "Make this artifact public?",
    lead: "Anyone with its public link can open it without signing in.",
    versions: "every version becomes public",
    notice:
      "The link shows the latest version, and /_v/<n>/ shows each earlier one. Make it private again at any time.",
    button: "Make public",
  },
  false: {
    title: "Make private",
    heading: "Make this artifact private?",
    lead: "Its public link stops working.",
    versions: "every version becomes private",
    notice: "Every version’s public URL answers 404 from the next request. Make it public again at any time.",
    button: "Make private",
  },
} as const;

/**
 * `GET /a/<id>/public`: for a private artifact, Make public; for a public one, Make private. Either names the
 * artifact, its versions and its public URL, and posts the state it offers.
 */
export function visibilityPage(view: ConfirmationArtifact): Markup {
  const { artifact } = view;
  const wanted = !artifact.public;
  const text = VISIBILITY[`${wanted}`];
  const main = html`<main class="page page--popup">
    <hgroup class="page-heading">
      <h1>${text.heading}</h1>
      <p>${text.lead}</p>
    </hgroup>
    <dl class="info">
      ${[
        infoText("Artifact", artifact.title),
        infoText("ID", artifact.id),
        infoText("Versions", `${artifact.latest_version}; ${text.versions}`),
        infoText("Public link", view.publicUrl),
      ]}
    </dl>
    <p class="notice">${text.notice}</p>
    ${confirmForm(
      artifact.id,
      "public",
      html`<input type="hidden" name="public" value="${String(wanted)}" />`,
      html`<button class="button button--primary" type="submit">${text.button}</button>`,
    )}
  </main>`;
  return frame(text.title, null, main, CONFIRM_SCRIPT);
}

/**
 * `GET /a/<id>/delete`: what deleting removes, and Delete. The file count and size are the latest version's, on a row
 * of their own: versions share files, so no sum over them would be what is stored.
 */
export function deletePage(view: ConfirmationArtifact): Markup {
  const { artifact, latest } = view;
  const files = `v${latest.number} · ${counted(latest.file_count, "file")}, ${byteSize(latest.total_bytes)}`;
  const main = html`<main class="page page--popup">
    <hgroup class="page-heading">
      <h1>Delete this artifact?</h1>
      <p>It cannot be restored, and its ID is never used again.</p>
    </hgroup>
    <dl class="info">
      ${[
        infoText("Artifact", artifact.title),
        infoText("ID", artifact.id),
        infoText("Versions", counted(artifact.latest_version, "version")),
        infoText("Latest version", files),
        infoText("Visibility", artifact.public ? "Public" : "Private"),
      ]}
    </dl>
    <p class="notice notice--danger">
      Every URL of every version answers 404 at once, and the files are removed. Export a version first if you want a
      copy.
    </p>
    ${confirmForm(
      artifact.id,
      "delete",
      null,
      html`<button class="button button--danger" type="submit">Delete</button>`,
    )}
  </main>`;
  return frame("Delete artifact", null, main, CONFIRM_SCRIPT);
}

/**
 * The result page's one script (design.md section 10), the same bytes on every result page, which the CSP admits by
 * their hash. Its target is the page's link marked `data-opener`: the artifact's URL after a visibility change, the
 * gallery after a deletion. When a window opened this one (the viewer's popup), it sends that window there and closes
 * this one; without an opener (a tab, or the artifact page's own links), the page's links remain.
 */
const RESULT_SCRIPT = html`<script>
  const target = document.querySelector("a[data-opener]");
  if (target !== null && window.opener !== null && !window.opener.closed) {
    window.opener.location.replace(target.href);
    window.close();
  }
</script>`;

/** The script's text, whose SHA-256 the result page's CSP names. */
export const RESULT_SCRIPT_TEXT = RESULT_SCRIPT.text.slice("<script>".length, -"</script>".length);

/** What a successful confirmation changed. */
export type ResultView =
  | { readonly change: "public" | "private"; readonly artifact: ArtifactJson }
  | { readonly change: "deleted"; readonly id: string };

/** The page a successful `POST` answers with itself: what changed, links to the artifact, its page and the gallery. */
export function resultPage(view: ResultView): Markup {
  const gallery = (opener: boolean) => infoAction("Gallery", "/", "All artifacts", opener);
  if (view.change === "deleted") {
    const main = html`<main class="page page--popup">
      <hgroup class="page-heading">
        <h1>The artifact is deleted</h1>
        <p>Every URL of every version answers 404, and its ID is never used again.</p>
      </hgroup>
      <dl class="info">${[infoText("ID", view.id), gallery(true)]}</dl>
    </main>`;
    return frame("Deleted", null, main, RESULT_SCRIPT);
  }
  const { artifact } = view;
  const made = view.change === "public";
  const main = html`<main class="page page--popup">
    <hgroup class="page-heading">
      <h1>The artifact is ${view.change}</h1>
      <p>
        ${
          made
            ? "Anyone with its public link can open it without signing in."
            : "Its public link answers 404 from the next request."
        }
      </p>
    </hgroup>
    <dl class="info">
      ${[
        infoText("Artifact", artifact.title),
        infoLink("Artifact URL", artifact.url, true),
        artifact.public_url !== null && infoLink("Public URL", artifact.public_url),
        infoAction("Details", `/a/${artifact.id}`, "Artifact page"),
        gallery(false),
      ]}
    </dl>
  </main>`;
  return frame(made ? "Made public" : "Made private", null, main, RESULT_SCRIPT);
}
