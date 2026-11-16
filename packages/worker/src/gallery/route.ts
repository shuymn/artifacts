/**
 * The gallery on the app host (design.md section 10): `/`, `/archived` and `/a/<id>`, and the stylesheets, fonts and
 * icon they load. index.ts has checked the method (ISO-3) and Access (ACC-1) before this runs, and adds the gallery's
 * CSP to every app-host response, these included (`withGalleryPolicy`; ISO-5). Every response here carries the app
 * host's headers (`private, no-cache`, CORP, nosniff, no referrer; ISO-2). A deleted or unknown artifact, a malformed
 * cursor and any other path answer 404.
 */
import type { OperationErrorCode } from "../errors.ts";
import { getForGallery, listForGallery, type ArchiveCounts, type OperationDeps } from "../operations.ts";
import { browserHeaders, plainResponse, serveAsset } from "../serve.ts";
import { ASSETS } from "./assets.ts";
import type { Markup } from "./html.ts";
import { artifactPage, listPage, type Chrome, type Section } from "./pages.ts";

/** Design.md section 10: lists and the version history show 50 per page. */
const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

/**
 * ISO-5: nothing but the gallery's own stylesheets, fonts and icon loads (Firefox checks a page's icon against
 * `img-src`); no script runs, no form submits, no frame shows.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HEADERS = browserHeaders("private");

/**
 * ISO-5: the app host's response with the gallery's CSP. index.ts applies it to every app-host response at its outer
 * boundary, so refusals before the gallery (405, 403, 503) and failures (500) carry it as well as pages and assets.
 */
export function withGalleryPolicy(response: Response): Response {
  const answer = new Response(response.body, response);
  answer.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  return answer;
}

const LISTS: ReadonlyMap<string, Section> = new Map([
  ["/", "active"],
  ["/archived", "archived"],
]);
/** `/a/<id>`; the operation answers `not_found` for anything that is not an artifact ID. */
const ARTIFACT_PATH = /^\/a\/([^/]+)$/;

const STATUS: Readonly<Record<OperationErrorCode, number>> = {
  invalid_request: 404,
  not_found: 404,
  version_conflict: 500,
  unavailable: 503,
  internal: 500,
};

const refusal = (status: number) => plainResponse("private", status);

/** A body for GET, none for HEAD; the headers are the same, `Content-Length` included. */
function respond(request: Request, body: Uint8Array | ArrayBuffer, headers: Record<string, string>): Response {
  const length = String(body.byteLength);
  return new Response(request.method === "HEAD" ? null : body, { headers: { ...headers, "Content-Length": length } });
}

function page(request: Request, markup: Markup): Response {
  return respond(request, new TextEncoder().encode(markup.text), {
    "Content-Type": "text/html; charset=utf-8",
    ...HEADERS,
  });
}

export async function serveGallery(request: Request, url: URL, deps: OperationDeps): Promise<Response> {
  const path = url.pathname;
  // An asset revalidates like a stored file (`no-cache` with an ETag), so a deployment's new stylesheet shows at once.
  const file = ASSETS.get(path);
  if (file !== undefined) return serveAsset(request, file, "private");

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
  return refusal(404);
}
