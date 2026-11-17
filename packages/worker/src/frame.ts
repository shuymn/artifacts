/**
 * The viewer frame (design.md section 6, "The viewer frame"): on a private content host, a top-level navigation to an
 * HTML page gets the Worker's frame page, which shows the page in an iframe under the artifact's header; every other
 * request gets the file. serve.ts decides after Access, the path and one D1 batch, and asks here which representation
 * a request gets and for the frame page.
 */
import type { Config } from "./config.ts";
import { scriptSource } from "./encoding.ts";
import type { Asset } from "./gallery/assets.ts";
import type { TimeZone } from "./gallery/format.ts";
import { viewerPage, VIEWER_SCRIPT_TEXT } from "./gallery/viewer.ts";
import { appOrigin } from "./hosts.ts";
import type { ViewerData } from "./operations.ts";

/** The query parameter, with this value, that Open page directly appends: the page without the frame. */
const DIRECT = { name: "_viewer", value: "off" } as const;

/**
 * Whether a request may get the frame page, before the file is known: a top-level navigation (`Sec-Fetch-Dest:
 * document`) without `_viewer=off` in its query. The query never selects a file, so the parameter changes only the
 * representation.
 */
export function wantsFrame(request: Request, url: URL): boolean {
  return (
    request.headers.get("Sec-Fetch-Dest") === "document" && !url.searchParams.getAll(DIRECT.name).includes(DIRECT.value)
  );
}

/** HTML, the types the frame shows a page of: `text/html` and `application/xhtml+xml`, with any parameters. */
export function isHtml(contentType: string): boolean {
  const essence = contentType.split(";")[0]?.trim().toLowerCase();
  return essence === "text/html" || essence === "application/xhtml+xml";
}

/**
 * HTML on a private content host has two representations, the file and the frame page, chosen by `Sec-Fetch-Dest`, so
 * its 200 and 304 vary on it as well as on the encoding, whichever representation they are.
 */
export const FRAMED_VARY = { Vary: "Sec-Fetch-Dest, Accept-Encoding" } as const;

/** Open page directly's URL before the script runs: the request's path and query with the parameter appended. */
function directUrl(url: URL): string {
  return `${url.pathname}${url.search === "" ? "?" : `${url.search}&`}${DIRECT.name}=${DIRECT.value}`;
}

/**
 * The frame page's bytes, with its times in `zone`, the request's. Served with the private host's headers,
 * `FRAMED_VARY` and `framePolicy`, under an `ETag` over these bytes and the zone, compared after Access and existence
 * (SRV-3); a `HEAD` reads no object, since the page has none.
 */
export function frameAsset(url: URL, config: Config, data: ViewerData, zone: TimeZone): Asset {
  const page = viewerPage({ data, app: appOrigin(config), direct: directUrl(url), zone });
  return { contentType: "text/html; charset=utf-8", body: page.text, zone: zone.name };
}

/**
 * The frame page's policy: its one script, by hash. It sets no `default-src` or `frame-src`, which would also govern
 * the iframe's navigations; it names the script so that Cloudflare keeps the page's `ETag` (operations.md, section 1,
 * "Known limit"). It protects little else: the page shares the artifact's origin, whose script can change it.
 */
export async function framePolicy(): Promise<Record<string, string>> {
  return { "Content-Security-Policy": `script-src '${await scriptSource(VIEWER_SCRIPT_TEXT)}'` };
}
