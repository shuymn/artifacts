/**
 * The authorization endpoint and its consent page (design.md section 7, "Authorize and consent"): `/oauth/authorize` on
 * the app host. index.ts has checked the method (GET or POST; ISO-3) and Access with the app audience (ACC-1) before
 * this runs, and applies the gallery's CSP to every answer, with the client's redirect origin in `form-action` on the
 * page itself (ISO-5). The library parses the request, keeps the consent transaction and completes the authorization;
 * around it the router refuses this deployment's hosts as a client ID or a redirect URI (OAUTH-6, OAUTH-2), requires an
 * S256 PKCE challenge from every client (OAUTH-2), checks the publisher name (TOK-3) and replaces the client's earlier
 * grants through the revocation wrapper before any code is sent (OAUTH-5). Consent is never remembered (OAUTH-1).
 *
 * Every answer is `no-store` without `ETag` or `Vary`, cannot be framed, and sets no cookie but the library's binding
 * of the transaction to this browser (ISO-4). Nothing the client supplied, the handle or the code reaches the logs
 * (DATA-1).
 */
import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import { readBytes } from "./body.ts";
import type { Config } from "./config.ts";
import { consentErrorPage, consentPage, proposedPublisher, type ConsentErrorKind } from "./gallery/pages.ts";
import { apiOrigin } from "./hosts.ts";
import { errorName, logEvent } from "./log.ts";
import { authorizationServer, OAUTH_ERROR_CODES, type OAuthErrorCode } from "./oauth.ts";
import { grantOf, isGrantId, recordingKv, type RecordingKv } from "./revocation.ts";
import { browserHeaders } from "./serve.ts";
import { TimeoutError, withTimeout } from "./timeout.ts";
import { isTokenName } from "./tokens.ts";

/** The user ID of every grant: the Access policy is the one place that names the owner. */
export const OWNER = "owner";

/** RES-1: the consent form holds a handle, a decision and a publisher name, well under 1 KiB. */
const CONSENT_FORM_BYTES = 4 * 1024;

/** Why the endpoint refused or ended a request, for `consent.refused` (DATA-1: a closed set). */
export const CONSENT_REFUSALS = [
  // A client ID on a host of this deployment (OAUTH-6).
  "client_on_deployment",
  // A redirect URI on a host of this deployment (OAUTH-2).
  "redirect_on_deployment",
  // A redirect origin of a form `form-action` does not take (OAUTH-2).
  "redirect_form",
  // The library refused the request without a validated redirect URI: an error page.
  "request_invalid",
  // The library refused the request with a validated redirect URI: a redirect with the error.
  "request_redirected",
  // No S256 PKCE challenge (OAUTH-2).
  "pkce_required",
  // A CIMD document could not be fetched or checked.
  "client_unverifiable",
  // The transaction expired, was used, or belongs to another browser.
  "transaction_invalid",
  // A publisher name of the wrong form (TOK-3).
  "publisher_invalid",
  // A form that is not the consent page's.
  "form_invalid",
  // The owner chose Deny.
  "denied",
] as const;
export type ConsentRefusal = (typeof CONSENT_REFUSALS)[number];

/** A grant's resource, by the path of its URL. */
export type ResourceKind = "mcp" | "v1";
/** How a client identified itself: a Client ID Metadata Document, or dynamic registration. */
export type ClientKind = "cimd" | "dcr";

/** The answer and, for the consent page itself, the origin its form may post to and be redirected to. */
export type ConsentAnswer = { readonly response: Response; readonly formAction?: string };

export type ConsentDeps = {
  readonly now: () => number;
  /** RES-2: the wait for each page of the grant listing, a read of our own. */
  readonly kvReadMs: number;
};

/** The headers of every answer, before index.ts adds the CSP: the app host's, but never stored and never framed. */
function consentHeaders(cookies: Headers | undefined, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    ...browserHeaders("private"),
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    ...extra,
  });
  // Only the library's binding cookie is taken from its headers; its CSP and cache headers are this module's.
  for (const cookie of cookies?.getSetCookie() ?? []) headers.append("Set-Cookie", cookie);
  return headers;
}

function htmlAnswer(status: number, text: string, cookies?: Headers): Response {
  return new Response(text, {
    status,
    headers: consentHeaders(cookies, { "Content-Type": "text/html; charset=utf-8" }),
  });
}

function errorAnswer(kind: ConsentErrorKind, status: number): ConsentAnswer {
  return { response: htmlAnswer(status, consentErrorPage(kind).text) };
}

/**
 * A redirect to the client. A `GET` is answered 302, as an authorization response is; the consent form's `POST` 303,
 * so the browser follows it with a `GET` and never posts the form to the client.
 */
function redirectAnswer(location: string, status: 302 | 303, cookies?: Headers): ConsentAnswer {
  return { response: new Response(null, { status, headers: consentHeaders(cookies, { Location: location }) }) };
}

function refused(reason: ConsentRefusal, code?: OAuthErrorCode): void {
  logEvent("consent.refused", code === undefined ? { reason } : { reason, code });
}

const oauthCode = (code: string): OAuthErrorCode => OAUTH_ERROR_CODES.find((known) => known === code) ?? "other";

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/** A configured host or suffix without its port: a URL on another port of the same host is still this deployment's. */
const withoutPort = (host: string) => host.replace(/:[0-9]+$/, "");

/**
 * Whether `hostname` is one of this deployment's: the app or API host, or a name ending in a content or public suffix,
 * which the deployment's routes send to the Worker whatever comes before the suffix. A trailing dot names the same
 * host.
 */
export function isDeploymentHost(hostname: string, config: Config): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === withoutPort(config.appHost) ||
    host === withoutPort(config.apiHost) ||
    host.endsWith(withoutPort(config.contentSuffix)) ||
    host.endsWith(withoutPort(config.publicSuffix))
  );
}

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A lowercase DNS name, as `URL.hostname` gives one; an IPv4 address matches too and is excluded separately. */
const DNS_HOST = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);
const IPV4 = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/;
/** `URL.hostname` writes every IPv4 address in four decimal parts of at most 255. */
const LOOPBACK_IPV4 = /^127\.[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * The origin the consent page's `form-action` admits besides its own (design.md section 7): the redirect URI's origin
 * when it is `https://` with a DNS name or `http://` with a loopback name (`localhost`, `127.0.0.0/8`), each with an
 * optional port. Any other form is undefined and refused before the page: only these forms are written into the header
 * as they are, with nothing that could end the directive or the policy. An IPv6 loopback host cannot be written as a
 * CSP source at all.
 */
export function formActionOrigin(redirectUri: string): string | undefined {
  const url = parseUrl(redirectUri);
  if (url === undefined || url.username !== "" || url.password !== "") return undefined;
  const host = url.hostname;
  const accepted =
    (url.protocol === "https:" && DNS_HOST.test(host) && !IPV4.test(host)) ||
    (url.protocol === "http:" && (host === "localhost" || LOOPBACK_IPV4.test(host)));
  return accepted ? url.origin : undefined;
}

function resourceOf(resource: string | undefined, config: Config): { kind: ResourceKind; url: string } {
  const origin = apiOrigin(config);
  if (resource === `${origin}/mcp`) return { kind: "mcp", url: resource };
  if (resource === `${origin}/v1`) return { kind: "v1", url: resource };
  // The library binds every request to one of the two resources it was given (oauth.ts).
  throw new Error("an authorization request for a resource this Worker does not serve");
}

/** `GET`: the checks of design.md section 7 in its order, then a new consent transaction and the page. */
async function begin(request: Request, url: URL, helpers: OAuthHelpers, config: Config): Promise<ConsentAnswer> {
  // OAUTH-6: a client document on this deployment's hosts could be a public artifact; it is never fetched.
  const clientId = parseUrl(url.searchParams.get("client_id") ?? "");
  if (clientId?.protocol === "https:" && isDeploymentHost(clientId.hostname, config)) {
    refused("client_on_deployment");
    return errorAnswer("client_on_deployment", 400);
  }
  // OAUTH-2: an artifact page on this deployment's hosts could read the code. Checked before the library, so not even
  // an error is redirected there.
  const redirect = parseUrl(url.searchParams.get("redirect_uri") ?? "");
  if (redirect !== undefined && isDeploymentHost(redirect.hostname, config)) {
    refused("redirect_on_deployment");
    return errorAnswer("redirect_on_deployment", 400);
  }
  let authRequest: AuthRequest;
  try {
    authRequest = await helpers.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    // A redirect only to a redirect URI the library validated against the client's registered ones.
    if (error.redirectTo !== undefined) {
      refused("request_redirected", oauthCode(error.code));
      return redirectAnswer(error.redirectTo, 302);
    }
    refused("request_invalid", oauthCode(error.code));
    return errorAnswer("request", 400);
  }
  // OAUTH-2: the library requires a challenge only from public clients; every grant here holds an S256 one.
  if (authRequest.codeChallenge === undefined || authRequest.codeChallengeMethod !== "S256") {
    refused("pkce_required", "invalid_request");
    return redirectAnswer(
      authorizationErrorRedirect(
        authRequest,
        "invalid_request",
        "A code_challenge with code_challenge_method S256 is required",
      ),
      302,
    );
  }
  const formAction = formActionOrigin(authRequest.redirectUri);
  if (formAction === undefined) {
    refused("redirect_form");
    return errorAnswer("redirect_form", 400);
  }
  const resource = resourceOf(authRequest.resource, config);
  // Described first: a client that cannot be looked up leaves no transaction behind.
  const description = await helpers.describeConsent(authRequest);
  const transaction = await helpers.beginConsent(authRequest);
  const page = consentPage({
    clientName: description.clientName,
    clientDomain: description.clientDomain,
    redirectHost: description.redirectHost,
    loopback: description.redirectIsLoopback,
    resource,
    publisher: proposedPublisher(description.clientName),
    handle: transaction.handle,
  });
  return { response: htmlAnswer(200, page.text, transaction.headers), formAction };
}

/** A revocation of an earlier grant failed: no code is sent. */
class ReplacementFailed extends Error {
  override readonly name = "ReplacementFailed";
}

/**
 * OAUTH-5: approving replaces the grants the client holds for the resource; for a CIMD client, whose client ID every
 * installation shares, only those from the same redirect URI, port included. Each is revoked through the library's
 * `revokeGrant` over the wrapper, so its revocation record is written before it is deleted, as `DELETE /v1/grants/{id}`
 * does; the library's own replacement ignores a failed deletion. Each page of the listing is read under the KV-read
 * timeout (RES-2); the revocations' writes have none, since a write that timed out could still apply.
 */
async function replaceGrants(
  helpers: OAuthHelpers,
  request: AuthRequest,
  cimd: boolean,
  kvReadMs: number,
): Promise<void> {
  const replaced: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await withTimeout(helpers.listUserGrants(OWNER, cursor === undefined ? {} : { cursor }), kvReadMs);
    for (const grant of page.items) {
      if (grant.clientId !== request.clientId || grant.resource !== request.resource) continue;
      if (cimd && grant.redirectUri !== request.redirectUri) continue;
      replaced.push(grant.id);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  for (const id of replaced) {
    try {
      await helpers.revokeGrant(id, OWNER);
    } catch (error) {
      logEvent("grant.revoke_failed", { ...(isGrantId(id) ? { grant: id } : {}), error: errorName(error) });
      throw new ReplacementFailed();
    }
  }
}

/** The one value of `name` in `form`; undefined when it is missing or repeated. */
function single(form: URLSearchParams, name: string): string | undefined {
  const values = form.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

/** `POST`: the consent form. Deny ends the transaction; Allow ends it with a grant and a code. */
async function decide(
  request: Request,
  helpers: OAuthHelpers,
  config: Config,
  deps: ConsentDeps,
): Promise<ConsentAnswer> {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    refused("form_invalid");
    return errorAnswer("form", 400);
  }
  const body = await readBytes(request, CONSENT_FORM_BYTES);
  if (!body.ok) {
    refused("form_invalid");
    return errorAnswer("form", body.reason === "too_large" ? 413 : 400);
  }
  const form = new URLSearchParams(new TextDecoder().decode(body.value));
  const decision = single(form, "decision");
  // The library refuses a missing handle as a transaction this browser did not start.
  const handle = single(form, "handle") ?? "";
  if (decision === "deny") {
    const denied = await helpers.denyConsent(request, handle);
    refused("denied");
    return redirectAnswer(denied.redirectTo, 303, denied.headers);
  }
  if (decision !== "approve") {
    refused("form_invalid");
    return errorAnswer("form", 400);
  }
  // Checked before the transaction is opened, so it stays usable: going back and correcting the name works.
  const publisher = single(form, "publisher");
  if (publisher === undefined || !isTokenName(publisher)) {
    refused("publisher_invalid");
    return errorAnswer("publisher", 400);
  }
  const approved = await helpers.approveConsent(request, handle);
  const description = await helpers.describeConsent(approved.request);
  const cimd = description.clientDomain !== undefined;
  await replaceGrants(helpers, approved.request, cimd, deps.kvReadMs);
  const resource = resourceOf(approved.request.resource, config);
  const { redirectTo } = await helpers.completeAuthorization({
    request: approved.request,
    userId: OWNER,
    // For listing grants (design.md section 8); the library describes a client without a name by its client ID.
    metadata: {
      publisher,
      clientName: description.clientName === approved.request.clientId ? null : description.clientName,
      redirectHost: description.redirectHost,
    },
    // No scopes are checked: a grant records the ones the client asked for.
    scope: approved.request.scope,
    props: { publisher },
    // Replaced above, where a failed revocation fails the approval.
    revokeExistingGrants: false,
  });
  const grant = grantOf(new URL(redirectTo).searchParams.get("code") ?? "")?.id ?? "";
  logEvent("grant.created", {
    publisher,
    ...(isGrantId(grant) ? { grant } : {}),
    resource: resource.kind,
    client: cimd ? "cimd" : "dcr",
  });
  return redirectAnswer(redirectTo, 303, approved.headers);
}

/**
 * Serves `/oauth/authorize` for a `GET` or `POST` that passed Access, in a configuration with OAuth on; `kv` is
 * `OAUTH_KV`. A refusal the library makes is an error page or a redirect as design.md section 7's table says; any
 * other failure is the 503 error page when a KV call, the grant listing's wait or a replaced grant's revocation
 * failed, and the 500 one otherwise, logged by its class only.
 */
export async function serveConsent(
  request: Request,
  url: URL,
  env: Env,
  kv: KVNamespace,
  config: Config,
  deps: ConsentDeps,
): Promise<ConsentAnswer> {
  const recording: RecordingKv = recordingKv(kv, deps.now);
  try {
    const helpers = authorizationServer(config).getOAuthApi({ ...env, OAUTH_KV: recording.kv });
    return request.method === "POST"
      ? await decide(request, helpers, config, deps)
      : await begin(request, url, helpers, config);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      refused("transaction_invalid", oauthCode(error.code));
      return errorAnswer("transaction", 400);
    }
    if (error instanceof CimdFetchError) {
      refused("client_unverifiable");
      return errorAnswer("client_unverifiable", 400);
    }
    if (error instanceof ReplacementFailed) return errorAnswer("unavailable", 503);
    // DATA-1: the class of the error only, never its message.
    logEvent("request.failed", { error: errorName(error), host: "app" });
    return recording.failed() || error instanceof TimeoutError
      ? errorAnswer("unavailable", 503)
      : errorAnswer("internal", 500);
  }
}
