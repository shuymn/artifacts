// The credential check on `/mcp` and `/v1/` (design.md section 7, "Checking a credential"): PL-40 with OAUTH-3, OAUTH-5
// for access tokens and RES-2 for its KV reads; the protected resource metadata and the 401 challenge; PL-7 for a
// grant's publisher; and DATA-1 for OAuth credentials. Grants come from the library's `completeAuthorization`,
// standing in for the consent page, which sign-in.test.ts plays through the Worker.
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorize,
  exchange,
  expire,
  faulty,
  oauthKv,
  refresh,
  register,
  signedIn,
  tokenKey,
  tokensOf,
  useToken,
  type Fault,
  type ResourceRoute,
} from "./oauth-test-support.ts";
import { revocationKey } from "./revocation.ts";
import {
  API,
  BucketProbe,
  callTool,
  captureLogs,
  clearOAuthStorage,
  DatabaseProbe,
  logEvents,
  mcpClient,
  sha256Text,
  snapshot,
  stringAt,
  TOKENS,
  World,
  type PublishJson,
} from "./test-support.ts";

beforeEach(async () => {
  await clearOAuthStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SHORT = { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 50 };
const ROUTES: readonly ResourceRoute[] = ["mcp", "v1"];
const other = (resource: ResourceRoute): ResourceRoute => (resource === "mcp" ? "v1" : "mcp");
const metadataUrl = (resource: ResourceRoute) => `${API}/.well-known/oauth-protected-resource/${resource}`;
const challenge = (resource: ResourceRoute) =>
  `Bearer resource_metadata="${metadataUrl(resource)}", error="invalid_token"`;

/** A world whose D1 and R2 bindings fail the test when touched. */
function untouchable(world: World): { db: DatabaseProbe; bucket: BucketProbe } {
  const db = new DatabaseProbe();
  const bucket = new BucketProbe();
  db.behave = () => {
    throw new Error("D1 was touched");
  };
  bucket.behave = () => {
    throw new Error("R2 was touched");
  };
  world.env = { ...world.env, DB: db.binding, FILES: bucket.binding };
  return { db, bucket };
}

/** `world` with `OAUTH_KV` replaced by a namespace that counts calls and fails or holds those `pick` names. */
function observedKv(world: World, pick: (method: string, key: string) => Fault | undefined = () => undefined) {
  const calls: string[] = [];
  world.env = {
    ...world.env,
    OAUTH_KV: faulty(
      oauthKv(),
      (method, key) => {
        calls.push(`${method} ${key}`);
        return pick(method, key);
      },
      "KV-ERROR-MARKER",
    ),
  };
  return calls;
}

/** A credential of the library's form whose token key, as the library reads it, is `keyBytes` long. */
const credentialWithTokenKey = (keyBytes: number) => `${"u".repeat(keyBytes - 72 - 16)}:${"A".repeat(16)}:secret`;

async function expectRefused(response: Response, resource: ResourceRoute): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toBe(challenge(resource));
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
}

// Section 7, RFC 9728.
describe("the protected resource metadata", () => {
  it("serves one document per resource from the configuration, to GET and HEAD, without a credential or storage", async () => {
    const world = new World();
    const { db, bucket } = untouchable(world);
    const kv = observedKv(world);
    for (const resource of ROUTES) {
      const response = await world.fetch(metadataUrl(resource), { headers: { Origin: "https://evil.example.org" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resource: `${API}/${resource}`,
        authorization_servers: [API],
        bearer_methods_supported: ["header"],
        resource_name: resource === "mcp" ? "artifacts MCP" : "artifacts REST API",
      });
      expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
      const head = await world.fetch(metadataUrl(resource), { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
    expect(kv).toEqual([]);
  });

  it("answers 404 on any other path under it, and 405 with Allow to other methods, OPTIONS included", async () => {
    const world = new World();
    const base = `${API}/.well-known/oauth-protected-resource`;
    for (const url of [base, `${base}/`, `${base}/mcp/`, `${base}/v1/artifacts`, `${base}/other`, `${base}/MCP`]) {
      for (const method of ["GET", "OPTIONS"]) {
        const response = await world.fetch(url, { method });
        expect({ url, method, status: response.status }).toEqual({ url, method, status: 404 });
      }
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const response = await world.fetch(metadataUrl("mcp"), { method });
      expect({ method, status: response.status }).toEqual({ method, status: 405 });
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
    }
  });
});

// PL-40, TOK-1, OAUTH-3.
describe("PL-40: OAuth access tokens on /mcp and /v1/", () => {
  it.each(ROUTES)("accepts a /%s token on its resource only, and names the other's metadata", async (resource) => {
    const world = new World();
    const { grantId, tokens } = await signedIn(world, `${API}/${resource}`);
    expect((await useToken(world, resource, tokens.access_token)).status).toBe(200);
    const logs = captureLogs();
    await expectRefused(await useToken(world, other(resource), tokens.access_token), other(resource));
    expect(logEvents(logs.lines)).toEqual([{ event: "token.refused", reason: "oauth" }]);
    expect(logs.text()).not.toContain(grantId);
  });

  it("refuses an expired, an unknown and a forged credential of the library's form, before D1 or R2", async () => {
    const world = new World();
    const { grantId, tokens } = await signedIn(world);
    const expired = (await signedIn(world)).tokens.access_token;
    await expire(expired);
    const [user, , secret] = tokens.access_token.split(":");
    const credentials = [
      expired,
      `owner:${"A".repeat(16)}:${"s".repeat(32)}`,
      // The real grant with another secret, and the refresh token, which is not an access token.
      `${user}:${grantId}:${"s".repeat(32)}`,
      tokens.refresh_token,
      `${user}:${grantId}:${secret}x`,
      "a:b:c",
      "::",
    ];
    const before = await snapshot();
    const { db, bucket } = untouchable(world);
    const logs = captureLogs();
    for (const credential of credentials) {
      for (const resource of ROUTES) await expectRefused(await useToken(world, resource, credential), resource);
    }
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(logEvents(logs.lines)).toEqual(
      Array.from({ length: credentials.length * 2 }, () => ({ event: "token.refused", reason: "oauth" })),
    );
  });

  // Section 7: the props give the publisher name; a grant without a valid one has no name to publish as.
  it.each<[string, Record<string, unknown>]>([
    ["no publisher name", {}],
    ["a publisher name that is not a string", { publisher: 42 }],
    ["a malformed publisher name", { publisher: "Not Valid" }],
  ])("refuses the token of a grant with %s, before D1 or R2 and writing nothing", async (_name, props) => {
    const world = new World();
    const clientId = await register(world);
    const tokens = await tokensOf(
      await exchange(world, clientId, await authorize(world, clientId, `${API}/v1`, {}, props)),
    );
    const before = await snapshot();
    const { db, bucket } = untouchable(world);
    const logs = captureLogs();
    await expectRefused(await world.create({ title: "t", files: { "index.html": "i" } }, tokens.access_token), "v1");
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(logEvents(logs.lines)).toEqual([{ event: "token.refused", reason: "oauth" }]);
  });

  it("refuses a token once its grant has a revocation record, its own record still there", async () => {
    const world = new World();
    const { grantId, tokens } = await signedIn(world);
    await oauthKv().put(revocationKey(grantId), "2026-11-16T09:00:00.000Z");
    expect(await oauthKv().get(await tokenKey(tokens.access_token))).not.toBeNull();
    const { db, bucket } = untouchable(world);
    const logs = captureLogs();
    await expectRefused(await useToken(world, "mcp", tokens.access_token), "mcp");
    expect(logEvents(logs.lines)).toEqual([{ event: "token.refused", reason: "revoked", grant: grantId }]);
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
  });

  it.each(ROUTES)("refuses a /%s token after DELETE /v1/grants/{id} revokes its grant", async (resource) => {
    const world = new World();
    const { grantId, tokens } = await signedIn(world, `${API}/${resource}`);
    expect((await useToken(world, resource, tokens.access_token)).status).toBe(200);
    expect((await world.api("DELETE", `/v1/grants/${grantId}`)).status).toBe(204);
    await expectRefused(await useToken(world, resource, tokens.access_token), resource);
  });

  it("checks a credential of the library's form with the library only, even one API_TOKENS lists", async () => {
    // A token made by hand in the library's form; API_TOKENS lists it, and the router never compares it.
    const handmade = `owner:${"H".repeat(16)}:handmade`;
    const world = new World({ vars: { API_TOKENS: JSON.stringify({ handmade: await sha256Text(handmade) }) } });
    const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
    const validate = vi.spyOn(OAuthAuthorizationServer.prototype, "validateToken");
    captureLogs();
    for (const resource of ROUTES) await expectRefused(await useToken(world, resource, handmade), resource);
    expect(compare).not.toHaveBeenCalled();
    expect(validate.mock.calls.map(([resource, token]) => [resource, token])).toEqual([
      [`${API}/mcp`, handmade],
      [`${API}/v1`, handmade],
    ]);
  });

  it("checks any other credential against API_TOKENS only, without the library or KV", async () => {
    const world = new World();
    const validate = vi.spyOn(OAuthAuthorizationServer.prototype, "validateToken");
    const kv = observedKv(world);
    captureLogs();
    for (const resource of ROUTES) {
      expect((await useToken(world, resource, TOKENS.codex)).status).toBe(200);
      for (const token of [TOKENS.removed, "a:b", "a:b:c:d", "owner-only"]) {
        await expectRefused(await useToken(world, resource, token), resource);
      }
    }
    expect(validate).not.toHaveBeenCalled();
    expect(kv).toEqual([]);
  });

  it("refuses a credential whose token key KV would refuse without reading it, rather than with a 503", async () => {
    const world = new World();
    const kv = observedKv(world);
    captureLogs();
    // The library reads `token:<user>:<grant>:<64 hex digits>`: 512 bytes at KV's limit, 513 past it.
    await expectRefused(await useToken(world, "mcp", credentialWithTokenKey(512)), "mcp");
    expect(kv).toHaveLength(1);
    await expectRefused(await useToken(world, "mcp", credentialWithTokenKey(513)), "mcp");
    expect(kv).toHaveLength(1);
  });

  it.each<[string, string, Fault]>([
    ["token", "token:", "throw"],
    ["token", "token:", "hang"],
    ["revocation", "revoked:", "throw"],
    ["revocation", "revoked:", "hang"],
  ])("answers 503 when the %s record's read fails (%s), without D1 or R2", async (_record, prefix, fault) => {
    for (const resource of ROUTES) {
      const world = new World({ timeouts: SHORT });
      const { tokens } = await signedIn(world, `${API}/${resource}`);
      const kv = observedKv(world, (method, key) => (method === "get" && key.startsWith(prefix) ? fault : undefined));
      const { db, bucket } = untouchable(world);
      const logs = captureLogs();
      const response = await useToken(world, resource, tokens.access_token);
      expect(response.status).toBe(503);
      expect(response.headers.has("WWW-Authenticate")).toBe(false);
      expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
      expect(kv.filter((call) => call.startsWith(`get ${prefix}`))).toHaveLength(1);
      expect(db.batches).toBe(0);
      expect(bucket.calls).toEqual([]);
      expect(logEvents(logs.lines)).toEqual([
        { event: "request.failed", error: fault === "throw" ? "Error" : "TimeoutError", host: "api" },
      ]);
      expect(logs.text()).not.toContain("KV-ERROR-MARKER");
      vi.restoreAllMocks();
    }
  });

  it("answers 500 when the library throws after anything but a KV failure", async () => {
    const world = new World();
    const { tokens } = await signedIn(world);
    vi.spyOn(OAuthAuthorizationServer.prototype, "validateToken").mockRejectedValueOnce(new TypeError("thrown"));
    const logs = captureLogs();
    const response = await useToken(world, "mcp", tokens.access_token);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal" } });
    expect(logEvents(logs.lines)).toEqual([{ event: "request.failed", error: "TypeError", host: "api" }]);
  });

  it("serves a refreshed token on the grant's resource, and refuses the rotated refresh token", async () => {
    const world = new World();
    const { clientId, tokens } = await signedIn(world, `${API}/v1`);
    const refreshed = await tokensOf(await refresh(world, clientId, tokens.refresh_token));
    expect((await useToken(world, "v1", refreshed.access_token)).status).toBe(200);
    await expectRefused(await useToken(world, "mcp", refreshed.access_token), "mcp");
  });
});

// PL-7, TOK-3: a grant's publisher name in versions, with its ID in change logs.
describe("PL-7: a grant's publisher in versions and change logs", () => {
  it("records the grant's publisher name and logs it with the grant's ID, over REST and MCP", async () => {
    const world = new World();
    // Two grants under one name: the logs tell them apart by ID.
    const rest = await signedIn(world, `${API}/v1`, "agent");
    const mcp = await signedIn(world, `${API}/mcp`, "agent");
    const logs = captureLogs();

    const created = await world.created({ title: "t", files: { "index.html": "i" } }, rest.tokens.access_token);
    const id = created.artifact.id;
    expect(created.version.published_by).toBe("agent");
    const client = await mcpClient(world, { token: mcp.tokens.access_token });
    const updated = await callTool(client, "update_artifact", { id, base_version: 1 });
    expect(stringAt(updated.value, "version", "published_by")).toBe("agent");
    await callTool(client, "set_public", { id, public: true });
    await world.patch(id, { archive: "kept" }, rest.tokens.access_token);
    const deleted = await world.api("DELETE", `/v1/artifacts/${id}`, { token: rest.tokens.access_token });
    expect(deleted.status).toBe(204);

    expect(logEvents(logs.lines)).toEqual([
      { event: "artifact.created", token: "agent", grant: rest.grantId, artifact: id, version: 1 },
      { event: "artifact.updated", token: "agent", grant: mcp.grantId, artifact: id, version: 2 },
      { event: "artifact.changed", token: "agent", grant: mcp.grantId, artifact: id, public: true },
      { event: "artifact.changed", token: "agent", grant: rest.grantId, artifact: id, archive: "kept" },
      { event: "artifact.deleted", token: "agent", grant: rest.grantId, artifact: id },
    ]);
  });

  it("keeps an API token's change logs without a grant", async () => {
    const world = new World();
    const logs = captureLogs();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    expect(logEvents(logs.lines)).toEqual([
      { event: "artifact.created", token: "codex", artifact: created.artifact.id, version: 1 },
    ]);
  });
});

// DATA-1, TOK-2.
describe("DATA-1: OAuth credentials on /mcp and /v1/", () => {
  it("logs no token or client value, and the grant's ID only beside its publisher or a revocation", async () => {
    const world = new World({ timeouts: SHORT });
    const v1 = await signedIn(world, `${API}/v1`, "marker-agent");
    const mcp = await signedIn(world, `${API}/mcp`, "marker-agent");
    const expired = await signedIn(world, `${API}/mcp`, "marker-agent");
    await expire(expired.tokens.access_token);
    const revoked = await signedIn(world, `${API}/v1`, "marker-agent");
    await oauthKv().put(revocationKey(revoked.grantId), "2026-11-16T09:00:00.000Z");
    const logs = captureLogs();
    const responses: Response[] = [];
    const keep = async (response: Promise<Response>) => {
      const resolved = await response;
      responses.push(resolved.clone());
      return resolved;
    };

    // Changes and reads with each resource's token.
    const created = await (
      await keep(world.create({ title: "t", files: { "index.html": "i" } }, v1.tokens.access_token))
    ).json<PublishJson>();
    await keep(world.patch(created.artifact.id, { public: true }, v1.tokens.access_token));
    await keep(useToken(world, "mcp", mcp.tokens.access_token));
    const client = await mcpClient(world, { token: mcp.tokens.access_token });
    await callTool(client, "delete_artifact", { id: created.artifact.id });
    // Refusals: the other resource, a refresh token, expired, revoked, and KV failing or hanging.
    await keep(useToken(world, "mcp", v1.tokens.access_token));
    await keep(useToken(world, "v1", mcp.tokens.refresh_token));
    await keep(useToken(world, "mcp", expired.tokens.access_token));
    await keep(useToken(world, "v1", revoked.tokens.access_token));
    observedKv(world, (method, key) => (method === "get" && key.startsWith("token:") ? "throw" : undefined));
    await keep(useToken(world, "v1", v1.tokens.access_token));
    observedKv(world, (method, key) => (method === "get" && key.startsWith("revoked:") ? "hang" : undefined));
    await keep(useToken(world, "v1", v1.tokens.access_token));
    expect(responses.map((response) => response.status)).toEqual([201, 200, 200, 401, 401, 401, 401, 503, 503]);

    // Closed fields only: a grant's ID beside its publisher name in a change, or in the refusal of a revoked grant.
    const id = created.artifact.id;
    const refusal = { event: "token.refused", reason: "oauth" };
    expect(logEvents(logs.lines)).toEqual([
      { event: "artifact.created", token: "marker-agent", grant: v1.grantId, artifact: id, version: 1 },
      { event: "artifact.changed", token: "marker-agent", grant: v1.grantId, artifact: id, public: true },
      { event: "artifact.deleted", token: "marker-agent", grant: mcp.grantId, artifact: id },
      refusal,
      refusal,
      refusal,
      { event: "token.refused", reason: "revoked", grant: revoked.grantId },
      { event: "request.failed", error: "Error", host: "api" },
      { event: "request.failed", error: "TimeoutError", host: "api" },
    ]);
    const secrets = [v1, mcp, expired, revoked].flatMap(({ clientId, tokens }) => [
      clientId,
      tokens.access_token,
      tokens.refresh_token,
      ...[tokens.access_token, tokens.refresh_token].map((token) => token.split(":")[2] ?? token),
    ]);
    for (const secret of [...secrets, "KV-ERROR-MARKER", "test client"]) expect(logs.text()).not.toContain(secret);

    // TOK-2: no response echoes a credential.
    for (const response of responses) {
      const echoed = `${[...response.headers].join("\n")}\n${await response.text()}`;
      for (const secret of secrets) expect(echoed).not.toContain(secret);
    }
  });
});
