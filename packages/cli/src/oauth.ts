/**
 * The OAuth protocol of `login` and of a refresh (design.md section 9), through `oauth4webapi`: the metadata checks,
 * dynamic registration, the check of a kept client, the authorization request with PKCE S256, the callback's `state`
 * and `iss` checks, the code exchange and the refresh. Every request goes to the configured origin only, follows no
 * redirect and waits at most 30 s; the browser alone opens the authorization endpoint, with no credential.
 */
import { randomBytes } from "node:crypto";

import * as oauth from "oauth4webapi";

import { causeCode, isTimeout, type Fetch } from "./api.ts";
import { TOKEN_FORM } from "./config.ts";
import { CliError } from "./errors.ts";
import type { Tokens } from "./store.ts";

/** Every request of `login`, `logout` and a refresh. */
export const OAUTH_REQUEST_MS = 30_000;

/** The redirect URI the CLI registers; the library accepts it on any loopback port (RFC 8252 section 7.3). */
export const REGISTERED_REDIRECT = "http://127.0.0.1/callback";

const CLIENT_METADATA = {
  client_name: "artifacts CLI",
  redirect_uris: [REGISTERED_REDIRECT],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
};

/**
 * The token endpoint's refusal, by its HTTP status and RFC 6749 error code. Only the status the server gives each code
 * counts as that code: another, such as an intermediary's 403 with the same body, is a failure that changes nothing.
 */
export class OAuthRefusal extends CliError {
  override readonly name: string = "OAuthRefusal";
  readonly error: string;
  readonly status: number;

  constructor(what: string, error: string, status: number) {
    super(`${what} was refused (${status} ${error})`);
    this.error = error;
    this.status = status;
  }

  /** The server does not know the client: 401 `invalid_client`. */
  get unknownClient(): boolean {
    return this.status === 401 && this.error === "invalid_client";
  }

  /** The server refuses the code or the refresh token: 400 `invalid_grant`. */
  get refusedGrant(): boolean {
    return this.status === 400 && this.error === "invalid_grant";
  }
}

type Options = {
  readonly [oauth.customFetch]: (url: string, init: oauth.CustomFetchOptions<string, unknown>) => Promise<Response>;
  readonly [oauth.allowInsecureRequests]: boolean;
  readonly signal: () => AbortSignal;
};

/** The authorization server of `origin`, checked as section 9 requires. */
export type Server = {
  readonly origin: string;
  readonly as: oauth.AuthorizationServer;
  readonly options: Options;
  readonly timeoutMs: number;
};

function parseUrl(value: unknown): URL | undefined {
  return typeof value === "string" ? (URL.parse(value) ?? undefined) : undefined;
}

/**
 * The `fetch` every request of the library goes through: only to `origin`, and a redirect answer fails the request
 * instead of being followed.
 */
function guarded(origin: string, fetch: Fetch): Options[typeof oauth.customFetch] {
  return async (url, init) => {
    const target = new URL(url);
    if (target.origin !== origin) {
      throw new CliError(`refused to send a request to ${target.origin}, which is not ARTIFACTS_API_URL's origin`);
    }
    const { body } = init;
    if (body !== undefined && typeof body !== "string" && !(body instanceof URLSearchParams)) {
      throw new CliError("the OAuth library sent a body of an unexpected kind");
    }
    const sent: RequestInit = { method: init.method, headers: init.headers, redirect: "manual" };
    if (body !== undefined) sent.body = body;
    if (init.signal !== undefined) sent.signal = init.signal;
    const response = await fetch(url, sent);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(
        `${target.origin}${target.pathname} answered with a redirect, which artifacts does not follow`,
      );
    }
    return response;
  };
}

function optionsFor(origin: string, fetch: Fetch, timeoutMs: number): Options {
  return {
    [oauth.customFetch]: guarded(origin, fetch),
    // ARTIFACTS_API_URL takes http for loopback hosts only (config.ts).
    [oauth.allowInsecureRequests]: origin.startsWith("http:"),
    signal: () => AbortSignal.timeout(timeoutMs),
  };
}

/**
 * Runs one step of the protocol, turning the library's failures into one message each. Only the library's own message
 * or the server's error code is kept: a response body can carry anything.
 */
async function step<T>(what: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof oauth.ResponseBodyError) throw new OAuthRefusal(what, error.error, error.status);
    if (error instanceof oauth.WWWAuthenticateChallengeError) throw new CliError(`${what} answered ${error.status}`);
    if (error instanceof oauth.OperationProcessingError || error instanceof oauth.UnsupportedOperationError) {
      throw new CliError(`${what}: ${error.message}`);
    }
    if (isTimeout(error)) throw new CliError(`${what} got no answer within ${timeoutMs / 1000} s`);
    throw new CliError(`${what} got no answer${causeCode(error)}`);
  }
}

/**
 * The authorization server metadata of `origin`: its `issuer` must be the origin (the library compares it, RFC 8414
 * section 3.3), and its token and registration endpoints must be on it. The authorization endpoint is opened by the
 * browser and receives no credential; it must be `https`, or `http` when the origin is.
 */
export async function authorizationServer(origin: string, fetch: Fetch, timeoutMs: number): Promise<Server> {
  const options = optionsFor(origin, fetch, timeoutMs);
  const issuer = new URL(origin);
  const as = await step("the authorization server metadata", timeoutMs, async () =>
    oauth.processDiscoveryResponse(issuer, await oauth.discoveryRequest(issuer, { ...options, algorithm: "oauth2" })),
  );
  for (const name of ["token_endpoint", "registration_endpoint"] as const) {
    if (parseUrl(as[name])?.origin !== origin) {
      throw new CliError(`the authorization server metadata puts its ${name} outside ${origin}`);
    }
  }
  const authorize = parseUrl(as.authorization_endpoint);
  if (authorize === undefined || !(authorize.protocol === "https:" || authorize.protocol === issuer.protocol)) {
    throw new CliError("the authorization server metadata has no https authorization_endpoint");
  }
  return { origin, as, options, timeoutMs };
}

/**
 * `login`'s discovery: the protected resource metadata of `<origin>/v1` must name that resource (the library compares
 * it) and the origin as its one authorization server, whose metadata `authorizationServer` then checks.
 */
export async function discover(origin: string, fetch: Fetch, timeoutMs: number): Promise<Server> {
  const resource = new URL(`${origin}/v1`);
  const options = optionsFor(origin, fetch, timeoutMs);
  const metadata = await step("the protected resource metadata", timeoutMs, async () =>
    oauth.processResourceDiscoveryResponse(resource, await oauth.resourceDiscoveryRequest(resource, options)),
  );
  const servers: unknown = metadata.authorization_servers;
  const [server] = Array.isArray(servers) ? servers : [];
  if (!Array.isArray(servers) || servers.length !== 1 || parseUrl(server)?.href !== new URL(origin).href) {
    throw new CliError(`the protected resource metadata does not name ${origin} as its one authorization server`);
  }
  return authorizationServer(origin, fetch, timeoutMs);
}

const clientOf = (clientId: string): oauth.Client => ({ client_id: clientId, token_endpoint_auth_method: "none" });

/** Registers the CLI through DCR and returns its client ID. */
export async function register(server: Server): Promise<string> {
  const client = await step("the client registration", server.timeoutMs, async () =>
    oauth.processDynamicClientRegistrationResponse(
      await oauth.dynamicClientRegistrationRequest(server.as, CLIENT_METADATA, server.options),
    ),
  );
  if (!TOKEN_FORM.test(client.client_id)) throw new CliError("the client registration returned an unusable client ID");
  return client.client_id;
}

/**
 * Whether the server still knows `clientId`, asked without any effect: a code exchange with a made-up code of the
 * library's form, `owner:<grant ID>:<secret>`, whose 16-character grant ID names no grant. The library looks the client
 * up before the code, so an unknown client answers 401 `invalid_client` and a known one 400 `invalid_grant`. Anything
 * else fails, so the caller keeps the client ID.
 */
export async function knowsClient(server: Server, clientId: string): Promise<boolean> {
  const client = clientOf(clientId);
  const parameters = {
    code: `owner:${randomBytes(12).toString("base64url")}:${randomBytes(24).toString("base64url")}`,
    redirect_uri: REGISTERED_REDIRECT,
    code_verifier: oauth.generateRandomCodeVerifier(),
  };
  const what = "the check of the stored client ID";
  try {
    await step(what, server.timeoutMs, async () =>
      oauth.processGenericTokenEndpointResponse(
        server.as,
        client,
        await oauth.genericTokenEndpointRequest(
          server.as,
          client,
          oauth.None(),
          "authorization_code",
          parameters,
          server.options,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof OAuthRefusal && error.unknownClient) return false;
    if (error instanceof OAuthRefusal && error.refusedGrant) return true;
    throw error;
  }
  throw new CliError(`${what} was answered with tokens for a made-up code`);
}

/** One sign-in's secrets, and the authorization URL the browser opens. */
export type Authorization = {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
};

export async function authorization(server: Server, clientId: string, redirectUri: string): Promise<Authorization> {
  const state = oauth.generateRandomState();
  const verifier = oauth.generateRandomCodeVerifier();
  const url = new URL(server.as.authorization_endpoint ?? "");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    resource: `${server.origin}/v1`,
  }).toString();
  return { url: url.href, state, verifier, redirectUri };
}

function tokensOf(response: oauth.TokenEndpointResponse, now: number, previousRefresh?: string): Tokens {
  const refreshToken = response.refresh_token ?? previousRefresh;
  if (!TOKEN_FORM.test(response.access_token) || refreshToken === undefined || !TOKEN_FORM.test(refreshToken)) {
    throw new CliError("the token endpoint answered without usable tokens");
  }
  if (typeof response.expires_in !== "number") throw new CliError("the token endpoint answered without expires_in");
  const expires = new Date(now + response.expires_in * 1000).toISOString();
  return { access_token: response.access_token, refresh_token: refreshToken, expires_at: expires };
}

/**
 * Checks the callback's `iss` and `state` and exchanges its code with the PKCE verifier. The `iss` parameter is
 * required whatever the metadata says (RFC 9207): the server always sends it.
 */
export async function exchange(
  server: Server,
  clientId: string,
  sent: Authorization,
  callback: URLSearchParams,
  now: () => number,
): Promise<Tokens> {
  const client = clientOf(clientId);
  let parameters: URLSearchParams;
  try {
    const as = { ...server.as, authorization_response_iss_parameter_supported: true };
    parameters = oauth.validateAuthResponse(as, client, callback, sent.state);
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError) {
      throw new CliError(`the sign-in was not completed (${error.error})`);
    }
    const message = error instanceof Error ? error.message : "invalid";
    throw new CliError(`the sign-in callback was refused: ${message}`);
  }
  const response = await step("the code exchange", server.timeoutMs, async () =>
    oauth.processAuthorizationCodeResponse(
      server.as,
      client,
      await oauth.authorizationCodeGrantRequest(
        server.as,
        client,
        oauth.None(),
        parameters,
        sent.redirectUri,
        sent.verifier,
        server.options,
      ),
    ),
  );
  return tokensOf(response, now());
}

/** Refreshes `tokens`; the server rotates the refresh token. */
export async function refresh(server: Server, clientId: string, tokens: Tokens, now: () => number): Promise<Tokens> {
  const client = clientOf(clientId);
  const response = await step("the refresh", server.timeoutMs, async () =>
    oauth.processRefreshTokenResponse(
      server.as,
      client,
      await oauth.refreshTokenGrantRequest(server.as, client, oauth.None(), tokens.refresh_token, server.options),
    ),
  );
  return tokensOf(response, now(), tokens.refresh_token);
}
