/**
 * The OAuth authorization server (design.md section 7): `@cloudflare/workers-oauth-provider` as
 * `OAuthAuthorizationServer`, behind the router. Only the API host's metadata, token and registration paths reach the
 * library's `fetch` (HOST-1). Around it the router answers other methods with 405, counts each body before the library
 * reads it (RES-1), refuses a token request for a revoked grant (OAUTH-5), removes the library's CORS headers (ISO-2)
 * and logs only closed values (DATA-1). The library reaches `OAUTH_KV` through the revocation-recording wrapper.
 */
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";

import { readBytes } from "./body.ts";
import type { Config } from "./config.ts";
import { apiOrigin, appOrigin } from "./hosts.ts";
import { errorName, logEvent } from "./log.ts";
import { fitsKvKey, grantOf, hasRevocationRecord, isGrantId, recordingKv } from "./revocation.ts";

const TOKEN_PATH = "/oauth/token";
const REGISTRATION_PATH = "/oauth/register";
/** The paths of the authorization server on the API host, and the methods each takes; the library serves them. */
export const LIBRARY_PATHS: ReadonlyMap<string, readonly string[]> = new Map([
  ["/.well-known/oauth-authorization-server", ["GET", "HEAD"]],
  [TOKEN_PATH, ["POST"]],
  [REGISTRATION_PATH, ["POST"]],
]);
/** The router's protected resource metadata (design.md section 7); every path under it is OAuth's. */
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
/** The authorization endpoint, on the app host. */
export const AUTHORIZE_PATH = "/oauth/authorize";

/** The API host's OAuth paths: the library's three and the protected resource metadata. */
export function isApiOAuthPath(path: string): boolean {
  return LIBRARY_PATHS.has(path) || path === RESOURCE_METADATA_PATH || path.startsWith(`${RESOURCE_METADATA_PATH}/`);
}

/**
 * Body bounds (design.md section 6, RES-1): the largest valid token request is a few hundred bytes, and a client's
 * metadata a few KiB. The library's own bound on registration is 1 MiB.
 */
const TOKEN_BODY_BYTES = 16 * 1024;
const REGISTRATION_BODY_BYTES = 64 * 1024;

const DAY_SECONDS = 86_400;
/**
 * Lifetimes (design.md section 7, "Tokens and lifetimes"). A grant lasts 30 days from the code exchange and slides 30
 * days from each refresh. Each value is stated even where it is the library's default, so an upgrade cannot move it.
 */
const LIFETIMES = {
  accessTokenTTL: 3_600,
  refreshTokenTTL: 30 * DAY_SECONDS,
  refreshTokenIdleTTL: 30 * DAY_SECONDS,
  clientRegistrationTTL: 90 * DAY_SECONDS,
} as const;

/** The library's error codes; any other is logged as `other` (DATA-1). */
export const OAUTH_ERROR_CODES = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
  "invalid_client_metadata",
  "invalid_redirect_uri",
  "invalid_token",
  "not_implemented",
  "server_error",
  "temporarily_unavailable",
  "other",
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/** The library's error categories (`OAuthErrorInternal.category`); any other is logged as `other`. */
export const OAUTH_ERROR_CATEGORIES = [
  "client-authentication",
  "authorization-code-grant",
  "refresh-token-grant",
  "token-exchange-grant",
  "token-endpoint-request",
  "token-revocation",
  "token-issuance",
  "resource-indicator",
  "client-registration",
  "client-id-metadata-document",
  "protected-resource",
  "enterprise-managed-authorization",
  "token-exchange-callback",
  "other",
] as const;
export type OAuthErrorCategory = (typeof OAUTH_ERROR_CATEGORIES)[number];

function closed<T extends string>(values: readonly T[], value: string): T | "other" {
  return values.find((known) => known === value) ?? "other";
}

/** All the library sees of the Worker's environment: its storage, which the router passes through `recordingKv`. */
export type OAuthEnv = { readonly OAUTH_KV: KVNamespace };

let server: { readonly key: string; readonly instance: OAuthAuthorizationServer<OAuthEnv> } | undefined;

/**
 * The authorization server for `config`, built once per isolate while the hosts stay the same, since the library checks
 * every option as it builds one.
 */
export function authorizationServer(config: Config): OAuthAuthorizationServer<OAuthEnv> {
  const key = `${config.apiHost} ${config.appHost}`;
  if (server?.key === key) return server.instance;
  const origin = apiOrigin(config);
  const instance = new OAuthAuthorizationServer<OAuthEnv>({
    issuer: origin,
    // Every grant and token is bound to one of them (OAUTH-3).
    resources: [`${origin}/mcp`, `${origin}/v1`],
    // A request without `resource`, as 2025-03-26 clients send it, gets the MCP resource.
    defaultResource: `${origin}/mcp`,
    // On the app host, behind Access; RFC 8414 requires only the issuer to match exactly.
    authorizeEndpoint: `${appOrigin(config)}${AUTHORIZE_PATH}`,
    // Paths on the issuer's origin; each is stated so the library serves exactly the paths the router sends it.
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTRATION_PATH,
    // Works only with the compatibility flag global_fetch_strictly_public, which wrangler.jsonc sets (OAUTH-6).
    clientIdMetadataDocumentEnabled: true,
    ...LIFETIMES,
    // Replaces the library's default, which writes each error's description to the logs (DATA-1). Returning nothing
    // keeps the library's RFC 6749 and RFC 7591 bodies, which clients parse.
    onError: ({ code, internal }) => {
      logEvent("oauth.refused", {
        code: closed(OAUTH_ERROR_CODES, code),
        category: closed(OAUTH_ERROR_CATEGORIES, internal.category),
      });
    },
  });
  server = { key, instance };
  return instance;
}

/** An error in the shape of RFC 6749 section 5.2, which OAuth clients parse. */
function oauthError(
  status: number,
  error: OAuthErrorCode,
  description: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...headers },
  });
}

/** ISO-2: the library reflects a request's `Origin` for browser clients; no client in scope runs in a browser. */
function withoutCors(response: Response): Response {
  const names = [...response.headers.keys()].filter((name) => name.toLowerCase().startsWith("access-control-"));
  if (names.length === 0) return response;
  const answer = new Response(response.body, response);
  for (const name of names) answer.headers.delete(name);
  return answer;
}

type GrantType = { readonly parameter: string; readonly gone: string; readonly category: OAuthErrorCategory };

/**
 * The grant types that use a grant: the parameter that names it, and what the library answers a client that
 * authenticated when the grant is gone, with the category it logs; a revoked grant answers the same.
 */
const GRANT_TYPES: ReadonlyMap<string, GrantType> = new Map([
  [
    "authorization_code",
    { parameter: "code", gone: "Grant not found or authorization code expired", category: "authorization-code-grant" },
  ],
  ["refresh_token", { parameter: "refresh_token", gone: "Grant not found", category: "refresh-token-grant" }],
]);

/** The one value of `name` in `form`; undefined when it is missing, repeated or a file. */
function single(form: FormData, name: string): string | undefined {
  const values = form.getAll(name);
  const value = values.length === 1 ? values[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * A token request whose code or refresh token names a grant that cannot be used answers `invalid_grant`, as the library
 * answers a client that authenticated for a grant that is gone. Such a grant has a key KV refuses, which the library's
 * read would turn into a 503 that invites a retry, or a revocation record (OAUTH-5), checked before the library can
 * write the grant back. The router answers before the library authenticates the client, so a request without client
 * authentication, which the library answers 401, learns whether the grant ID it sent has a record. The body is parsed
 * as the library parses it: only an `application/x-www-form-urlencoded` body that `formData()` reads. Any other body,
 * and a repeated parameter, goes on to the library, which refuses it before it reads a grant. Undefined when the
 * request may go on.
 */
async function refuseGoneGrant(request: Request, kv: KVNamespace, timeoutMs: number): Promise<Response | undefined> {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") return undefined;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return undefined;
  }
  const grantType = GRANT_TYPES.get(single(form, "grant_type") ?? "");
  if (grantType === undefined) return undefined;
  const credential = single(form, grantType.parameter);
  const grant = credential === undefined ? undefined : grantOf(credential);
  if (grant === undefined) return undefined;
  if (!fitsKvKey(grant.key)) {
    logEvent("oauth.refused", { code: "invalid_grant", category: grantType.category });
    return oauthError(400, "invalid_grant", grantType.gone);
  }
  let revoked: boolean;
  try {
    revoked = await hasRevocationRecord(kv, grant.id, timeoutMs);
  } catch (error) {
    logEvent("request.failed", { error: errorName(error), host: "api" });
    return oauthError(503, "temporarily_unavailable", "The authorization server is temporarily unavailable");
  }
  if (!revoked) return undefined;
  logEvent("oauth.refused", { reason: "revoked", ...(isGrantId(grant.id) ? { grant: grant.id } : {}) });
  return oauthError(400, "invalid_grant", grantType.gone);
}

export type OAuthDeps = {
  readonly now: () => number;
  readonly kvReadMs: number;
  readonly ctx: ExecutionContext;
};

/**
 * Serves one of the library's paths on the API host of a configuration with OAuth on. `kv` is `OAUTH_KV`. A failure the
 * library does not catch answers 503 `temporarily_unavailable` when a KV call failed, which the client may retry
 * (RFC 7009 section 2.2.1), and 500 `server_error` otherwise.
 */
export async function serveOAuth(
  request: Request,
  url: URL,
  kv: KVNamespace,
  config: Config,
  deps: OAuthDeps,
): Promise<Response> {
  const methods = LIBRARY_PATHS.get(url.pathname) ?? [];
  if (!methods.includes(request.method)) {
    return oauthError(405, "invalid_request", "Method not allowed", { Allow: methods.join(", ") });
  }
  let forwarded = request;
  if (request.method === "POST") {
    const limit = url.pathname === TOKEN_PATH ? TOKEN_BODY_BYTES : REGISTRATION_BODY_BYTES;
    const body = await readBytes(request, limit);
    if (!body.ok) {
      return body.reason === "too_large"
        ? oauthError(413, "invalid_request", "Request payload too large")
        : oauthError(400, "invalid_request", "The request body could not be read");
    }
    forwarded = new Request(request.url, { method: "POST", headers: request.headers, body: body.value });
    if (url.pathname === TOKEN_PATH) {
      const refusal = await refuseGoneGrant(forwarded.clone(), kv, deps.kvReadMs);
      if (refusal !== undefined) return refusal;
    }
  }
  const recording = recordingKv(kv, deps.now);
  try {
    const response = await authorizationServer(config).fetch(forwarded, { OAUTH_KV: recording.kv }, deps.ctx);
    return withoutCors(response);
  } catch (error) {
    // DATA-1: the class of the error only, never its message.
    logEvent("request.failed", { error: errorName(error), host: "api" });
    return recording.failed()
      ? oauthError(503, "temporarily_unavailable", "The authorization server is temporarily unavailable")
      : oauthError(500, "server_error", "Internal error");
  }
}
