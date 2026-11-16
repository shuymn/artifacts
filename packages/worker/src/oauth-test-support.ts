// OAuth helpers for the Worker's tests: a registered client, an approval through the library's helper standing in for
// the consent page where a test is not about it, the token requests, and a KV namespace with failures, holds and
// barriers.
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";

import { parseConfig } from "./config.ts";
import { authorizationServer, type OAuthEnv } from "./oauth.ts";
import { recordingKv } from "./revocation.ts";
import { API, never, stringAt, type World } from "./test-support.ts";

export const METADATA_PATH = "/.well-known/oauth-authorization-server";
export const TOKEN_URL = `${API}/oauth/token`;
export const REGISTER_URL = `${API}/oauth/register`;
export const REDIRECT = "http://127.0.0.1:33418/callback";
export const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
export const VERIFIER = "verifier-0123456789-0123456789-0123456789-0123456789";

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
 * Stands in for the consent page: an approval by the owner, through the library's helper, of a request for `resource`
 * (none for a client that names none), storing `metadata` with the grant. Returns the code.
 */
export async function authorize(
  world: World,
  clientId: string,
  resource: string | null = `${API}/mcp`,
  metadata: Record<string, unknown> = {},
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
    props: { publisher: "test" },
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

/** A client, its grant's ID and the tokens of the code exchange. */
export async function signedIn(world: World): Promise<{ clientId: string; grantId: string; tokens: Tokens }> {
  const clientId = await register(world);
  const code = await authorize(world, clientId);
  const tokens = await tokensOf(await exchange(world, clientId, code));
  return { clientId, grantId: code.split(":")[1] ?? "", tokens };
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
