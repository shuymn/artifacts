// The OAuth authorization server behind the router (design.md section 7): PL-43 to PL-45, the revocation record's check
// at the token endpoint (OAUTH-5) and the configuration of section 7. The consent page is a later step; here the
// library's `completeAuthorization` stands in for it, called by the test.
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorize,
  errorOf,
  exchange,
  faulty,
  FORM,
  helpers,
  METADATA_PATH,
  oauthKv,
  REDIRECT,
  refresh,
  register,
  REGISTER_URL,
  seconds,
  signedIn,
  tokenRequest,
  tokensOf,
  TOKEN_URL,
} from "./oauth-test-support.ts";
import { OAUTH_ERROR_CATEGORIES, OAUTH_ERROR_CODES } from "./oauth.ts";
import { revocationKey } from "./revocation.ts";
import {
  API,
  API_HOST,
  APP_AUD,
  APP_HOST,
  captureLogs,
  CONTENT_SUFFIX,
  clearOAuthStorage,
  gate,
  isRecord,
  logEvents,
  PUBLIC_SUFFIX,
  TOKENS,
  World,
} from "./test-support.ts";

beforeEach(async () => {
  await clearOAuthStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ORIGIN = { Origin: "https://evil.example.org" };
const ID = "abcdefghijklmnopqrstuvwxyz";

const corsHeaders = (response: Response) =>
  [...response.headers.keys()].filter((name) => name.toLowerCase().startsWith("access-control-"));

// PL-43, HOST-1, ISO-2.
describe("PL-43: the library at the boundary", () => {
  it("calls the library only for the API host's three OAuth paths", async () => {
    const world = new World();
    const fetchSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
    const helperSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "getOAuthApi");
    const validateSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "validateToken");
    const hosts: [string, Record<string, string>][] = [
      [API_HOST, { Authorization: `Bearer ${TOKENS.codex}` }],
      [APP_HOST, { "Cf-Access-Jwt-Assertion": await world.jwt({ aud: APP_AUD }) }],
      [`${ID}${CONTENT_SUFFIX}`, { "Cf-Access-Jwt-Assertion": await world.jwt() }],
      [`${ID}${PUBLIC_SUFFIX}`, {}],
      ["unrelated.example.org", {}],
    ];
    const paths = [
      METADATA_PATH,
      "/oauth/token",
      "/oauth/register",
      "/oauth/authorize",
      "/.well-known/oauth-protected-resource",
      "/mcp",
      "/v1/artifacts",
      "/",
    ];
    for (const [host, headers] of hosts) {
      for (const path of paths) {
        for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) {
          await world.fetch(`https://${host}${path}`, {
            method,
            headers,
            ...(method === "POST" || method === "PUT" ? { body: "x" } : {}),
          });
        }
      }
    }
    const called = fetchSpy.mock.calls.map(([request]) => `${request.method} ${request.url}`);
    expect(called).toEqual([
      `GET ${API}${METADATA_PATH}`,
      `HEAD ${API}${METADATA_PATH}`,
      `POST ${API}/oauth/token`,
      `POST ${API}/oauth/register`,
    ]);
    expect(helperSpy).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("passes the library no binding but its storage", async () => {
    const world = new World();
    const fetchSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
    await world.fetch(`${API}${METADATA_PATH}`);
    await tokenRequest(world, "grant_type=refresh_token");
    expect(fetchSpy.mock.calls.map(([, passed]) => Object.keys(passed))).toEqual([["OAUTH_KV"], ["OAUTH_KV"]]);
  });

  it("answers the app host's OAuth paths of the API host with 404", async () => {
    const world = new World();
    const jwt = await world.jwt({ aud: APP_AUD });
    for (const path of [METADATA_PATH, "/oauth/token", "/oauth/register", "/.well-known/oauth-protected-resource"]) {
      const response = await world.fetch(`https://${APP_HOST}${path}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  });

  it("serves an artifact's files at OAuth paths on its content host and, made public, on its public host", async () => {
    const world = new World();
    const fetchSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
    const files = { "oauth/token": "token file", ".well-known/oauth-authorization-server": "metadata file" };
    const created = await world.created({ title: "t", files: { "index.html": "x", ...files } });
    const id = created.artifact.id;
    for (const [path, body] of Object.entries(files)) {
      const response = await world.content(id, `/${path}`);
      expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 200, body });
    }
    expect((await world.patch(id, { public: true })).status).toBe(200);
    for (const [path, body] of Object.entries(files)) {
      const response = await world.public(id, `/${path}`);
      expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 200, body });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends no Access-Control-* header on any OAuth answer to a request with an Origin", async () => {
    const world = new World();
    const clientId = await register(world);
    const answers = [
      await world.fetch(`${API}${METADATA_PATH}`, { headers: ORIGIN }),
      await world.fetch(`${API}${METADATA_PATH}`, { method: "HEAD", headers: ORIGIN }),
      await world.fetch(REGISTER_URL, {
        method: "POST",
        headers: { ...ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
      }),
      await tokenRequest(world, { grant_type: "refresh_token", refresh_token: "a:b:c", client_id: clientId }, ORIGIN),
      await tokenRequest(world, "grant_type=refresh_token", ORIGIN),
    ];
    expect(answers.map((response) => response.status)).toEqual([200, 200, 201, 400, 401]);
    for (const response of answers) expect(corsHeaders(response)).toEqual([]);
  });

  it("answers 405 to OPTIONS and every other method an API route does not take, before the library or a token", async () => {
    const world = new World();
    const fetchSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
    const allowed: [string, string][] = [
      [METADATA_PATH, "GET, HEAD"],
      ["/oauth/token", "POST"],
      ["/oauth/register", "POST"],
      ["/mcp", "POST"],
      ["/v1/artifacts", "GET, HEAD, POST"],
      [`/v1/artifacts/${ID}`, "GET, HEAD, PATCH, DELETE"],
      [`/v1/artifacts/${ID}/versions`, "GET, HEAD, POST"],
      [`/v1/artifacts/${ID}/versions/1`, "GET, HEAD"],
      [`/v1/artifacts/${ID}/versions/1/files/index.html`, "GET, HEAD"],
    ];
    const preflight = {
      ...ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization",
    };
    for (const [path, allow] of allowed) {
      for (const headers of [preflight, { ...preflight, Authorization: `Bearer ${TOKENS.codex}` }]) {
        const response = await world.fetch(`${API}${path}`, { method: "OPTIONS", headers });
        expect({ path, status: response.status, allow: response.headers.get("Allow") }).toEqual({
          path,
          status: 405,
          allow,
        });
        expect(corsHeaders(response)).toEqual([]);
      }
    }
    for (const [path, method] of [
      [METADATA_PATH, "POST"],
      ["/oauth/token", "GET"],
      ["/oauth/token", "PUT"],
      ["/oauth/register", "GET"],
      ["/oauth/register", "DELETE"],
    ] as const) {
      const response = await world.fetch(`${API}${path}`, { method, ...(method === "POST" ? { body: "x" } : {}) });
      expect({ path, method, status: response.status }).toEqual({ path, method, status: 405 });
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // A path no route takes has no methods to name: OPTIONS there answers 404.
    expect((await world.fetch(`${API}/nothing`, { method: "OPTIONS" })).status).toBe(404);
  });
});

/** A body of `total` bytes: `before`, padding, `after`. */
const padded = (before: string, after: string) => (total: number) =>
  `${before}${"a".repeat(total - before.length - after.length)}${after}`;

/** `text` as a stream, so the request has no `Content-Length`. */
function chunked(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 1_000) controller.enqueue(bytes.slice(i, i + 1_000));
      controller.close();
    },
  });
}

// PL-44, RES-1.
describe("PL-44: OAuth bodies are counted before the library reads them", () => {
  // Section 6's bounds, written out so that a change of the constants fails.
  const BOUNDS: [string, number, (total: number) => string, string][] = [
    ["/oauth/token", 16 * 1024, padded("grant_type=refresh_token&refresh_token=", ""), FORM["Content-Type"]],
    [
      "/oauth/register",
      64 * 1024,
      padded(`{"redirect_uris":["${REDIRECT}"],"client_name":"`, '"}'),
      "application/json",
    ],
  ];

  it.each(BOUNDS)(
    "passes a body of %s at its bound and answers 413 one byte past it",
    async (path, bound, body, type) => {
      const world = new World();
      const fetchSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
      expect(new TextEncoder().encode(body(bound)).byteLength).toBe(bound);
      expect(new Request(`${API}${path}`, { method: "POST", body: chunked("x") }).headers.has("Content-Length")).toBe(
        false,
      );
      for (const stream of [false, true]) {
        fetchSpy.mockClear();
        const at = new Request(`${API}${path}`, {
          method: "POST",
          headers: { "Content-Type": type },
          body: stream ? chunked(body(bound)) : body(bound),
        });
        expect((await world.fetch(at)).status).not.toBe(413);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        fetchSpy.mockClear();
        const past = new Request(`${API}${path}`, {
          method: "POST",
          headers: { "Content-Type": type },
          body: stream ? chunked(body(bound + 1)) : body(bound + 1),
        });
        const response = await world.fetch(past);
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({ error: "invalid_request" });
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    },
  );
});

/** A code or token of the library's form whose grant key, `grant:owner:<grant ID>`, is `bytes` long. */
const credentialWithGrantKey = (bytes: number) => `owner:${"a".repeat(bytes - "grant:owner:".length)}:x`;

// OAUTH-5 at the token endpoint: to a client that authenticated, a grant with a revocation record answers as a grant
// that is gone. Without client authentication the library would answer 401 first; the router answers before it.
describe("OAUTH-5: the revocation record's check before the token endpoint", () => {
  it("refuses a code of a revoked grant as the library refuses an authenticated client's code whose grant is gone", async () => {
    const world = new World();
    const clientId = await register(world);
    const gone = await authorize(world, clientId);
    await oauthKv().delete(`grant:owner:${gone.split(":")[1]}`);
    const library = await errorOf(await exchange(world, clientId, gone));

    const code = await authorize(world, clientId);
    const grantId = code.split(":")[1] ?? "";
    await oauthKv().put(revocationKey(grantId), "2026-11-16T09:00:00.000Z");
    const fetchSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
    const logs = captureLogs();
    const refused = await errorOf(await exchange(world, clientId, code));
    expect(refused).toEqual(library);
    expect(refused.body).toEqual({
      error: "invalid_grant",
      error_description: "Grant not found or authorization code expired",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logEvents(logs.lines)).toEqual([{ event: "oauth.refused", reason: "revoked", grant: grantId }]);
  });

  it("refuses a refresh of a revoked grant as the library refuses an authenticated client's one whose grant is gone", async () => {
    const world = new World();
    const first = await signedIn(world);
    await oauthKv().delete(`grant:owner:${first.grantId}`);
    const library = await errorOf(await refresh(world, first.clientId, first.tokens.refresh_token));

    const second = await signedIn(world);
    await oauthKv().put(revocationKey(second.grantId), "2026-11-16T09:00:00.000Z");
    const fetchSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
    const refused = await errorOf(await refresh(world, second.clientId, second.tokens.refresh_token));
    expect(refused).toEqual(library);
    expect(refused.body).toEqual({ error: "invalid_grant", error_description: "Grant not found" });
    expect(fetchSpy).not.toHaveBeenCalled();
    // The grant itself is still there: only the record refused it.
    expect(await oauthKv().get(`grant:owner:${second.grantId}`)).not.toBeNull();
  });

  it.each(["code exchange", "refresh"] as const)(
    "refuses a %s whose grant key KV would refuse as a grant that is gone, rather than with a 503",
    async (flow) => {
      const world = new World();
      const clientId = await register(world);
      const send = (value: string) =>
        flow === "refresh" ? refresh(world, clientId, value) : exchange(world, clientId, value);
      const fetchSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
      const logs = captureLogs();
      // The library reads `grant:<user>:<grant ID>`: 512 bytes at KV's limit, one more past it.
      const library = await errorOf(await send(credentialWithGrantKey(512)));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(library).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      const refused = await errorOf(await send(credentialWithGrantKey(513)));
      expect(refused).toEqual(library);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // The library's refusal and the router's log the same line.
      const category = flow === "refresh" ? "refresh-token-grant" : "authorization-code-grant";
      expect(logEvents(logs.lines)).toEqual([
        { event: "oauth.refused", code: "invalid_grant", category },
        { event: "oauth.refused", code: "invalid_grant", category },
      ]);
    },
  );

  it.each(["refresh", "code exchange"])("refuses a grant that a %s wrote back after its revocation", async (flow) => {
    const world = new World();
    const clientId = await register(world);
    const code = await authorize(world, clientId);
    const grantId = code.split(":")[1] ?? "";
    const grantKey = `grant:owner:${grantId}`;
    const first = flow === "refresh" ? await tokensOf(await exchange(world, clientId, code)) : undefined;
    // The flow is held at its write of the grant, which follows its read, while the grant is revoked.
    const held = gate();
    const reached = Promise.withResolvers<void>();
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(oauthKv(), (method, key) => {
        if (method !== "put" || key !== grantKey) return undefined;
        reached.resolve();
        return held.promise;
      }),
    };
    const racing =
      first === undefined ? exchange(world, clientId, code) : refresh(world, clientId, first.refresh_token);
    await reached.promise;
    await helpers(world).revokeGrant(grantId, "owner");
    expect(await oauthKv().get(grantKey)).toBeNull();
    held.open();
    const raced = await tokensOf(await racing);
    // The library wrote the grant back after its deletion; only the record still refuses it.
    expect(await oauthKv().get(grantKey)).not.toBeNull();
    world.env = { ...world.env, OAUTH_KV: oauthKv() };
    const after = await refresh(world, clientId, raced.refresh_token);
    expect(after.status).toBe(400);
    expect(await after.json()).toEqual({ error: "invalid_grant", error_description: "Grant not found" });
  });
});

describe("OAUTH-5: revocation at the token endpoint and its failures", () => {
  it("records the grant revoked by RFC 7009 with its refresh token, and leaves it for an access token", async () => {
    const world = new World();
    const kept = await signedIn(world);
    expect((await tokenRequest(world, { token: kept.tokens.access_token, client_id: kept.clientId })).status).toBe(200);
    expect(await oauthKv().get(revocationKey(kept.grantId))).toBeNull();
    await tokensOf(await refresh(world, kept.clientId, kept.tokens.refresh_token));

    const revoked = await signedIn(world);
    const logs = captureLogs();
    const answer = await tokenRequest(world, { token: revoked.tokens.refresh_token, client_id: revoked.clientId });
    expect(answer.status).toBe(200);
    expect(await oauthKv().get(revocationKey(revoked.grantId))).not.toBeNull();
    expect(logEvents(logs.lines)).toEqual([{ event: "grant.revoked", grant: revoked.grantId }]);
  });

  it("answers 503 when a revocation's record cannot be written, leaving the grant, and a retry revokes it", async () => {
    const world = new World();
    const { clientId, grantId, tokens } = await signedIn(world);
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(oauthKv(), (method, key) =>
        method === "put" && key.startsWith("revoked:") ? "throw" : undefined,
      ),
    };
    const logs = captureLogs();
    const failed = await tokenRequest(world, { token: tokens.refresh_token, client_id: clientId });
    expect(await errorOf(failed)).toMatchObject({ status: 503, body: { error: "temporarily_unavailable" } });
    expect(logEvents(logs.lines)).toEqual([{ event: "request.failed", error: "Error", host: "api" }]);
    expect(await oauthKv().get(`grant:owner:${grantId}`)).not.toBeNull();
    world.env = { ...world.env, OAUTH_KV: oauthKv() };
    expect((await tokenRequest(world, { token: tokens.refresh_token, client_id: clientId })).status).toBe(200);
    expect(await oauthKv().get(`grant:owner:${grantId}`)).toBeNull();
    expect(await oauthKv().get(revocationKey(grantId))).not.toBeNull();
  });

  it("answers 503 when the deletion after the record fails; the record already refuses the grant", async () => {
    const world = new World();
    const { clientId, grantId, tokens } = await signedIn(world);
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(oauthKv(), (method, key) =>
        method === "delete" && key.startsWith("grant:") ? "throw" : undefined,
      ),
    };
    captureLogs();
    const failed = await tokenRequest(world, { token: tokens.refresh_token, client_id: clientId });
    expect(failed.status).toBe(503);
    world.env = { ...world.env, OAUTH_KV: oauthKv() };
    expect(await oauthKv().get(`grant:owner:${grantId}`)).not.toBeNull();
    const refused = await refresh(world, clientId, tokens.refresh_token);
    expect(await refused.json()).toEqual({ error: "invalid_grant", error_description: "Grant not found" });
    expect((await tokenRequest(world, { token: tokens.refresh_token, client_id: clientId })).status).toBe(200);
    expect(await oauthKv().get(`grant:owner:${grantId}`)).toBeNull();
  });

  it.each(["throw", "hang"] as const)(
    "answers 503 when the record's read fails (%s), before the library",
    async (fault) => {
      const world = new World({ timeouts: { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 50 } });
      const { clientId, tokens } = await signedIn(world);
      world.env = {
        ...world.env,
        OAUTH_KV: faulty(oauthKv(), (method, key) =>
          method === "get" && key.startsWith("revoked:") ? fault : undefined,
        ),
      };
      const fetchSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "fetch");
      const logs = captureLogs();
      const answer = await refresh(world, clientId, tokens.refresh_token);
      expect(await errorOf(answer)).toMatchObject({ status: 503, body: { error: "temporarily_unavailable" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logEvents(logs.lines)).toEqual([
        { event: "request.failed", error: fault === "throw" ? "Error" : "TimeoutError", host: "api" },
      ]);
    },
  );

  it("answers 503 when the library throws after a KV failure, and 500 after any other", async () => {
    const world = new World();
    const { clientId, tokens } = await signedIn(world);
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(oauthKv(), (method, key) =>
        method === "get" && key.startsWith("grant:") ? "throw" : undefined,
      ),
    };
    captureLogs();
    const kvFailure = await refresh(world, clientId, tokens.refresh_token);
    expect(await errorOf(kvFailure)).toMatchObject({ status: 503, body: { error: "temporarily_unavailable" } });
    world.env = { ...world.env, OAUTH_KV: oauthKv() };
    vi.spyOn(OAuthAuthorizationServer.prototype, "fetch").mockRejectedValueOnce(new TypeError("thrown"));
    const other = await refresh(world, clientId, tokens.refresh_token);
    expect(await errorOf(other)).toMatchObject({ status: 500, body: { error: "server_error" } });
  });
});

// Section 7: the server's metadata and lifetimes.
describe("the authorization server's configuration", () => {
  it("advertises the API host as issuer, both resources, the app host's authorization endpoint, revocation, CIMD and DCR, and no scopes", async () => {
    const world = new World();
    const response = await world.fetch(`${API}${METADATA_PATH}`);
    expect(response.status).toBe(200);
    const metadata: unknown = await response.json();
    expect(metadata).toMatchObject({
      issuer: API,
      authorization_endpoint: `https://${APP_HOST}/oauth/authorize`,
      token_endpoint: TOKEN_URL,
      revocation_endpoint: TOKEN_URL,
      registration_endpoint: REGISTER_URL,
      protected_resources: [`${API}/mcp`, `${API}/v1`],
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    });
    expect(isRecord(metadata) && "scopes_supported" in metadata).toBe(false);
  });

  it("binds a grant to the resource its request names, and to the MCP resource when it names none", async () => {
    const world = new World();
    const clientId = await register(world);
    for (const [named, bound] of [
      [`${API}/v1`, `${API}/v1`],
      [null, `${API}/mcp`],
    ] as const) {
      const tokens = await tokensOf(await exchange(world, clientId, await authorize(world, clientId, named)));
      expect(tokens).toMatchObject({ resource: bound });
    }
  });

  it("issues access tokens for an hour, grants for 30 days that slide with each refresh, and clients for 90", async () => {
    const world = new World();
    const { clientId, grantId, tokens } = await signedIn(world);
    const grantKey = `grant:owner:${grantId}`;
    const day = 86_400;
    expect(tokens.expires_in).toBe(3_600);
    const grant = async () => (await oauthKv().get<{ expiresAt: number }>(grantKey, { type: "json" }))?.expiresAt ?? 0;
    expect(Math.abs((await grant()) - (seconds() + 30 * day))).toBeLessThanOrEqual(5);
    // A refresh moves the expiry 30 days past itself, wherever it was.
    const stored = await oauthKv().get<Record<string, unknown>>(grantKey, { type: "json" });
    await oauthKv().put(grantKey, JSON.stringify({ ...stored, expiresAt: seconds() + day }));
    const refreshed = await tokensOf(await refresh(world, clientId, tokens.refresh_token));
    expect(refreshed.expires_in).toBe(3_600);
    expect(Math.abs((await grant()) - (seconds() + 30 * day))).toBeLessThanOrEqual(5);
    const client = await oauthKv().get<{ registrationExpiresAt: number }>(`client:${clientId}`, { type: "json" });
    expect(Math.abs((client?.registrationExpiresAt ?? 0) - (seconds() + 90 * day))).toBeLessThanOrEqual(5);
  });
});

// PL-45, DATA-1, TOK-2.
describe("PL-45: DATA-1 on every OAuth path and failure", () => {
  const MARKERS = {
    clientName: "CLIENT-NAME-MARKER",
    redirect: "REDIRECT-MARKER",
    code: "CODE-MARKER",
    verifier: "VERIFIER-MARKER-0123456789-0123456789-0123456789",
    token: "TOKEN-MARKER",
    parameter: "PARAMETER-MARKER",
    basic: "BASIC-MARKER",
    query: "ASKED-MARKER",
    cimdPath: "CIMD-PATH-MARKER",
    cimdQuery: "CIMD-QUERY-MARKER",
    document: "DOCUMENT-MARKER",
    kv: "KV-ERROR-MARKER",
    fetch: "FETCH-ERROR-MARKER",
    renewal: "RENEWAL-ERROR-MARKER",
    userinfo: "USERINFO-MARKER",
  };
  const CIMD_FAILED = "CIMD fetch failed for ";
  const RENEWAL_FAILED = "Failed to renew client registration ";

  it("logs no secret and no client value, except what the library's two lines carry", async () => {
    const world = new World({ timeouts: { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 50 } });
    const logs = captureLogs();
    const secrets: string[] = [];

    // Metadata, registration and its refusals.
    await world.fetch(`${API}${METADATA_PATH}?q=${MARKERS.query}`);
    const clientId = await register(world, {
      client_name: MARKERS.clientName,
      client_uri: `https://${MARKERS.clientName}.example.org/`,
    });
    await world.fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [`javascript:${MARKERS.redirect}`], client_name: MARKERS.clientName }),
    });
    await world.fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"client_name":"${MARKERS.clientName}${"a".repeat(64 * 1024)}"}`,
    });

    // Token endpoint refusals.
    await tokenRequest(world, `${MARKERS.parameter}=1&${MARKERS.parameter}=2&grant_type=authorization_code`);
    await tokenRequest(world, `grant_type=${MARKERS.token}`, { "Content-Type": "text/plain" });
    await tokenRequest(world, {
      grant_type: "authorization_code",
      code: `owner:abcdefghijklmnop:${MARKERS.code}`,
      client_id: clientId,
      code_verifier: MARKERS.verifier,
      redirect_uri: REDIRECT,
    });
    await tokenRequest(
      world,
      { grant_type: "refresh_token", refresh_token: `owner:abcdefghijklmnop:${MARKERS.token}` },
      { Authorization: `Basic ${btoa(`${MARKERS.basic}:${MARKERS.basic}`)}` },
    );

    // A full sign-in, refresh and revocation; every code and token is a secret.
    const code = await authorize(world, clientId);
    secrets.push(code, code.split(":")[2] ?? "");
    const tokens = await tokensOf(await exchange(world, clientId, code));
    const refreshed = await tokensOf(await refresh(world, clientId, tokens.refresh_token));
    secrets.push(tokens.access_token, tokens.refresh_token, refreshed.access_token, refreshed.refresh_token);
    // A replayed code revokes the grant; RFC 7009 and a refresh after it are refused or have no effect.
    await exchange(world, clientId, code);
    await tokenRequest(world, { token: refreshed.refresh_token, client_id: clientId });
    await refresh(world, clientId, refreshed.refresh_token);
    const second = await signedIn(world);
    secrets.push(second.tokens.access_token, second.tokens.refresh_token);
    await tokenRequest(world, { token: second.tokens.refresh_token, client_id: second.clientId });

    // KV failures with a message: the record's read, and the library's own read.
    const { clientId: other, tokens: otherTokens } = await signedIn(world);
    secrets.push(otherTokens.access_token, otherTokens.refresh_token);
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(oauthKv(), (method) => (method === "get" ? "throw" : undefined), MARKERS.kv),
    };
    await refresh(world, other, otherTokens.refresh_token);
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(
        oauthKv(),
        (method, key) => (method === "get" && key.startsWith("grant:") ? "throw" : undefined),
        MARKERS.kv,
      ),
    };
    await refresh(world, other, otherTokens.refresh_token);
    world.env = { ...world.env, OAUTH_KV: oauthKv() };

    // A CIMD client whose document cannot be fetched, and one whose document is invalid.
    const cimdId = `https://client.example.org/${MARKERS.cimdPath}/client.json?${MARKERS.cimdQuery}`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error(MARKERS.fetch));
    await tokenRequest(world, { grant_type: "refresh_token", refresh_token: "a:b:c", client_id: cimdId });
    fetchSpy.mockResolvedValueOnce(
      Response.json(
        { client_id: cimdId, client_name: MARKERS.document, redirect_uris: [`javascript:${MARKERS.document}`] },
        { headers: { "Cache-Control": "no-store" } },
      ),
    );
    await tokenRequest(world, { grant_type: "refresh_token", refresh_token: "a:b:c", client_id: cimdId });
    fetchSpy.mockRestore();
    // A caller's own client ID is logged as sent, a password in its userinfo included.
    const withUserinfo = `https://user:${MARKERS.userinfo}@client.example.org/client.json`;
    await tokenRequest(world, { grant_type: "refresh_token", refresh_token: "a:b:c", client_id: withUserinfo });

    // A registration renewal that fails after a successful token request.
    const due = await register(world);
    const record = await oauthKv().get<Record<string, unknown>>(`client:${due}`, { type: "json" });
    await oauthKv().put(`client:${due}`, JSON.stringify({ ...record, registrationExpiresAt: seconds() + 60 }));
    const dueCode = await authorize(world, due);
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(
        oauthKv(),
        (method, key) => (method === "put" && key === `client:${due}` ? "throw" : undefined),
        MARKERS.renewal,
      ),
    };
    const renewed = await tokensOf(await exchange(world, due, dueCode));
    secrets.push(dueCode, renewed.access_token, renewed.refresh_token);
    world.env = { ...world.env, OAUTH_KV: oauthKv() };

    const libraryLines = logs.lines.filter((line) => {
      const args: unknown = JSON.parse(line);
      const first: unknown = Array.isArray(args) ? args[0] : undefined;
      return typeof first === "string" && (first.startsWith(CIMD_FAILED) || first.startsWith(RENEWAL_FAILED));
    });
    const ours = logs.lines.filter((line) => !libraryLines.includes(line));
    // Both of the library's lines ran, and nothing else of the library's wrote.
    expect(libraryLines.some((line) => line.includes(CIMD_FAILED))).toBe(true);
    expect(libraryLines.some((line) => line.includes(RENEWAL_FAILED))).toBe(true);
    const events = logEvents(ours);
    for (const line of ours) {
      for (const marker of Object.values(MARKERS)) expect(line).not.toContain(marker);
    }
    for (const line of logs.lines) {
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
    // A marker in a library line comes only from what section 7 says that line carries.
    for (const line of libraryLines) {
      const allowed = line.includes(CIMD_FAILED)
        ? [MARKERS.cimdPath, MARKERS.cimdQuery, MARKERS.fetch, MARKERS.document, MARKERS.userinfo]
        : [MARKERS.renewal];
      for (const marker of Object.values(MARKERS).filter((value) => !allowed.includes(value))) {
        expect(line).not.toContain(marker);
      }
    }
    // The caller's userinfo appears in the CIMD line for its client ID, and nowhere else.
    const withUserinfoLines = logs.lines.filter((line) => line.includes(MARKERS.userinfo));
    expect(withUserinfoLines).toHaveLength(1);
    expect(withUserinfoLines[0]).toContain(`${CIMD_FAILED}${withUserinfo}:`);
    // The onError hook writes oauth.refused with a closed code and category only.
    const refusals = events.filter((event) => event.event === "oauth.refused" && event.reason === undefined);
    expect(refusals.length).toBeGreaterThan(5);
    for (const refusal of refusals) {
      expect(Object.keys(refusal).toSorted((a, b) => a.localeCompare(b))).toEqual(["category", "code", "event"]);
      expect(OAUTH_ERROR_CODES).toContain(refusal.code);
      expect(OAUTH_ERROR_CATEGORIES).toContain(refusal.category);
    }
    expect(new Set(events.map((event) => event.event))).toEqual(
      new Set(["oauth.refused", "grant.revoked", "request.failed"]),
    );
  });
});
