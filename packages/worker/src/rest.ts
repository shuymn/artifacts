/**
 * The REST adapter on the API host (design.md section 8): routes under `/v1/`, after the bearer credential (TOK-1). It
 * decodes a request into an operation's input, calls the operation and encodes its result; operation errors and
 * transport errors share the JSON shape `{ "error": { "code", "message", … } }`.
 */
import { JSON_BODY_BYTES, PUBLISH_BODY_BYTES, readFormData, readJson } from "./body.ts";
import type { Config } from "./config.ts";
import type { Publisher } from "./credentials.ts";
import { ERROR_STATUS, errorBody, type Issue, type OperationError, type Result } from "./errors.ts";
import { listGrants, revokeGrantById } from "./grants.ts";
import { isArtifactId } from "./id.ts";
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  listVersions,
  lookupFile,
  openFile,
  updateArtifact,
  updateSettings,
  type FileInput,
  type OperationDeps,
} from "./operations.ts";
import { parseVersionNumber, resolveFileParam } from "./paths.ts";
import {
  archivedFilterSchema,
  limitSchema,
  patchSchema,
  restCreateMetaSchema,
  restUpdateMetaSchema,
  validate,
} from "./schemas.ts";
import { entityTag } from "./serve.ts";

export const TRANSPORT_ERRORS = [
  "unauthorized",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERRORS)[number];

const TRANSPORT: Record<TransportErrorCode, { readonly status: number; readonly message: string }> = {
  unauthorized: { status: 401, message: "a valid bearer token is required" },
  method_not_allowed: { status: 405, message: "the method is not allowed on this route" },
  payload_too_large: { status: 413, message: "the request body is larger than its bound" },
  unsupported_media_type: { status: 415, message: "the request body has the wrong content type" },
};

const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...API_HEADERS, ...headers },
  });
}

export function transportError(code: TransportErrorCode, headers: Record<string, string> = {}): Response {
  const { status, message } = TRANSPORT[code];
  return jsonResponse(status, { error: { code, message } }, headers);
}

export function operationError(error: OperationError): Response {
  return jsonResponse(ERROR_STATUS[error.code], errorBody(error));
}

const notFound = () => operationError({ code: "not_found" });
const invalidRequest = (issues: readonly Issue[]) => operationError({ code: "invalid_request", issues });

function encode<T>(result: Result<T>, status = 200): Response {
  return result.ok ? jsonResponse(status, result.value) : operationError(result.error);
}

type Handler = (request: Request, deps: OperationDeps, publisher: Publisher) => Promise<Response>;
const METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
type Handlers = Partial<Record<(typeof METHODS)[number], Handler>>;

/** The methods a route takes, for `Allow`; a `HEAD` takes the `GET` handler. */
function allowOf(handlers: Handlers): string {
  return Object.keys(handlers)
    .flatMap((name) => (name === "GET" ? ["GET", "HEAD"] : [name]))
    .join(", ");
}

/** The `meta` JSON and the `file` parts, in order, of a multipart publish body. */
type Parts = { readonly meta: unknown; readonly files: readonly Blob[] };

async function readParts(request: Request): Promise<{ ok: true; parts: Parts } | { ok: false; response: Response }> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    return { ok: false, response: transportError("unsupported_media_type") };
  }
  const form = await readFormData(request, PUBLISH_BODY_BYTES);
  if (!form.ok) {
    return {
      ok: false,
      response:
        form.reason === "too_large"
          ? transportError("payload_too_large")
          : invalidRequest([{ field: "body", reason: "malformed_body" }]),
    };
  }
  let meta: string | undefined;
  const files: Blob[] = [];
  const issues: Issue[] = [];
  // design.md section 6: a part's file name and Content-Type are ignored; only the names `meta` and `file` exist. A
  // `file` part without a file name is a string, already decoded as UTF-8: its bytes are lost, so it is refused.
  for (const [name, value] of form.value) {
    if (name === "meta") {
      if (meta !== undefined) issues.push({ field: "meta", reason: "duplicate_part" });
      meta = typeof value === "string" ? value : await value.text();
    } else if (name === "file") {
      if (typeof value === "string") issues.push({ field: `files[${files.length}]`, reason: "not_a_file" });
      files.push(typeof value === "string" ? new Blob() : value);
    } else {
      issues.push({ field: "body", reason: "unknown_part" });
    }
  }
  if (meta === undefined) issues.push({ field: "meta", reason: "required" });
  if (issues.length > 0 || meta === undefined) return { ok: false, response: invalidRequest(issues) };
  try {
    return { ok: true, parts: { meta: JSON.parse(meta), files } };
  } catch {
    return { ok: false, response: invalidRequest([{ field: "meta", reason: "invalid_json" }]) };
  }
}

type FileMeta = { readonly path: string; readonly content_type?: string | undefined };

/** Pairs `meta.files[n]` with the n-th `file` part. */
function pairFiles(entries: readonly FileMeta[], parts: readonly Blob[]): FileInput[] | undefined {
  if (entries.length !== parts.length) return undefined;
  const files: FileInput[] = [];
  for (const [index, entry] of entries.entries()) {
    const body = parts[index];
    if (body === undefined) return undefined;
    files.push({ path: entry.path, contentType: entry.content_type, body });
  }
  return files;
}

async function create(request: Request, deps: OperationDeps, publisher: Publisher): Promise<Response> {
  const read = await readParts(request);
  if (!read.ok) return read.response;
  const meta = validate(restCreateMetaSchema, read.parts.meta);
  if (!meta.ok) return invalidRequest(meta.issues);
  const files = pairFiles(meta.value.files, read.parts.files);
  if (files === undefined) return invalidRequest([{ field: "files", reason: "count_mismatch" }]);
  const result = await createArtifact(deps, publisher, {
    title: meta.value.title,
    description: meta.value.description,
    files,
  });
  return encode(result, 201);
}

async function update(request: Request, deps: OperationDeps, publisher: Publisher, id: string): Promise<Response> {
  const read = await readParts(request);
  if (!read.ok) return read.response;
  const meta = validate(restUpdateMetaSchema, read.parts.meta);
  if (!meta.ok) return invalidRequest(meta.issues);
  const files = pairFiles(meta.value.files ?? [], read.parts.files);
  if (files === undefined) return invalidRequest([{ field: "files", reason: "count_mismatch" }]);
  const result = await updateArtifact(deps, publisher, {
    id,
    baseVersion: meta.value.base_version,
    title: meta.value.title,
    description: meta.value.description,
    files,
    remove: meta.value.remove,
  });
  return encode(result, 201);
}

async function patch(request: Request, deps: OperationDeps, publisher: Publisher, id: string): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json\s*(?:;|$)/i.test(contentType)) return transportError("unsupported_media_type");
  const body = await readJson(request, JSON_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? transportError("payload_too_large")
      : invalidRequest([{ field: "body", reason: "invalid_json" }]);
  }
  const input = validate(patchSchema, body.value);
  if (!input.ok) return invalidRequest(input.issues);
  return encode(
    await updateSettings(deps, publisher, { id, public: input.value.public, archive: input.value.archive }),
  );
}

/** A query parameter, with an empty value read as absent (`?archived=&limit=`). */
function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

/** `limit=` as a canonical decimal in the shared page bounds. */
function pageLimit(url: URL, issues: Issue[]): number | undefined {
  const raw = param(url, "limit");
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) {
    issues.push({ field: "limit", reason: "invalid_value" });
    return undefined;
  }
  const limit = validate(limitSchema, Number(raw), ["limit"]);
  if (!limit.ok) issues.push(...limit.issues);
  return limit.ok ? limit.value : undefined;
}

async function list(url: URL, deps: OperationDeps): Promise<Response> {
  const issues: Issue[] = [];
  const archivedRaw = param(url, "archived");
  const archived = archivedRaw === undefined ? undefined : validate(archivedFilterSchema, archivedRaw, ["archived"]);
  if (archived?.ok === false) issues.push(...archived.issues);
  const limit = pageLimit(url, issues);
  if (issues.length > 0) return invalidRequest(issues);
  return encode(
    await listArtifacts(deps, {
      archived: archived?.ok === true ? archived.value : undefined,
      limit,
      cursor: param(url, "cursor"),
    }),
  );
}

async function versions(url: URL, deps: OperationDeps, id: string): Promise<Response> {
  const issues: Issue[] = [];
  const limit = pageLimit(url, issues);
  if (issues.length > 0) return invalidRequest(issues);
  return encode(await listVersions(deps, { id, limit, cursor: param(url, "cursor") }));
}

/** `GET …/versions/{n}/files/{path}`: the raw bytes; `{path}` is resolved like a request path on a content host. */
async function file(
  request: Request,
  url: URL,
  deps: OperationDeps,
  id: string,
  version: number,
  rawPath: string,
): Promise<Response> {
  const path = resolveFileParam(version, rawPath);
  if (!isArtifactId(id) || path === undefined) return notFound();
  const lookup = await lookupFile(deps, { id, path, publicOnly: false });
  if (!lookup.ok) return operationError(lookup.error);
  if (lookup.value.kind === "directory") {
    return new Response(null, { status: 308, headers: { Location: `${url.pathname}/${url.search}`, ...API_HEADERS } });
  }
  const found = lookup.value.file;
  const headers = {
    "Content-Type": found.content_type,
    "Content-Length": String(found.size),
    ETag: await entityTag(found),
    ...API_HEADERS,
  };
  if (request.method === "HEAD") return new Response(null, { headers });
  const object = await openFile(deps, id, found);
  if (!object.ok) return operationError(object.error);
  return new Response(object.value.body, { headers });
}

const noContent = () => new Response(null, { status: 204, headers: API_HEADERS });

/** The grants routes (section 8), where OAuth is on; none elsewhere. */
function grantsRoute(segments: readonly string[], config: Config): Handlers | undefined {
  if (!config.oauth) return undefined;
  if (segments.length === 3) return { GET: async (_r, deps) => encode(await listGrants(deps)) };
  if (segments.length !== 4) return undefined;
  const id = segments[3] ?? "";
  return {
    DELETE: async (_r, deps) => {
      const result = await revokeGrantById(deps, id);
      return result.ok ? noContent() : operationError(result.error);
    },
  };
}

/** The handlers of the route a path under `/v1/` names, matched on the raw pathname's segments; none for no route. */
function route(url: URL, config: Config): Handlers | undefined {
  const segments = url.pathname.split("/");
  if (segments[1] !== "v1") return undefined;
  if (segments[2] === "grants") return grantsRoute(segments, config);
  if (segments[2] !== "artifacts") return undefined;
  if (segments.length === 3) {
    return {
      GET: (_r, deps) => list(url, deps),
      POST: (r, deps, publisher) => create(r, deps, publisher),
    };
  }
  const id = segments[3] ?? "";
  if (segments.length === 4) {
    return {
      GET: async (_r, deps) => encode(await getArtifact(deps, { id })),
      PATCH: (r, deps, publisher) => patch(r, deps, publisher, id),
      DELETE: async (_r, deps, publisher) => {
        const result = await deleteArtifact(deps, publisher, { id });
        return result.ok ? noContent() : operationError(result.error);
      },
    };
  }
  if (segments[4] !== "versions") return undefined;
  if (segments.length === 5) {
    return {
      GET: (_r, deps) => versions(url, deps, id),
      POST: (r, deps, publisher) => update(r, deps, publisher, id),
    };
  }
  const version = parseVersionNumber(segments[5] ?? "");
  if (version === undefined) return undefined;
  if (segments.length === 6) return { GET: async (_r, deps) => encode(await getArtifact(deps, { id, version })) };
  if (segments[6] !== "files" || segments.length < 8) return undefined;
  const rawPath = segments.slice(7).join("/");
  return { GET: (r, deps) => file(r, url, deps, id, version, rawPath) };
}

/** The methods the route `url` names takes, for an `OPTIONS` refused before the credential (ISO-2); none for no route. */
export function restAllow(url: URL, config: Config): string | undefined {
  const handlers = route(url, config);
  return handlers === undefined ? undefined : allowOf(handlers);
}

/** Routes a request on the API host under `/v1/`: the handler of its method, 405 with `Allow` otherwise. */
export function handleRest(request: Request, url: URL, deps: OperationDeps, publisher: Publisher): Promise<Response> {
  const handlers = route(url, deps.config);
  if (handlers === undefined) return Promise.resolve(notFound());
  const requested = request.method === "HEAD" ? "GET" : request.method;
  const method = METHODS.find((known) => known === requested);
  const handler = method === undefined ? undefined : handlers[method];
  if (handler !== undefined) return handler(request, deps, publisher);
  return Promise.resolve(transportError("method_not_allowed", { Allow: allowOf(handlers) }));
}
