// The grants API on REST (design.md section 8, "Grants"; section 7, "Revocation"): the listing, the revocation of one
// grant through the library's `revokeGrant` and the recording wrapper (OAUTH-5, PL-41 at the token endpoint), its
// failures (RES-2) and its logs (DATA-1). Grants come from the library's `completeAuthorization`, standing in for the
// consent page of a later step.
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OWNER } from "./grants.ts";
import {
  authorize,
  exchange,
  faulty,
  oauthKv,
  refresh,
  register,
  signedIn,
  tokensOf,
  type Fault,
} from "./oauth-test-support.ts";
import { revocationKey } from "./revocation.ts";
import { API, captureLogs, clearOAuthStorage, gate, logEvents, stringAt, TOKENS, World } from "./test-support.ts";

beforeEach(async () => {
  await clearOAuthStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const LOCAL = {
  APP_HOST: "app.localhost:8787",
  API_HOST: "api.localhost:8787",
  CONTENT_HOST_SUFFIX: "-art.localhost:8787",
  PUBLIC_HOST_SUFFIX: "-pub.localhost:8787",
};

const SHORT = { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 50 };

const grantKey = (id: string) => `grant:${OWNER}:${id}`;

async function listed(world: World): Promise<Record<string, unknown>[]> {
  const response = await world.api("GET", "/v1/grants");
  if (response.status !== 200) throw new Error(`the listing answered ${response.status}: ${await response.text()}`);
  return (await response.json<{ grants: Record<string, unknown>[] }>()).grants;
}

const revoke = (world: World, id: string) => world.api("DELETE", `/v1/grants/${id}`);

/** `world` with `OAUTH_KV` replaced by a namespace whose calls `pick` names fail or wait. */
function withFaults(world: World, pick: (method: string, key: string) => Fault | undefined, message?: string): void {
  world.env = { ...world.env, OAUTH_KV: faulty(oauthKv(), pick, message) };
}

function healed(world: World): void {
  world.env = { ...world.env, OAUTH_KV: oauthKv() };
}

describe("GET /v1/grants", () => {
  it("lists every grant, newest first, with its consent metadata, and leaves out a grant with a record", async () => {
    const world = new World();
    const clientId = await register(world);
    const metadata = { publisher: "laptop-claude", clientName: "Claude Code", redirectHost: "127.0.0.1" };
    const described = await authorize(world, clientId, `${API}/mcp`, metadata);
    const tokens = await tokensOf(await exchange(world, clientId, described));
    const bare = await authorize(world, clientId, `${API}/v1`);
    const revoked = await authorize(world, clientId);
    const [describedId, bareId, revokedId] = [described, bare, revoked].map((code) => code.split(":")[1] ?? "");
    // KV lists keys in lexical order: the newer grant is the one listed last, so only a sort puts it first. The times are
    // a second apart, so the order does not rest on the test's clock.
    const [older = "", newer = ""] = [describedId, bareId].toSorted((a = "", b = "") => (a < b ? -1 : 1));
    for (const [id, createdAt] of [
      [older, 1_800_000_000],
      [newer, 1_800_000_001],
      [revokedId ?? "", 1_800_000_002],
    ] as const) {
      const stored = await oauthKv().get<Record<string, unknown>>(grantKey(id), { type: "json" });
      await oauthKv().put(grantKey(id), JSON.stringify({ ...stored, createdAt }));
    }
    await oauthKv().put(revocationKey(revokedId ?? ""), "2026-11-16T09:00:00.000Z");

    const grants = await listed(world);
    expect(grants.map((grant) => grant.id)).toEqual([newer, older]);
    const createdAt = (id: string) => (id === newer ? "2027-01-15T08:00:01.000Z" : "2027-01-15T08:00:00.000Z");
    expect(grants.find((grant) => grant.id === describedId)).toEqual({
      id: describedId,
      publisher: "laptop-claude",
      client_id: clientId,
      client_name: "Claude Code",
      redirect_host: "127.0.0.1",
      resource: `${API}/mcp`,
      created_at: createdAt(describedId ?? ""),
      expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/) as unknown,
    });
    // A grant whose code is not exchanged yet has no expiry of its own, and this one no consent metadata.
    expect(grants.find((grant) => grant.id === bareId)).toEqual({
      id: bareId,
      publisher: null,
      client_id: clientId,
      client_name: null,
      redirect_host: null,
      resource: `${API}/v1`,
      created_at: createdAt(bareId ?? ""),
      expires_at: null,
    });
    const expiresAt = Date.parse(
      stringAt(
        grants.find((grant) => grant.id === describedId),
        "expires_at",
      ),
    );
    expect(Math.abs(expiresAt - (Date.now() + 30 * 86_400_000))).toBeLessThan(10_000);
    expect(tokens.refresh_token).toContain(describedId);
  });

  it("answers an empty listing when there is no grant", async () => {
    expect(await listed(new World())).toEqual([]);
  });

  it.each([
    [
      "the listing never answers",
      (method: string) => (method === "list" ? "hang" : undefined),
      "timeout",
      "TimeoutError",
    ],
    ["the listing fails", (method: string) => (method === "list" ? "throw" : undefined), "error", "Error"],
    [
      "a record's read never answers",
      (method: string, key: string) => (method === "get" && key.startsWith("revoked:") ? "hang" : undefined),
      "timeout",
      "TimeoutError",
    ],
  ] as const)("answers 503 unavailable when %s (RES-2)", async (_name, pick, reason, error) => {
    const world = new World({ timeouts: SHORT });
    await signedIn(world);
    withFaults(world, pick, "KV-ERROR-MARKER");
    const logs = captureLogs();
    const response = await world.api("GET", "/v1/grants");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
    expect(logEvents(logs.lines)).toEqual([{ event: "operation.failed", reason, error }]);
    expect(logs.text()).not.toContain("KV-ERROR-MARKER");
  });
});

describe("DELETE /v1/grants/{id}", () => {
  it("revokes a grant and its tokens: the record first, then the deletion; the listing before and after", async () => {
    const world = new World();
    const { clientId, grantId, tokens } = await signedIn(world);
    expect((await listed(world)).map((grant) => grant.id)).toEqual([grantId]);
    const logs = captureLogs();
    const response = await revoke(world, grantId);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(logEvents(logs.lines)).toEqual([{ event: "grant.revoked", grant: grantId }]);
    expect(await oauthKv().get(revocationKey(grantId))).not.toBeNull();
    expect(await oauthKv().get(grantKey(grantId))).toBeNull();
    expect((await oauthKv().list({ prefix: `token:${OWNER}:${grantId}:` })).keys).toEqual([]);
    expect(await listed(world)).toEqual([]);
    const refused = await refresh(world, clientId, tokens.refresh_token);
    expect(await refused.json()).toEqual({ error: "invalid_grant", error_description: "Grant not found" });
  });

  it("answers 404 for an ID the listing does not hold, and for a repeated revocation", async () => {
    const world = new World();
    const { grantId } = await signedIn(world);
    expect((await revoke(world, grantId)).status).toBe(204);
    for (const id of [grantId, "AAAAAAAAAAAAAAAA", "not-a-grant-id", "%41"]) {
      const response = await revoke(world, id);
      expect({ id, status: response.status }).toEqual({ id, status: 404 });
      expect(await response.json()).toEqual({ error: { code: "not_found", message: "no grant matches" } });
    }
    // A record is written only for the grant that was revoked.
    expect((await oauthKv().list({ prefix: "revoked:" })).keys.map((key) => key.name)).toEqual([
      revocationKey(grantId),
    ]);
  });

  it("reads nothing for an ID of another form than the library's", async () => {
    const world = new World();
    const helperSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "getOAuthApi");
    for (const id of ["short", "a".repeat(17), "with:colon-12345", "with.dot-1234567"]) {
      expect((await revoke(world, id)).status).toBe(404);
    }
    expect(helperSpy).not.toHaveBeenCalled();
  });

  it.each(["refresh", "code exchange"] as const)(
    "refuses a grant that a %s wrote back after its revocation through DELETE, and keeps it out of the listing",
    async (flow) => {
      const world = new World();
      const clientId = await register(world);
      const code = await authorize(world, clientId);
      const grantId = code.split(":")[1] ?? "";
      const first = flow === "refresh" ? await tokensOf(await exchange(world, clientId, code)) : undefined;
      // The flow is held at its write of the grant, which follows its read, while DELETE revokes the grant.
      const held = gate();
      const reached = Promise.withResolvers<void>();
      withFaults(world, (method, key) => {
        if (method !== "put" || key !== grantKey(grantId)) return undefined;
        reached.resolve();
        return held.promise;
      });
      const racing =
        first === undefined ? exchange(world, clientId, code) : refresh(world, clientId, first.refresh_token);
      await reached.promise;
      expect((await revoke(world, grantId)).status).toBe(204);
      expect(await oauthKv().get(grantKey(grantId))).toBeNull();
      held.open();
      const raced = await tokensOf(await racing);
      healed(world);
      // The library wrote the grant back after its deletion; the record still refuses it and hides it.
      expect(await oauthKv().get(grantKey(grantId))).not.toBeNull();
      expect(await listed(world)).toEqual([]);
      const after = await refresh(world, clientId, raced.refresh_token);
      expect(await after.json()).toEqual({ error: "invalid_grant", error_description: "Grant not found" });
    },
  );

  it("answers 503 when the record cannot be written, leaving the grant listed, and a retry revokes it", async () => {
    const world = new World();
    const { clientId, grantId, tokens } = await signedIn(world);
    withFaults(
      world,
      (method, key) => (method === "put" && key.startsWith("revoked:") ? "throw" : undefined),
      "KV-ERROR-MARKER",
    );
    const logs = captureLogs();
    const failed = await revoke(world, grantId);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: { code: "unavailable" } });
    expect(logEvents(logs.lines)).toEqual([{ event: "grant.revoke_failed", grant: grantId, error: "Error" }]);
    expect(logs.text()).not.toContain("KV-ERROR-MARKER");
    healed(world);
    expect(await oauthKv().get(grantKey(grantId))).not.toBeNull();
    expect((await listed(world)).map((grant) => grant.id)).toEqual([grantId]);
    // The grant was not revoked: its refresh token still works.
    const refreshed = await tokensOf(await refresh(world, clientId, tokens.refresh_token));
    expect((await revoke(world, grantId)).status).toBe(204);
    expect(await oauthKv().get(grantKey(grantId))).toBeNull();
    const refused = await refresh(world, clientId, refreshed.refresh_token);
    expect(refused.status).toBe(400);
  });

  it("answers 503 when the deletion after the record fails; the grant is refused at once, and a retry deletes it", async () => {
    const world = new World();
    const { clientId, grantId, tokens } = await signedIn(world);
    withFaults(world, (method, key) => (method === "delete" && key.startsWith("grant:") ? "throw" : undefined));
    captureLogs();
    expect((await revoke(world, grantId)).status).toBe(503);
    healed(world);
    expect(await oauthKv().get(grantKey(grantId))).not.toBeNull();
    expect(await listed(world)).toEqual([]);
    const refused = await refresh(world, clientId, tokens.refresh_token);
    expect(await refused.json()).toEqual({ error: "invalid_grant", error_description: "Grant not found" });
    expect((await revoke(world, grantId)).status).toBe(204);
    expect(await oauthKv().get(grantKey(grantId))).toBeNull();
  });

  it("answers 503 when the listing it checks the ID against fails, revoking nothing", async () => {
    const world = new World({ timeouts: SHORT });
    const { grantId } = await signedIn(world);
    withFaults(world, (method) => (method === "list" ? "hang" : undefined));
    const logs = captureLogs();
    expect((await revoke(world, grantId)).status).toBe(503);
    expect(logEvents(logs.lines)).toEqual([{ event: "operation.failed", reason: "timeout", error: "TimeoutError" }]);
    healed(world);
    expect(await oauthKv().get(revocationKey(grantId))).toBeNull();
    expect(await oauthKv().get(grantKey(grantId))).not.toBeNull();
  });

  it("puts no timeout on the revocation's writes, which could still apply", async () => {
    const world = new World({ timeouts: SHORT });
    const { grantId } = await signedIn(world);
    const slow = new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
    withFaults(world, (method) => (method === "put" || method === "delete" ? slow : undefined));
    expect((await revoke(world, grantId)).status).toBe(204);
    healed(world);
    expect(await oauthKv().get(grantKey(grantId))).toBeNull();
  });
});

describe("the grants routes", () => {
  it("need a credential the API accepts, and read nothing without one", async () => {
    const world = new World();
    const { grantId } = await signedIn(world);
    const helperSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "getOAuthApi");
    for (const [method, path] of [
      ["GET", "/v1/grants"],
      ["DELETE", `/v1/grants/${grantId}`],
    ] as const) {
      for (const token of [null, TOKENS.removed, `owner:${grantId}:secret`]) {
        const response = await world.api(method, path, { token });
        expect({ method, token, status: response.status }).toEqual({ method, token, status: 401 });
      }
    }
    expect(helperSpy).not.toHaveBeenCalled();
    expect((await world.api("GET", "/v1/grants", { token: TOKENS.claude })).status).toBe(200);
  });

  it("answer 405 with Allow to other methods and to OPTIONS, and 404 below a grant", async () => {
    const world = new World();
    for (const [method, path, allow] of [
      ["POST", "/v1/grants", "GET, HEAD"],
      ["DELETE", "/v1/grants", "GET, HEAD"],
      ["GET", "/v1/grants/AAAAAAAAAAAAAAAA", "DELETE"],
      ["PATCH", "/v1/grants/AAAAAAAAAAAAAAAA", "DELETE"],
    ] as const) {
      const response = await world.api(method, path, method === "POST" || method === "PATCH" ? { body: "{}" } : {});
      expect({ method, path, status: response.status, allow: response.headers.get("Allow") }).toEqual({
        method,
        path,
        status: 405,
        allow,
      });
    }
    for (const [path, allow] of [
      ["/v1/grants", "GET, HEAD"],
      ["/v1/grants/AAAAAAAAAAAAAAAA", "DELETE"],
    ] as const) {
      const response = await world.api("OPTIONS", path, { token: null });
      expect({ path, status: response.status, allow: response.headers.get("Allow") }).toEqual({
        path,
        status: 405,
        allow,
      });
    }
    expect((await world.api("GET", "/v1/grants/AAAAAAAAAAAAAAAA/tokens")).status).toBe(404);
    expect((await world.api("OPTIONS", "/v1/grants/AAAAAAAAAAAAAAAA/tokens", { token: null })).status).toBe(404);
  });

  it("do not exist where OAuth is off", async () => {
    const world = new World({ vars: LOCAL });
    for (const [method, path] of [
      ["GET", "/v1/grants"],
      ["DELETE", "/v1/grants/AAAAAAAAAAAAAAAA"],
    ] as const) {
      const response = await world.fetch(`http://api.localhost:8787${path}`, {
        method,
        headers: { Authorization: `Bearer ${TOKENS.codex}` },
      });
      expect({ method, status: response.status }).toEqual({ method, status: 404 });
      const preflight = await world.fetch(`http://api.localhost:8787${path}`, { method: "OPTIONS" });
      expect(preflight.status).toBe(404);
    }
  });
});

// DATA-1: the grants routes log the grant ID, event names and error classes, never a client's values.
describe("DATA-1 on the grants routes", () => {
  it("logs no consent metadata, client value or error message", async () => {
    const world = new World({ timeouts: SHORT });
    const clientId = await register(world, { client_name: "CLIENT-NAME-MARKER" });
    const metadata = { publisher: "PUBLISHER-MARKER", clientName: "CLIENT-NAME-MARKER", redirectHost: "HOST-MARKER" };
    const code = await authorize(world, clientId, `${API}/mcp`, metadata);
    const grantId = code.split(":")[1] ?? "";
    const logs = captureLogs();
    await listed(world);
    withFaults(world, (method) => (method === "list" ? "throw" : undefined), "KV-ERROR-MARKER");
    await world.api("GET", "/v1/grants");
    healed(world);
    withFaults(
      world,
      (method, key) => (method === "delete" && key.startsWith("grant:") ? "throw" : undefined),
      "KV-ERROR-MARKER",
    );
    await revoke(world, grantId);
    healed(world);
    await revoke(world, grantId);
    for (const marker of ["PUBLISHER-MARKER", "CLIENT-NAME-MARKER", "HOST-MARKER", "KV-ERROR-MARKER", code, clientId]) {
      expect(logs.text()).not.toContain(marker);
    }
    expect(logEvents(logs.lines)).toEqual([
      { event: "operation.failed", reason: "error", error: "Error" },
      { event: "grant.revoked", grant: grantId },
      { event: "grant.revoke_failed", grant: grantId, error: "Error" },
      { event: "grant.revoked", grant: grantId },
    ]);
  });
});
