// OAuth helpers for the Worker's tests: a registered client, the owner's browser on the consent page, an approval
// through the library's helper standing in for the consent page where a test is not about it, the token requests, the
// use of an access token, and a KV namespace with failures, holds and barriers.
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";

import { parseConfig } from "./config.ts";
import { elements, parseHtml } from "./gallery/test-html.ts";
import { authorizationServer, type OAuthEnv } from "./oauth.ts";
import { recordingKv } from "./revocation.ts";
import { API, APP_AUD, APP_HOST, never, sha256Text, stringAt, TOKENS, type World } from "./test-support.ts";

export const METADATA_PATH = "/.well-known/oauth-authorization-server";
export const TOKEN_URL = `${API}/oauth/token`;
export const REGISTER_URL = `${API}/oauth/register`;
export const REDIRECT = "http://127.0.0.1:33418/callback";
export const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
export const VERIFIER = "verifier-0123456789-0123456789-0123456789-0123456789";
export const AUTHORIZE = `https://${APP_HOST}/oauth/authorize`;

export function oauthKv(): KVNamespace {
  if (env.OAUTH_KV === undefined) throw new Error("the test configuration binds OAUTH_KV");
  return env.OAUTH_KV;
}

export function serverOf(world: World): OAuthAuthorizationServer<OAuthEnv> {
  const parsed = parseConfig(world.env);
  if (!parsed.ok) throw new Error("invalid test configuration");
  return authorizationServer(parsed.config);
}

/** The library's helpers over `OAUTH_KV` through the recording wrapper, as the Worker's own callers get them. */
export function helpers(world: World) {
  return serverOf(world).getOAuthApi({ OAUTH_KV: recordingKv(oauthKv(), () => Date.now()).kv });
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export async function register(world: World, metadata: Record<string, unknown> = {}): Promise<string> {
  const response = await world.fetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      client_name: "test client",
      ...metadata,
    }),
  });
  if (response.status !== 201) throw new Error(`registration answered ${response.status}: ${await response.text()}`);
  return stringAt(await response.json(), "client_id");
}

/**
 * The owner's browser: it carries the app audience's Access JWT (as Access adds it) and keeps the cookies the endpoint
 * sets, as a browser does for its host.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly world: World) {}

  private remember(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      if (/;\s*Max-Age=0\b/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(separator + 1));
    }
  }

  async headers(jwt: string | null | undefined): Promise<Headers> {
    const headers = new Headers();
    const token = jwt === undefined ? await this.world.jwt({ aud: APP_AUD }) : jwt;
    if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
    if (this.cookies.size > 0) {
      headers.set("Cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    return headers;
  }

  async open(search: URLSearchParams, options: { jwt?: string | null } = {}): Promise<Response> {
    const response = await this.world.fetch(`${AUTHORIZE}?${search.toString()}`, {
      headers: await this.headers(options.jwt),
    });
    this.remember(response);
    return response;
  }

  async post(form: Record<string, string> | string, options: { jwt?: string | null } = {}): Promise<Response> {
    const headers = await this.headers(options.jwt);
    headers.set("Content-Type", FORM["Content-Type"]);
    const response = await this.world.fetch(AUTHORIZE, {
      method: "POST",
      headers,
      body: typeof form === "string" ? form : new URLSearchParams(form).toString(),
    });
    this.remember(response);
    return response;
  }
}

/** The consent page's handle; fails the test when the answer is not the page. */
export async function handleOf(response: Response): Promise<string> {
  if (response.status !== 200) throw new Error(`the endpoint answered ${response.status}: ${await response.text()}`);
  const input = elements(await parseHtml(await response.text())).find(
    (node) => node.attributes.get("name") === "handle",
  );
  const handle = input?.attributes.get("value");
  if (handle === undefined) throw new Error("no handle on the page");
  return handle;
}

/** The query of a redirect to the client. */
export function redirectQuery(response: Response): Record<string, string> {
  const location = response.headers.get("Location");
  if (location === null) throw new Error(`no redirect: ${response.status}`);
  const url = new URL(location);
  return { target: `${url.origin}${url.pathname}`, ...Object.fromEntries(url.searchParams) };
}

/**
 * Stands in for the consent page: an approval by the owner, through the library's helper, of a request for `resource`
 * (none for a client that names none), storing `metadata` and `props` with the grant. Returns the code.
 */
export async function authorize(
  world: World,
  clientId: string,
  resource: string | null = `${API}/mcp`,
  metadata: Record<string, unknown> = {},
  props: Record<string, unknown> = { publisher: "test" },
): Promise<string> {
  const { redirectTo } = await helpers(world).completeAuthorization({
    request: {
      responseType: "code",
      clientId,
      redirectUri: REDIRECT,
      scope: [],
      state: "state",
      codeChallenge: await challengeOf(VERIFIER),
      codeChallengeMethod: "S256",
      ...(resource === null ? {} : { resource }),
    },
    userId: "owner",
    metadata,
    scope: [],
    props,
    revokeExistingGrants: false,
  });
  const code = new URL(redirectTo).searchParams.get("code");
  if (code === null) throw new Error("no code");
  return code;
}

export function tokenRequest(
  world: World,
  params: Record<string, string> | string,
  headers: Record<string, string> = {},
) {
  return world.fetch(TOKEN_URL, {
    method: "POST",
    headers: { ...FORM, ...headers },
    body: typeof params === "string" ? params : new URLSearchParams(params).toString(),
  });
}

export type Tokens = { access_token: string; refresh_token: string; expires_in: number };

export async function tokensOf(response: Response): Promise<Tokens> {
  if (response.status !== 200) throw new Error(`token endpoint answered ${response.status}: ${await response.text()}`);
  return response.json();
}

export const exchange = (world: World, clientId: string, code: string) =>
  tokenRequest(world, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });

export const refresh = (world: World, clientId: string, refreshToken: string) =>
  tokenRequest(world, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });

/** A client, its grant's ID and the tokens of the code exchange, for `resource` and as `publisher`. */
export async function signedIn(
  world: World,
  resource = `${API}/mcp`,
  publisher = "test",
): Promise<{ clientId: string; grantId: string; tokens: Tokens }> {
  const clientId = await register(world);
  const code = await authorize(world, clientId, resource, {}, { publisher });
  const tokens = await tokensOf(await exchange(world, clientId, code));
  return { clientId, grantId: code.split(":")[1] ?? "", tokens };
}

/** The KV key of an access token's record, as the library reads it: its user, grant and SHA-256. */
export async function tokenKey(token: string): Promise<string> {
  const [user = "", grant = ""] = token.split(":");
  return `token:${user}:${grant}:${await sha256Text(token)}`;
}

/** Ends an access token as its hour would: its record's expiry, which the library checks, moves into the past. */
export async function expire(token: string): Promise<void> {
  const key = await tokenKey(token);
  const record = await oauthKv().get<Record<string, unknown>>(key, "json");
  if (record === null) throw new Error("no record for the token");
  await oauthKv().put(key, JSON.stringify({ ...record, expiresAt: Math.floor(Date.now() / 1000) - 1 }));
}

export type ResourceRoute = "mcp" | "v1";

/** A request with `token` (an API token by default) to the route of `resource`: a tool listing, or a listing. */
export function useToken(world: World, resource: ResourceRoute, token: string = TOKENS.codex): Promise<Response> {
  if (resource === "v1") return world.api("GET", "/v1/artifacts", { token });
  return world.api("POST", "/mcp", {
    token,
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

export type Fault = "throw" | "hang" | Promise<void>;

/** `base` with each call `pick` names failed, held forever, or held until the promise settles. */
export function faulty(
  base: KVNamespace,
  pick: (method: string, key: string) => Fault | undefined,
  message = "KV-FAILURE",
) {
  return new Proxy(base, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const fault = pick(String(property), typeof args[0] === "string" ? args[0] : "");
        if (fault === "throw") throw new Error(message);
        if (fault === "hang") return never();
        if (fault !== undefined) await fault;
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });
}

export const seconds = () => Math.floor(Date.now() / 1000);

export async function errorOf(response: Response): Promise<{ status: number; headers: string[][]; body: unknown }> {
  const headers = [...response.headers].toSorted(([a], [b]) => a.localeCompare(b));
  return { status: response.status, headers, body: await response.json() };
}
