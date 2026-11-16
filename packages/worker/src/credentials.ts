/**
 * The resource side of OAuth (design.md section 7, "Checking a credential"): which credential check a request to
 * `/mcp` or `/v1/` gets, the `401` challenge, and the protected resource metadata. The router keeps this side rather
 * than the library's `OAuthResourceServer` (decisions.md). A credential of the library's form goes to the library's
 * `validateToken` with the route's resource, then the grant's revocation record is read (OAUTH-3, OAUTH-5); any other
 * is an API token (tokens.ts). Neither falls back to the other, and neither reads D1 or R2 (TOK-1).
 */
import type { Config } from "./config.ts";
import type { ResourceKind } from "./consent.ts";
import { apiOrigin } from "./hosts.ts";
import { errorName, logEvent } from "./log.ts";
import { authorizationServer, RESOURCE_METADATA_PATH } from "./oauth.ts";
import { operationError, jsonResponse, transportError } from "./rest.ts";
import { fitsKvKey, hasRevocationRecord, isGrantId, recordingKv, type GrantId } from "./revocation.ts";
import { TimeoutError, withTimeout } from "./timeout.ts";
import { apiTokenName, bearerCredential, isTokenName, type TokenName, type TokenRefusal } from "./tokens.ts";

/** Who a credential stands for, and makes a change as (TOK-3): its publisher name, and an OAuth grant's ID. */
export type Publisher = { readonly name: TokenName; readonly grant?: GrantId };

/** The protected resource a path of the API host belongs to; none for a path outside `/mcp` and `/v1/`. */
export function resourceOfPath(path: string): ResourceKind | undefined {
  if (path === "/mcp") return "mcp";
  if (path.startsWith("/v1/")) return "v1";
  return undefined;
}

const RESOURCE_NAMES: Record<ResourceKind, string> = { mcp: "artifacts MCP", v1: "artifacts REST API" };

const resourceUrl = (config: Config, kind: ResourceKind) => `${apiOrigin(config)}/${kind}`;
const metadataUrl = (config: Config, kind: ResourceKind) => `${apiOrigin(config)}${RESOURCE_METADATA_PATH}/${kind}`;

/** The resource whose metadata document `path` names; none for any other path under the metadata path. */
function metadataResource(path: string): ResourceKind | undefined {
  if (path === `${RESOURCE_METADATA_PATH}/mcp`) return "mcp";
  if (path === `${RESOURCE_METADATA_PATH}/v1`) return "v1";
  return undefined;
}

const METADATA_METHODS = "GET, HEAD";

/** The methods the metadata route `path` takes, for `Allow`; undefined when no document is there. */
export function resourceMetadataAllow(path: string): string | undefined {
  return metadataResource(path) === undefined ? undefined : METADATA_METHODS;
}

/**
 * RFC 9728 protected resource metadata, one document per resource, built from the configuration: the resource, the
 * issuer as its one authorization server (claude.ai uses only the first), the header as the one bearer method, and a
 * name. Undefined for any other path under the metadata path, which has no route.
 */
export function serveResourceMetadata(request: Request, url: URL, config: Config): Response | undefined {
  const kind = metadataResource(url.pathname);
  if (kind === undefined) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return transportError("method_not_allowed", { Allow: METADATA_METHODS });
  }
  const document = jsonResponse(200, {
    resource: resourceUrl(config, kind),
    authorization_servers: [apiOrigin(config)],
    bearer_methods_supported: ["header"],
    resource_name: RESOURCE_NAMES[kind],
  });
  return request.method === "HEAD" ? new Response(null, document) : document;
}

/**
 * The `WWW-Authenticate` of a 401 (section 7): where OAuth is on, it names the route's metadata, and carries
 * `error="invalid_token"` when a bearer credential was sent (RFC 6750 section 3.1).
 */
function challenge(config: Config, kind: ResourceKind | undefined, reason: TokenRefusal): string {
  if (!config.oauth || kind === undefined) return "Bearer";
  const sent = reason !== "missing" && reason !== "scheme";
  return `Bearer resource_metadata="${metadataUrl(config, kind)}"${sent ? ', error="invalid_token"' : ""}`;
}

function refused(
  config: Config,
  kind: ResourceKind | undefined,
  reason: TokenRefusal,
  grant?: GrantId,
): CredentialResult {
  logEvent("token.refused", { reason, ...(grant === undefined ? {} : { grant }) });
  return {
    ok: false,
    response: transportError("unauthorized", { "WWW-Authenticate": challenge(config, kind, reason) }),
  };
}

function unavailable(error: unknown): CredentialResult {
  // DATA-1: the class of the error only, never its message.
  logEvent("request.failed", { error: errorName(error), host: "api" });
  return { ok: false, response: operationError({ code: "unavailable" }) };
}

/** A credential of the library's form: three parts joined by `:`, `<user>:<grant ID>:<secret>`. */
function oauthForm(credential: string): { readonly user: string; readonly grant: string } | undefined {
  const parts = credential.split(":");
  if (parts.length !== 3) return undefined;
  const [user = "", grant = ""] = parts;
  return { user, grant };
}

/** The library reads `token:<user>:<grant ID>:<SHA-256 hex>`; a key KV refuses would answer 503, not 401. */
const tokenKeyFits = (user: string, grant: string) => fitsKvKey(`token:${user}:${grant}:${"0".repeat(64)}`);

/** The publisher name a grant's props hold (section 7: `{ publisher }`). */
function publisherOf(props: unknown): TokenName | undefined {
  if (typeof props !== "object" || props === null) return undefined;
  const value: unknown = Reflect.get(props, "publisher");
  return typeof value === "string" && isTokenName(value) ? value : undefined;
}

export type CredentialDeps = { readonly now: () => number; readonly kvReadMs: number };

export type CredentialResult =
  | { readonly ok: true; readonly publisher: Publisher }
  | { readonly ok: false; readonly response: Response };

/**
 * TOK-1: checks the request's bearer credential for the resource `kind` of its path, before any D1 or R2 call. Where
 * OAuth is on (`kv` is `OAUTH_KV`), a credential of the library's form is checked by the library only, under the
 * KV-read timeout, and then refused if its grant has a revocation record, read under the same timeout; a KV failure or
 * timeout answers 503. Any other credential is checked against `API_TOKENS` only.
 */
export async function checkCredential(
  request: Request,
  config: Config,
  kind: ResourceKind | undefined,
  kv: KVNamespace | undefined,
  deps: CredentialDeps,
): Promise<CredentialResult> {
  const bearer = bearerCredential(request);
  if (!bearer.ok) return refused(config, kind, bearer.reason);
  const form = config.oauth && kind !== undefined && kv !== undefined ? oauthForm(bearer.credential) : undefined;
  if (form === undefined || kind === undefined || kv === undefined) {
    const name = await apiTokenName(bearer.credential, config.tokens);
    return name === undefined ? refused(config, kind, "unknown") : { ok: true, publisher: { name } };
  }
  if (!tokenKeyFits(form.user, form.grant)) return refused(config, kind, "oauth");
  const recording = recordingKv(kv, deps.now);
  let validated;
  try {
    validated = await withTimeout(
      authorizationServer(config).validateToken(resourceUrl(config, kind), bearer.credential, {
        OAUTH_KV: recording.kv,
      }),
      deps.kvReadMs,
    );
  } catch (error) {
    if (error instanceof TimeoutError || recording.failed()) return unavailable(error);
    throw error;
  }
  // The token's record is keyed by its grant ID, so a token the library accepts names its grant.
  const name = validated === null ? undefined : publisherOf(validated.props);
  if (name === undefined || !isGrantId(form.grant)) return refused(config, kind, "oauth");
  let revoked: boolean;
  try {
    revoked = await hasRevocationRecord(kv, form.grant, deps.kvReadMs);
  } catch (error) {
    return unavailable(error);
  }
  return revoked ? refused(config, kind, "revoked", form.grant) : { ok: true, publisher: { name, grant: form.grant } };
}
