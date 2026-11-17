/**
 * Browser hosts (design.md sections 6 and 7): the app host, private content hosts and public hosts. They answer GET
 * and HEAD only (ISO-3), set no cookie (ISO-4) and no `Access-Control-Allow-*` header (ISO-2). Every response of a
 * private content host and of the app host carries `Cross-Origin-Resource-Policy: same-origin` (ISO-2).
 */
import { succeed, type Result } from "./errors.ts";
import { FRAMED_VARY, frameAsset, framePolicy, isHtml, wantsFrame } from "./frame.ts";
import { assetTag, FAVICON, type Asset } from "./gallery/assets.ts";
import type { ArtifactId } from "./id.ts";
import {
  lookupFile,
  lookupForViewer,
  lookupServedFile,
  openFile,
  type FileJson,
  type LookupInput,
  type OperationDeps,
  type ServedLookup,
  type ViewerData,
} from "./operations.ts";
import { resolveRequestPath } from "./paths.ts";

/** `private`: the app host and private content hosts, behind Access. `public`: public hosts. */
export type BrowserClass = "private" | "public";

const COMMON_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;

/** SRV-1, SRV-3, ISO-2: the headers of every response of a host class, whatever its status. */
export function browserHeaders(kind: BrowserClass): Record<string, string> {
  return kind === "private"
    ? { ...COMMON_HEADERS, "Cache-Control": "private, no-cache", "Cross-Origin-Resource-Policy": "same-origin" }
    : { ...COMMON_HEADERS, "Cache-Control": "no-cache" };
}

const STATUS_TEXT: Record<number, string> = {
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  500: "Internal Server Error",
  503: "Unavailable",
};

/** A plain-text answer; every 404 of a host class is the same, whatever the reason (PUB-1). */
export function plainResponse(kind: BrowserClass, status: number, headers: Record<string, string> = {}): Response {
  return new Response(STATUS_TEXT[status] ?? "Error", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...browserHeaders(kind), ...headers },
  });
}

/** ISO-3: GET and HEAD only; `OPTIONS` too answers 405, so no preflight succeeds. */
export function methodAllowed(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

export function methodNotAllowed(kind: BrowserClass): Response {
  return plainResponse(kind, 405, { Allow: "GET, HEAD" });
}

/**
 * The entity tag of a stored file (design.md section 6): 128 bits of the SHA-256 over its bytes' hash and its content
 * type. A representation is the bytes with their type, so the same bytes published under another type get another tag
 * and a cached copy with the old type is not revalidated.
 */
export async function entityTag(file: FileJson): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${file.sha256}\n${file.content_type}`),
  );
  const hex = [...new Uint8Array(digest, 0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

/**
 * On every response with a body or a validator (design.md section 6): the runtime and Cloudflare compress by the
 * request's `Accept-Encoding`, and the runtime adds no `Vary` of its own, so a cache would otherwise hand one client
 * the encoding another asked for. Refusals, redirects and errors carry neither and go without it.
 */
const VARY = { Vary: "Accept-Encoding" } as const;

/** RFC 9110 section 13.1.2: weak comparison against any listed tag, or `*`. */
export function matchesETag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
}

/**
 * Bytes the Worker holds (a file bundled with it, or a rendered gallery page), with an `ETag` over them and the headers
 * given: its host class's, under which it revalidates like a stored file (`no-cache` with an ETag), or the app host's
 * immutable ones for a fingerprinted gallery asset. A matching `If-None-Match` answers 304; HEAD answers GET's headers
 * without the body.
 */
export async function serveAsset(
  request: Request,
  asset: Asset,
  hostHeaders: Record<string, string>,
): Promise<Response> {
  const etag = await assetTag(asset);
  if (matchesETag(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, ...VARY, ...hostHeaders } });
  }
  const body = typeof asset.body === "string" ? new TextEncoder().encode(asset.body) : asset.body.slice(0);
  const headers = {
    "Content-Type": asset.contentType,
    "Content-Length": String(body.byteLength),
    ETag: etag,
    ...VARY,
    ...hostHeaders,
  };
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

/** The path browsers request an icon from on their own, which an artifact without that file answers with FAVICON. */
const FAVICON_PATH = "favicon.ico";

/**
 * The served file's lookup and, for a request that may get the viewer frame on a private host, what the frame shows:
 * one D1 batch either way (design.md section 6, "Order").
 */
function lookup(
  deps: OperationDeps,
  input: LookupInput,
  fallback: boolean,
  framing: boolean,
): Promise<Result<{ readonly lookup: ServedLookup; readonly viewer?: ViewerData | undefined }>> {
  if (framing) return lookupForViewer(deps, input, fallback);
  const found = fallback ? lookupServedFile(deps, input) : lookupFile(deps, input);
  return found.then((result) => (result.ok ? succeed({ lookup: result.value }) : result));
}

/**
 * One artifact's files on its content or public host: the latest version at `/`, version `n` at `/_v/<n>/` (SRV-2).
 * Access (checked by the caller), the public flag and existence are checked before `If-None-Match` (SRV-3). The latest
 * version's `favicon.ico`, when the artifact has none, is the gallery's icon (design.md section 6); a pinned path has no
 * fallback, since browsers request the icon only at the root. On a private host, a top-level navigation to an HTML
 * file gets the viewer frame instead of the file (frame.ts); HTML there varies on `Sec-Fetch-Dest`.
 */
export async function serveArtifact(
  request: Request,
  url: URL,
  deps: OperationDeps,
  id: ArtifactId,
  kind: BrowserClass,
): Promise<Response> {
  const path = resolveRequestPath(url.pathname);
  if (path === undefined) return plainResponse(kind, 404);
  const input = { id, path, publicOnly: kind === "public" };
  const fallback = path.version === null && path.file === FAVICON_PATH;
  const framing = kind === "private" && wantsFrame(request, url);
  const found = await lookup(deps, input, fallback, framing);
  if (!found.ok) {
    const code = found.error.code;
    return plainResponse(kind, code === "not_found" ? 404 : code === "unavailable" ? 503 : 500);
  }
  const { lookup: served, viewer } = found.value;
  if (served.kind === "absent") return serveAsset(request, FAVICON, browserHeaders(kind));
  if (served.kind === "directory") {
    return new Response(null, {
      status: 308,
      headers: { Location: `${url.pathname}/${url.search}`, ...browserHeaders(kind) },
    });
  }
  const file = served.file;
  const html = kind === "private" && isHtml(file.content_type);
  if (html && framing && viewer !== undefined) {
    const headers = { ...browserHeaders(kind), ...FRAMED_VARY, ...(await framePolicy()) };
    return serveAsset(request, frameAsset(url, deps.config, viewer), headers);
  }
  const vary = html ? FRAMED_VARY : VARY;
  const etag = await entityTag(file);
  if (matchesETag(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, ...vary, ...browserHeaders(kind) } });
  }
  const headers = {
    "Content-Type": file.content_type,
    "Content-Length": String(file.size),
    ETag: etag,
    ...vary,
    ...browserHeaders(kind),
  };
  // A HEAD has the GET's headers and no body, so the object is not read.
  if (request.method === "HEAD") return new Response(null, { headers });
  const object = await openFile(deps, id, file);
  if (!object.ok) return plainResponse(kind, object.error.code === "unavailable" ? 503 : 500);
  return new Response(object.value.body, { headers });
}
