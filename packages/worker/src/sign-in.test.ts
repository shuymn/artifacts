// The whole local sign-in (design.md section 7, "Testing OAuth"): PL-34 with the MCP SDK's client against the Worker,
// discovering from the 401, registering, signing in on the consent page, calling tools and refreshing; the same for a
// REST client of `/v1`; and PL-42 over KV at each step. Access is stubbed with the test key set as everywhere else; the
// test plays the owner's browser with an app-audience JWT, and every other step runs through the Worker.
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OWNER } from "./grants.ts";
import {
  AUTHORIZE,
  Browser,
  challengeOf,
  expire,
  handleOf,
  oauthKv,
  REDIRECT,
  redirectQuery,
  REGISTER_URL,
  tokenKey,
  tokenRequest,
  tokensOf,
  TOKEN_URL,
  useToken,
  VERIFIER,
  type Tokens,
} from "./oauth-test-support.ts";
import {
  API,
  APP_HOST,
  callTool,
  clearOAuthStorage,
  sha256Text,
  stringAt,
  toolOutcome,
  World,
  type McpVersion,
  type PublishJson,
} from "./test-support.ts";

beforeEach(async () => {
  await clearOAuthStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MCP = `${API}/mcp`;
const V1 = `${API}/v1`;

/** An MCP client's OAuth state, as a client keeps it: DCR, a loopback redirect, and what the SDK saves. */
class ClientProvider implements OAuthClientProvider {
  info: StoredOAuthClientInformation | undefined;
  saved: StoredOAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;

  get redirectUrl(): string {
    return REDIRECT;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "SDK Client",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.info;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.info = info;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.saved;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

function accessToken(provider: ClientProvider): string {
  const token = provider.saved?.access_token;
  if (token === undefined) throw new Error("the client holds no token");
  return token;
}

/** The SDK's client for `version`, as `mcpClient` builds it, connected through `transport`. */
async function connect(version: McpVersion, transport: StreamableHTTPClientTransport): Promise<Client> {
  const client = new Client(
    { name: "artifacts-test", version: "0.0.0" },
    version === "2026-07-28"
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : { supportedProtocolVersions: [version] },
  );
  await client.connect(transport);
  return client;
}

/** A `fetch` into the Worker that records each request's method, URL and status. */
function recordingFetch(world: World): { fetch: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await world.fetch(request);
    requests.push(`${request.method} ${request.url} ${response.status}`);
    return response;
  };
  return { fetch, requests };
}

/** The owner allows the request the client sent the browser to, as `publisher`; returns the callback's query. */
async function allow(world: World, authorizationUrl: URL, publisher: string): Promise<URLSearchParams> {
  expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(AUTHORIZE);
  const browser = new Browser(world);
  const handle = await handleOf(await browser.open(authorizationUrl.searchParams));
  const allowed = await browser.post({ handle, decision: "approve", publisher });
  expect(allowed.status).toBe(303);
  const location = allowed.headers.get("Location");
  if (location === null) throw new Error("no redirect");
  expect(location.startsWith(`${REDIRECT}?`)).toBe(true);
  return new URL(location).searchParams;
}

// PL-34, AC-14, OAUTH-1 to OAUTH-3.
describe("PL-34: an MCP client signs in through the Worker", () => {
  it.each<McpVersion>(["2025-06-18", "2025-11-25", "2026-07-28"])(
    "the SDK's client (%s) discovers, registers, signs in, calls tools, and refreshes once its token expires",
    async (version) => {
      const world = new World();
      const provider = new ClientProvider();
      const { fetch, requests } = recordingFetch(world);
      const transport = () => new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider, fetch });

      // 1. A 401 naming the metadata, discovery and DCR; the client sends the browser to the consent page.
      await expect(connect(version, transport())).rejects.toBeInstanceOf(UnauthorizedError);
      expect(requests).toEqual(
        expect.arrayContaining([
          `POST ${MCP} 401`,
          `GET ${API}/.well-known/oauth-protected-resource/mcp 200`,
          `GET ${API}/.well-known/oauth-authorization-server 200`,
          `POST ${REGISTER_URL} 201`,
        ]),
      );
      const authorizationUrl = provider.authorizationUrl;
      if (authorizationUrl === undefined) throw new Error("the client opened no browser");
      expect(authorizationUrl.host).toBe(APP_HOST);
      expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
        client_id: provider.info?.client_id,
        code_challenge_method: "S256",
        resource: MCP,
        redirect_uri: REDIRECT,
      });

      // 2. Consent, then the code exchange with the PKCE verifier.
      const callback = await allow(world, authorizationUrl, "sdk-agent");
      expect(callback.get("iss")).toBe(API);
      const signedIn = transport();
      await signedIn.finishAuth(callback);
      expect(requests.at(-1)).toBe(`POST ${TOKEN_URL} 200`);
      const first = provider.saved;
      if (first?.refresh_token === undefined) throw new Error("no refresh token");

      // 3. Tool calls with the access token; it is refused on REST.
      const client = await connect(version, signedIn);
      expect((await client.listTools()).tools).toHaveLength(9);
      const created = await callTool(client, "create_artifact", {
        title: "t",
        files: [{ path: "index.html", content: "i" }],
      });
      expect(created.ok).toBe(true);
      expect(stringAt(created.value, "version", "published_by")).toBe("sdk-agent");
      const id = stringAt(created.value, "artifact", "id");
      expect((await useToken(world, "v1", first.access_token)).status).toBe(401);

      // 4. Once the access token expires, the next call answers 401, the client refreshes and calls again.
      await expire(first.access_token);
      const listed = await callTool(client, "list_artifacts", {});
      expect(listed.ok).toBe(true);
      const second = provider.saved;
      expect(second?.access_token).not.toBe(first.access_token);
      expect(second?.refresh_token).not.toBe(first.refresh_token);
      expect(requests.filter((line) => line === `POST ${TOKEN_URL} 200`)).toHaveLength(2);

      // 5. A call with the new token.
      const got = toolOutcome(await client.callTool({ name: "get_artifact", arguments: { id } }));
      expect(got.ok).toBe(true);
      expect((await useToken(world, "mcp", accessToken(provider))).status).toBe(200);
      expect((await useToken(world, "mcp", first.access_token)).status).toBe(401);
      await client.close();
    },
  );

  it("binds a sign-in without resource, as 2025-03-26 clients send it, to /mcp", async () => {
    const world = new World();
    const register = await world.fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Old" }),
    });
    const clientId = stringAt(await register.json(), "client_id");
    const search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: "s",
      code_challenge: await challengeOf(VERIFIER),
      code_challenge_method: "S256",
    });
    const callback = await allow(world, new URL(`${AUTHORIZE}?${search.toString()}`), "old-client");
    const tokens = await tokensOf(
      await tokenRequest(world, {
        grant_type: "authorization_code",
        code: stringAt(Object.fromEntries(callback), "code"),
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    );
    expect(tokens).toMatchObject({ resource: MCP });
    expect((await useToken(world, "mcp", tokens.access_token)).status).toBe(200);
    expect((await useToken(world, "v1", tokens.access_token)).status).toBe(401);
  });
});

describe("a REST client signs in to /v1", () => {
  it("discovers from the 401, registers, signs in, publishes, refreshes, and publishes with the new token", async () => {
    const world = new World();
    // 1. The 401 names /v1's metadata, which names the authorization server, whose metadata names the endpoints.
    const refused = await world.api("GET", "/v1/artifacts", { token: null });
    expect(refused.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(refused.headers.get("WWW-Authenticate") ?? "")?.[1] ?? "";
    expect(metadataUrl).toBe(`${API}/.well-known/oauth-protected-resource/v1`);
    const resource = await (await world.fetch(metadataUrl)).json();
    expect(resource).toMatchObject({ resource: V1, authorization_servers: [API] });
    const server = await (await world.fetch(`${API}/.well-known/oauth-authorization-server`)).json();
    expect(server).toMatchObject({
      issuer: API,
      authorization_endpoint: AUTHORIZE,
      token_endpoint: TOKEN_URL,
      registration_endpoint: REGISTER_URL,
    });

    // 2. DCR, consent with S256 for /v1, and the code exchange.
    const registered = await world.fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "CLI" }),
    });
    const clientId = stringAt(await registered.json(), "client_id");
    const search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: "s",
      code_challenge: await challengeOf(VERIFIER),
      code_challenge_method: "S256",
      resource: V1,
    });
    const callback = await allow(world, new URL(`${AUTHORIZE}?${search.toString()}`), "rest-agent");
    const tokens = await tokensOf(
      await tokenRequest(world, {
        grant_type: "authorization_code",
        code: stringAt(Object.fromEntries(callback), "code"),
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    );
    expect(tokens).toMatchObject({ resource: V1 });

    // 3. REST calls with the access token; it is refused on /mcp.
    const created = await world.created({ title: "t", files: { "index.html": "i" } }, tokens.access_token);
    expect(created.version.published_by).toBe("rest-agent");
    expect((await useToken(world, "mcp", tokens.access_token)).status).toBe(401);

    // 4. A refresh, and a call with the new token.
    const refreshed = await tokensOf(
      await tokenRequest(world, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }),
    );
    const updated = await world.update(created.artifact.id, { base_version: 1 }, refreshed.access_token);
    expect(updated.status).toBe(201);
    expect((await updated.json<PublishJson>()).version.published_by).toBe("rest-agent");
  });
});

/** Every key, value and key metadata in KV, as text. */
async function kvText(): Promise<string> {
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauthKv().list(cursor === undefined ? {} : { cursor });
    for (const key of page.keys) {
      const { value, metadata } = await oauthKv().getWithMetadata(key.name, "text");
      parts.push(key.name, value ?? "", JSON.stringify(key.metadata ?? null), JSON.stringify(metadata ?? null));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return parts.join("\n");
}

/** A credential, and the secret part of one of the library's form. */
const forms = (credential: string) => [credential, credential.split(":")[2] ?? credential];

async function expectNotInKv(credentials: readonly string[]): Promise<void> {
  const text = await kvText();
  for (const credential of credentials.flatMap(forms)) expect(text).not.toContain(credential);
}

async function grantRecord(grantId: string): Promise<Record<string, unknown>> {
  const grant = await oauthKv().get<Record<string, unknown>>(`grant:${OWNER}:${grantId}`, "json");
  if (grant === null) throw new Error("no grant");
  return grant;
}

// PL-42, OAUTH-4.
describe("PL-42: KV holds no credential in clear", () => {
  it("at each step of a confidential client's sign-in, with each record live before the search", async () => {
    const world = new World();
    // A confidential client's registration: its secret.
    const registered = await world.fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "client_secret_basic",
        client_name: "Confidential",
      }),
    });
    const body = await registered.json();
    const clientId = stringAt(body, "client_id");
    const secret = stringAt(body, "client_secret");
    expect(await oauthKv().get(`client:${clientId}`)).not.toBeNull();
    await expectNotInKv([secret]);
    const basic = { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}` };

    // A pending consent transaction: its handle.
    const browser = new Browser(world);
    const search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: "s",
      code_challenge: await challengeOf(VERIFIER),
      code_challenge_method: "S256",
      resource: MCP,
    });
    const handle = await handleOf(await browser.open(search));
    expect((await oauthKv().list({ prefix: "transaction:" })).keys).toHaveLength(1);
    await expectNotInKv([handle]);

    // An issued code not yet exchanged: the code and its verifier.
    const allowed = await browser.post({ handle, decision: "approve", publisher: "confidential" });
    const code = stringAt(redirectQuery(allowed), "code");
    const grantId = code.split(":")[1] ?? "";
    expect((await grantRecord(grantId)).authCodeId).toEqual(expect.any(String));
    await expectNotInKv([code, VERIFIER]);

    // The tokens after the exchange.
    const exchanged: Tokens = await tokensOf(
      await tokenRequest(
        world,
        { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER },
        basic,
      ),
    );
    expect(await oauthKv().get(await tokenKey(exchanged.access_token))).not.toBeNull();
    expect((await grantRecord(grantId)).refreshTokenId).toBe(await sha256Text(exchanged.refresh_token));
    await expectNotInKv([exchanged.access_token, exchanged.refresh_token, code, VERIFIER, secret]);

    // After a refresh: both new tokens, and the previous refresh token, valid until the new one is used.
    const refreshed: Tokens = await tokensOf(
      await tokenRequest(world, { grant_type: "refresh_token", refresh_token: exchanged.refresh_token }, basic),
    );
    expect(await oauthKv().get(await tokenKey(refreshed.access_token))).not.toBeNull();
    const grant = await grantRecord(grantId);
    expect(grant.refreshTokenId).toBe(await sha256Text(refreshed.refresh_token));
    expect(grant.previousRefreshTokenId).toBe(await sha256Text(exchanged.refresh_token));
    await expectNotInKv([
      refreshed.access_token,
      refreshed.refresh_token,
      exchanged.access_token,
      exchanged.refresh_token,
      secret,
    ]);
  });
});
