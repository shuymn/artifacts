/**
 * The gallery on the app host (design.md section 10): `/`, `/archived` and `/a/<id>`, the stylesheets, fonts and icon
 * they load, and a version's download `/a/<id>/v/<n>/export`. index.ts has checked the method (ISO-3) and Access with
 * the app audience (ACC-1) before this runs, and adds the gallery's CSP to every app-host response, these included
 * (`withGalleryPolicy`; ISO-5). Every response here carries the app host's headers (`private, no-cache`, CORP, nosniff,
 * no referrer; ISO-2), except that a fingerprinted asset is cached as immutable (design.md section 6) and a download is
 * `no-store` (section 8). A deleted or unknown artifact, a malformed cursor, an asset path that names no current asset,
 * and any other path answer 404.
 */
import { archiveResponse } from "../archive.ts";
import { errorBody, type OperationError, type OperationErrorCode } from "../errors.ts";
import { exportVersion, getForGallery, listForGallery, type ArchiveCounts, type OperationDeps } from "../operations.ts";
import { parseVersionNumber } from "../paths.ts";
import { browserHeaders, plainResponse, serveAsset } from "../serve.ts";
import { FAVICON, findAsset, GALLERY_ASSETS, type FingerprintedAssets } from "./assets.ts";
import type { Markup } from "./html.ts";
import { artifactPage, listPage, type Chrome, type Section } from "./pages.ts";

/** Design.md section 10: lists and the version history show 50 per page. */
const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

/**
 * ISO-5: nothing but the gallery's own stylesheets, fonts and icon loads (Firefox checks a page's icon against
 * `img-src`); no script runs, no frame shows, and no form submits, except the consent page's to itself and to the
 * client's redirect origin (`formAction`, design.md section 7).
 */
function contentSecurityPolicy(formAction: string | undefined): string {
  const forms = formAction === undefined ? "'none'" : `'self' ${formAction}`;
  return `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action ${forms}; frame-ancestors 'none'`;
}

const HEADERS = browserHeaders("private");

/**
 * Design.md section 6: a fingerprinted asset's path changes with its bytes, so a cached copy never goes stale and the
 * browser need not revalidate it. Still `private`: it is behind Access.
 */
const IMMUTABLE_HEADERS = { ...HEADERS, "Cache-Control": "private, max-age=31536000, immutable" };

/**
 * ISO-5: the app host's response with the gallery's CSP, replacing any other. index.ts applies it to every app-host
 * response at its outer boundary, so refusals before the gallery (405, 403, 503) and failures (500) carry it as well as
 * pages and assets. `formAction` is the consent page's redirect origin, which consent.ts has checked; every other
 * response keeps `form-action 'none'`.
 */
export function withGalleryPolicy(response: Response, formAction?: string): Response {
  const answer = new Response(response.body, response);
  answer.headers.set("Content-Security-Policy", contentSecurityPolicy(formAction));
  return answer;
}

const LISTS: ReadonlyMap<string, Section> = new Map([
  ["/", "active"],
  ["/archived", "archived"],
]);
/** `/a/<id>`; the operation answers `not_found` for anything that is not an artifact ID. */
const ARTIFACT_PATH = /^\/a\/([^/]+)$/;
/** `/a/<id>/v/<n>/export`, `<n>` a canonical decimal as in `/_v/<n>/`. */
const EXPORT_PATH = /^\/a\/([^/]+)\/v\/([^/]+)\/export$/;

const STATUS: Readonly<Record<OperationErrorCode, number>> = {
  invalid_request: 404,
  not_found: 404,
  version_conflict: 500,
  not_extractable: 409,
  unavailable: 503,
  internal: 500,
};

const refusal = (status: number) => plainResponse("private", status);

/**
 * A rendered page, with an `ETag` over its bytes and a 304 for a matching `If-None-Match`, as an asset has (design.md
 * section 10). The tag covers everything the page shows (counts, links, relative times), so no stored timestamp could
 * stand in for it. Only a page answers this way: Access was checked and the query succeeded before it was rendered,
 * and refusals carry no tag.
 */
function page(request: Request, markup: Markup): Promise<Response> {
  return serveAsset(request, { contentType: "text/html; charset=utf-8", body: markup.text }, HEADERS);
}

/**
 * An asset's answer, or `undefined` when the path names no asset. `/favicon.ico` keeps its URL, so it revalidates like
 * a stored file (`no-cache` with an ETag). Any other asset at its current fingerprinted path is immutable; at an
 * outdated or unhashed path, which a page from another deployment names, it is the current file, revalidated, so no
 * browser keeps these bytes under that path (design.md section 6). `assets` is the deployed set; tests pass another.
 */
export function serveGalleryAsset(
  request: Request,
  path: string,
  assets: FingerprintedAssets = GALLERY_ASSETS,
): Promise<Response> | undefined {
  if (path === "/favicon.ico") return serveAsset(request, FAVICON, HEADERS);
  const found = findAsset(assets, path);
  if (found === undefined) return undefined;
  return serveAsset(request, found.asset, found.current ? IMMUTABLE_HEADERS : HEADERS);
}

/**
 * A refused download. `not_extractable` names the paths, which can hold any character but NUL, so it answers with the
 * operation's JSON object; any other error as the gallery's pages do.
 */
function exportRefusal(error: OperationError): Response {
  if (error.code !== "not_extractable") return refusal(STATUS[error.code]);
  return new Response(JSON.stringify(errorBody(error)), {
    status: STATUS[error.code],
    headers: { "Content-Type": "application/json; charset=utf-8", ...HEADERS },
  });
}

/** Version n's archive as a download (design.md section 8, "Export"); a `HEAD` reads no object. */
async function serveExport(request: Request, deps: OperationDeps, id: string, rawVersion: string): Promise<Response> {
  const version = parseVersionNumber(rawVersion);
  if (version === undefined) return refusal(404);
  const archive = await exportVersion(deps, { id, version, body: request.method !== "HEAD" });
  return archive.ok ? archiveResponse(archive.value, HEADERS) : exportRefusal(archive.error);
}

export async function serveGallery(request: Request, url: URL, deps: OperationDeps): Promise<Response> {
  const path = url.pathname;
  const asset = serveGalleryAsset(request, path);
  if (asset !== undefined) return asset;

  const chrome = (counts: ArchiveCounts): Chrome => ({
    counts,
    now: deps.now(),
    archiveAfterDays: Math.round(deps.config.archiveAfterMs / DAY_MS),
  });
  const section = LISTS.get(path);
  if (section !== undefined) {
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const archived = section === "active" ? "exclude" : "only";
    const list = await listForGallery(deps, { archived, limit: PAGE_SIZE, cursor });
    if (!list.ok) return refusal(STATUS[list.error.code]);
    return page(request, listPage(chrome(list.value.counts), section, list.value));
  }
  const id = ARTIFACT_PATH.exec(path)?.[1];
  if (id !== undefined) {
    const cursor = url.searchParams.get("versions_cursor") ?? undefined;
    const artifact = await getForGallery(deps, { id, limit: PAGE_SIZE, cursor });
    if (!artifact.ok) return refusal(STATUS[artifact.error.code]);
    return page(request, artifactPage(chrome(artifact.value.counts), artifact.value));
  }
  const download = EXPORT_PATH.exec(path);
  if (download?.[1] !== undefined && download[2] !== undefined) {
    return serveExport(request, deps, download[1], download[2]);
  }
  return refusal(404);
}
