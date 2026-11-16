/**
 * Browser hosts (design.md sections 6 and 7): the app host, private content hosts and public hosts. They answer GET
 * and HEAD only (ISO-3), set no cookie (ISO-4) and no `Access-Control-Allow-*` header (ISO-2). Every response of a
 * private content host and of the app host carries `Cross-Origin-Resource-Policy: same-origin` (ISO-2).
 */
import { assetTag, FAVICON, type Asset } from "./gallery/assets.ts";
import type { ArtifactId } from "./id.ts";
import { lookupFile, lookupServedFile, openFile, type FileJson, type OperationDeps } from "./operations.ts";
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

/** RFC 9110 section 13.1.2: weak comparison against any listed tag, or `*`. */
export function matchesETag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
}

/**
 * A file bundled with the Worker, with its host class's headers. It revalidates like a stored file (`no-cache` with an
 * ETag), and HEAD answers GET's headers without the body.
 */
export async function serveAsset(request: Request, asset: Asset, kind: BrowserClass): Promise<Response> {
  const etag = await assetTag(asset);
  if (matchesETag(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, ...browserHeaders(kind) } });
  }
  const body = typeof asset.body === "string" ? new TextEncoder().encode(asset.body) : asset.body.slice(0);
  const headers = {
    "Content-Type": asset.contentType,
    "Content-Length": String(body.byteLength),
    ETag: etag,
    ...browserHeaders(kind),
  };
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

/** The path browsers request an icon from on their own, which an artifact without that file answers with FAVICON. */
const FAVICON_PATH = "favicon.ico";

/**
 * One artifact's files on its content or public host: the latest version at `/`, version `n` at `/_v/<n>/` (SRV-2).
 * Access (checked by the caller), the public flag and existence are checked before `If-None-Match` (SRV-3). The latest
 * version's `favicon.ico`, when the artifact has none, is the gallery's icon (design.md section 6); a pinned path has no
 * fallback, since browsers request the icon only at the root.
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
  const lookup = fallback ? await lookupServedFile(deps, input) : await lookupFile(deps, input);
  if (!lookup.ok) {
    const code = lookup.error.code;
    return plainResponse(kind, code === "not_found" ? 404 : code === "unavailable" ? 503 : 500);
  }
  if (lookup.value.kind === "absent") return serveAsset(request, FAVICON, kind);
  if (lookup.value.kind === "directory") {
    return new Response(null, {
      status: 308,
      headers: { Location: `${url.pathname}/${url.search}`, ...browserHeaders(kind) },
    });
  }
  const file = lookup.value.file;
  const etag = await entityTag(file);
  if (matchesETag(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, ...browserHeaders(kind) } });
  }
  const headers = {
    "Content-Type": file.content_type,
    "Content-Length": String(file.size),
    ETag: etag,
    ...browserHeaders(kind),
  };
  // A HEAD has the GET's headers and no body, so the object is not read.
  if (request.method === "HEAD") return new Response(null, { headers });
  const object = await openFile(deps, id, file);
  if (!object.ok) return plainResponse(kind, object.error.code === "unavailable" ? 503 : 500);
  return new Response(object.value.body, { headers });
}
