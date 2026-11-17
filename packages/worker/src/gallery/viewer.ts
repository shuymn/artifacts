/**
 * The viewer frame's page (design.md section 6, "The viewer frame"): the header with the artifact's actions, and one
 * iframe that shows the page under it. The template produces reference/viewer.html's markup (reference.test.ts holds it
 * to it); every value goes through `html`, which escapes it (ISO-5). The stylesheet and the gallery's icon are inlined,
 * since the content host cannot load the app host's; the one script is the same bytes on every page, so the policy's
 * hash is fixed, and reads each page's values from its markup.
 */
import type { VersionJson, ViewerData } from "../operations.ts";
import { utcMinute } from "./format.ts";
import { html, VIEWER_ICON, VIEWER_STYLE, type Markup, type Value } from "./html.ts";
import { icon, type IconName } from "./icons.ts";
import { VERSION } from "./pages.ts";

/** What the frame page shows: the artifact as one D1 snapshot read it, and where its links lead. */
export type ViewerView = {
  readonly data: ViewerData;
  /** The app host's origin, from the configuration: the gallery's links are absolute. */
  readonly app: string;
  /** Open page directly before the script runs: the request's path and query with `_viewer=off` appended. */
  readonly direct: string;
};

/**
 * What the iframe may use where the top-level page could, still behind the browser's prompts and only while it shows
 * the artifact's origin (design.md section 6). There is no `sandbox`: one that keeps a page working contains nothing.
 */
const ALLOW =
  "fullscreen; clipboard-read; clipboard-write; camera; microphone; geolocation; display-capture; autoplay; screen-wake-lock; web-share";

/** The header's version: `v<n> · latest`, or `v<n> of <latest>` on a pinned version. */
function versionLine(shown: number, latest: number): string {
  return shown === latest ? `v${shown} · latest` : `v${shown} of ${latest}`;
}

/** A link of the menu or the history: its icon, its label and an optional trailing icon. */
function item(
  href: string,
  lead: IconName,
  label: Value,
  options: {
    readonly trailing?: IconName;
    readonly danger?: boolean;
    /** A confirmation page: the script opens it in a popup, the link in a new tab. */
    readonly popup?: boolean;
    readonly id?: string;
    readonly current?: boolean;
  } = {},
): Markup {
  return html`<a
    class="${options.danger === true ? "menu-item menu-item--danger" : "menu-item"}"
    href="${href}"
    ${options.id !== undefined && html`id="${options.id}"`}
    ${options.popup === true && html`target="_blank"`}
    ${options.current === true && html`aria-current="page"`}
    >${icon(lead, "menu-item__icon")}<span class="menu-item__label">${label}</span>${
      options.trailing !== undefined && icon(options.trailing, "menu-item__trailing")
    }</a
  >`;
}

/** The menu's head: the shown version and its time, `updated` for the latest and `published` for an older one. */
function shownLine(shown: VersionJson, latest: number): Markup {
  const minute = utcMinute(shown.created_at);
  return html`v${shown.number} · ${shown.number === latest ? "updated" : "published"}
    <time datetime="${minute.datetime}">${minute.text}</time>`;
}

/**
 * A version in the history: its number, `latest` on the latest, and its date alone (docs/gallery/design.md), so the
 * page's bytes change only with its data. The latest links to `/`, any other version to `/_v/<n>/`.
 */
function historyItem(version: VersionJson, latest: number, shown: number): Markup {
  const minute = utcMinute(version.created_at);
  const date = html`<time datetime="${minute.datetime}">${minute.text.slice(0, 10)}</time>`;
  const isLatest = version.number === latest;
  // Two spaces after the number, as the design sets them: a no-break space keeps the first from collapsing.
  const label = isLatest ? html`v${version.number}&#160; latest · ${date}` : html`v${version.number}&#160; ${date}`;
  return html`<li>
    ${item(isLatest ? "/" : `/_v/${version.number}/`, "check", label, { current: version.number === shown })}
  </li>`;
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function menu(view: ViewerView): Markup {
  const { artifact, shown } = view.data;
  const latest = artifact.latest_version;
  const page = artifact.gallery_url;
  return html`<div class="viewer-menu" popover id="viewer-menu">
    <p class="viewer-menu__shown">${shownLine(shown, latest)}</p>
    <ul role="list">
      <li>${item(`${view.app}/`, "arrow-left", "Back to gallery")}</li>
      <li>${item(page, "info", "Artifact details", { trailing: "arrow-up-right" })}</li>
      <li>
        <button class="menu-item" type="button" popovertarget="viewer-history">
          ${icon("history", "menu-item__icon")}<span class="menu-item__label">History</span>${icon(
            "chevron-right",
            "menu-item__trailing",
          )}
        </button>
      </li>
      <li>
        ${item(`${page}/v/${shown.number}/export`, "download", `Export v${shown.number} (.zip)`, { id: "viewer-export" })}
      </li>
      <li>
        ${item(
          `${page}/public`,
          artifact.public ? "lock" : "globe",
          artifact.public ? "Make private…" : "Make public…",
          { popup: true },
        )}
      </li>
      <li>${item(view.direct, "square-arrow-out-up-right", "Open page directly", { id: "viewer-direct" })}</li>
    </ul>
    <hr class="viewer-menu__divider" />
    <ul role="list">
      <li>${item(`${page}/delete`, "trash-2", "Delete…", { danger: true, popup: true })}</li>
    </ul>
    <hr class="viewer-menu__divider" />
    <p class="viewer-menu__footer">artifacts v${VERSION}</p>
  </div>`;
}

/** The newest versions, then the shown version when it is older than those, then the gallery's version history. */
function history(view: ViewerView): Markup {
  const { artifact, shown, history: newest } = view.data;
  const latest = artifact.latest_version;
  const listed = newest.some((version) => version.number === shown.number) ? newest : [...newest, shown];
  return html`<div class="viewer-history" popover id="viewer-history">
    <p class="viewer-history__head">History · ${counted(latest, "version")}</p>
    <ul role="list">
      ${listed.map((version) => historyItem(version, latest, shown.number))}
    </ul>
    <hr class="viewer-history__divider" />
    ${item(`${artifact.gallery_url}#versions`, "layout-grid", "All versions in gallery", { trailing: "arrow-up-right" })}
  </div>`;
}

/**
 * The frame's one script (design.md section 6, "The script"), the same bytes on every frame page, which the policy
 * admits by their hash. It holds no backslash: the template's text is its cooked string. It starts the iframe at the
 * page's URL with its fragment; after each load and same-document change it copies the iframe's URL and title to the
 * top window and follows `/_v/<n>/` in the header and the menu; it focuses the iframe once; it closes the menu when the
 * focus moves into the iframe; it opens the confirmation pages in a popup; and where the browser has no `popover`, it
 * opens and closes the menu and the history itself.
 */
const VIEWER_SCRIPT = html`<script>
  (() => {
    const frame = document.getElementById("viewer-frame");
    const menu = document.getElementById("viewer-menu");
    const versions = document.getElementById("viewer-history");
    const menuButton = document.querySelector(".viewer-header .icon-button");
    const historyButton = menu.querySelector("button");
    const header = document.querySelector(".viewer-header__version");
    const shown = menu.querySelector(".viewer-menu__shown");
    const exported = document.getElementById("viewer-export");
    const direct = document.getElementById("viewer-direct");
    const latest = Number(document.body.dataset.latest);
    const pageTitle = document.title;
    const native = "popover" in HTMLElement.prototype;
    const pinned = new RegExp("^/_v/([1-9][0-9]*)(?:/|$)");
    let lastUrl = null;
    let lastVersion = null;
    let focused = false;

    const versionOf = (path) => {
      const match = pinned.exec(path);
      return match === null ? latest : Number(match[1]);
    };

    function showVersion(number) {
      if (number === lastVersion) return;
      lastVersion = number;
      const isLatest = number >= latest;
      header.textContent = isLatest ? "v" + number + " · latest" : "v" + number + " of " + latest;
      let time = null;
      for (const link of versions.querySelectorAll("li a")) {
        if (versionOf(new URL(link.href).pathname) === number) {
          link.setAttribute("aria-current", "page");
          time = link.querySelector("time");
        } else {
          link.removeAttribute("aria-current");
        }
      }
      shown.textContent = "v" + number;
      if (time !== null) {
        const datetime = time.getAttribute("datetime");
        const stamp = document.createElement("time");
        stamp.setAttribute("datetime", datetime);
        stamp.textContent = datetime.slice(0, 10) + " " + datetime.slice(11, 16);
        shown.append(isLatest ? " · updated " : " · published ", stamp);
      }
      exported.href = exported.href.replace(new RegExp("/v/[0-9]+/export$"), "/v/" + number + "/export");
      exported.querySelector(".menu-item__label").textContent = "Export v" + number + " (.zip)";
    }

    function sync() {
      let inner;
      let title;
      try {
        inner = frame.contentWindow.location;
        if (inner.origin !== location.origin) return;
        title = frame.contentDocument.title;
      } catch (error) {
        return;
      }
      const url = inner.pathname + inner.search + inner.hash;
      if (url !== lastUrl) {
        lastUrl = url;
        window.history.replaceState(window.history.state, "", url);
        direct.href = inner.pathname + (inner.search === "" ? "?" : inner.search + "&") + "_viewer=off" + inner.hash;
        showVersion(versionOf(inner.pathname));
      }
      document.title = title === "" ? pageTitle : title;
    }

    function close() {
      if (native) {
        if (menu.matches(":popover-open")) menu.hidePopover();
      } else {
        setOpen(menu, false);
      }
    }

    function setOpen(panel, open) {
      panel.hidden = !open;
      (panel === menu ? menuButton : historyButton).setAttribute("aria-expanded", String(open));
      if (panel === menu && !open) setOpen(versions, false);
    }

    frame.addEventListener("load", () => {
      sync();
      try {
        const inner = frame.contentWindow;
        if (inner.location.origin !== location.origin) return;
        inner.addEventListener("popstate", sync);
        inner.addEventListener("hashchange", sync);
        if (inner.navigation) inner.navigation.addEventListener("currententrychange", sync);
      } catch (error) {
        return;
      }
      if (!focused) {
        focused = true;
        if (document.activeElement === null || document.activeElement === document.body) frame.focus();
      }
    });

    window.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement === frame) close();
      }, 0);
    });

    for (const link of document.querySelectorAll(".viewer-menu a[target=_blank]")) {
      link.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const popup = window.open(link.href, "artifacts-confirm", "popup,width=480,height=560");
        if (popup === null) return;
        event.preventDefault();
        close();
      });
    }

    if (!native) {
      setOpen(menu, false);
      menuButton.addEventListener("click", () => setOpen(menu, menu.hidden));
      historyButton.addEventListener("click", () => setOpen(versions, versions.hidden));
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!versions.hidden) setOpen(versions, false);
        else setOpen(menu, false);
      });
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!versions.hidden && !versions.contains(target) && !historyButton.contains(target)) {
          setOpen(versions, false);
        }
        if (!menu.hidden && !menu.contains(target) && !versions.contains(target) && !menuButton.contains(target)) {
          setOpen(menu, false);
        }
      });
    }

    frame.src = location.href;
  })();
</script>`;

/** The script's text, whose SHA-256 the frame page's policy names. */
export const VIEWER_SCRIPT_TEXT = VIEWER_SCRIPT.text.slice("<script>".length, -"</script>".length);

/** The frame page for a private page that a top-level navigation asks for (design.md section 6). */
export function viewerPage(view: ViewerView): Markup {
  const { artifact, shown } = view.data;
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width" />
        <meta name="text-scale" content="scale" />
        <title>${artifact.title}</title>
        <style>
          ${VIEWER_STYLE}
        </style>
      </head>
      <body class="viewer" data-latest="${artifact.latest_version}">
        <header class="viewer-header">
          <div class="viewer-header__left">
            <a class="viewer-header__home" href="${view.app}/" aria-label="artifacts">${VIEWER_ICON}</a>
            <div class="viewer-header__artifact">
              <h1 class="viewer-header__title">${artifact.title}</h1>
              <span class="viewer-header__version">${versionLine(shown.number, artifact.latest_version)}</span>
            </div>
          </div>
          <noscript><a class="viewer-header__direct" href="${view.direct}">Open page directly</a></noscript>
          <button class="icon-button" type="button" popovertarget="viewer-menu" aria-label="Menu">
            ${icon("ellipsis", "icon-button__icon")}
          </button>
          ${menu(view)} ${history(view)}
        </header>
        <iframe class="viewer__frame" id="viewer-frame" title="Artifact page" allow="${ALLOW}"></iframe>
        ${VIEWER_SCRIPT}
      </body>
    </html> `;
}
