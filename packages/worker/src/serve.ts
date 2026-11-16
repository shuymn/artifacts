/**
 * Browser hosts (design.md sections 6 and 7): the app host, private content hosts and public hosts. They answer GET
 * and HEAD only (ISO-3), set no cookie (ISO-4) and no `Access-Control-Allow-*` header (ISO-2). Every response of a
 * private content host and of the app host carries `Cross-Origin-Resource-Policy: same-origin` (ISO-2).
 */
import type { ArtifactId } from "./id.ts";
import { lookupFile, openFile, type OperationDeps } from "./operations.ts";
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

/** RFC 9110 section 13.1.2: weak comparison against any listed tag, or `*`. */
function matchesETag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
}

/**
 * One artifact's files on its content or public host: the latest version at `/`, version `n` at `/_v/<n>/` (SRV-2).
 * Access (checked by the caller), the public flag and existence are checked before `If-None-Match` (SRV-3).
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
  const lookup = await lookupFile(deps, { id, path, publicOnly: kind === "public" });
  if (!lookup.ok) {
    const code = lookup.error.code;
    return plainResponse(kind, code === "not_found" ? 404 : code === "unavailable" ? 503 : 500);
  }
  if (lookup.value.kind === "directory") {
    return new Response(null, {
      status: 308,
      headers: { Location: `${url.pathname}/${url.search}`, ...browserHeaders(kind) },
    });
  }
  const file = lookup.value.file;
  const etag = `"${file.sha256}"`;
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
