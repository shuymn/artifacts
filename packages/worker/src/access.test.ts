import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { AccessVerifier, type AccessVerifierOptions } from "./access.ts";
import { APP_AUD, CONTENT_AUD, KeyEndpoint, publicJwk, TEAM, World } from "./test-support.ts";

const settings = { teamDomain: TEAM, aud: CONTENT_AUD };

/** A verifier over the world's key endpoint and clock, with production cooldown unless given. */
function verifier(world: World, options: Partial<AccessVerifierOptions> = {}): AccessVerifier {
  return new AccessVerifier({ fetch: world.keys.fetch, now: () => world.clock.now, ...options });
}

function request(jwt: string | null, cookie?: string): Request {
  const headers = new Headers();
  if (jwt !== null) headers.set("Cf-Access-Jwt-Assertion", jwt);
  if (cookie !== undefined) headers.set("Cookie", cookie);
  return new Request("https://example.com/", { headers });
}

// PL-3, ACC-1.
describe("ACC-1: Access JWT verification", () => {
  it("accepts a valid JWT for the host's audience", async () => {
    const world = new World();
    expect(await verifier(world).verify(request(await world.jwt()), settings)).toEqual({ ok: true });
    expect(
      await verifier(world).verify(request(await world.jwt({ aud: APP_AUD })), { teamDomain: TEAM, aud: APP_AUD }),
    ).toEqual({ ok: true });
  });

  it.each<[string, (world: World) => Promise<string | null>, string]>([
    ["a missing JWT", async () => null, "missing"],
    ["an empty JWT", async () => "", "missing"],
    ["a malformed JWT", async () => "not.a.jwt", "malformed"],
    ["a bad signature", (world) => world.jwt({ key: "other" }), "signature"],
    ["another issuer", (world) => world.jwt({ iss: "https://other.example.com" }), "claims"],
    ["the other class's audience", (world) => world.jwt({ aud: APP_AUD }), "claims"],
    ["no exp", (world) => world.jwt({ expiresIn: null }), "claims"],
    ["an exp 60 s past, at the tolerance", (world) => world.jwt({ expiresIn: -60 }), "expired"],
    ["RS384", (world) => world.jwt({ alg: "RS384" }), "algorithm"],
    ["PS256", (world) => world.jwt({ alg: "PS256" }), "algorithm"],
  ])("refuses %s with 403", async (_name, make, reason) => {
    const world = new World();
    const outcome = await verifier(world).verify(request(await make(world)), settings);
    expect(outcome).toEqual({ ok: false, status: 403, reason });
  });

  it("accepts an exp 59 s past, inside the 60 s tolerance", async () => {
    const world = new World();
    expect(await verifier(world).verify(request(await world.jwt({ expiresIn: -59 })), settings)).toEqual({ ok: true });
  });

  // ISO-4: the cookie is never read.
  it("refuses a valid JWT sent only as the CF_Authorization cookie", async () => {
    const world = new World();
    const outcome = await verifier(world).verify(request(null, `CF_Authorization=${await world.jwt()}`), settings);
    expect(outcome).toEqual({ ok: false, status: 403, reason: "missing" });
  });

  it("fetches the key set once and reuses it", async () => {
    const world = new World();
    const access = verifier(world);
    for (let i = 0; i < 3; i++) expect((await access.verify(request(await world.jwt()), settings)).ok).toBe(true);
    expect(world.keys.calls).toBe(1);
  });

  it("refreshes the set once for an unknown kid", async () => {
    const world = new World();
    const access = verifier(world, { cooldownMs: 0 });
    expect((await access.verify(request(await world.jwt()), settings)).ok).toBe(true);
    expect(world.keys.calls).toBe(1);

    // A rotated key: the endpoint now also serves key-2, which the cached set lacks.
    const rotated = await generateKeyPair("RS256", { extractable: true });
    world.keys.keys = [...world.keys.keys, await publicJwk(rotated.publicKey, "key-2")];
    const now = Math.floor(world.clock.now / 1000);
    const jwt = await new SignJWT({ exp: now + 600 })
      .setProtectedHeader({ alg: "RS256", kid: "key-2" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(CONTENT_AUD)
      .sign(rotated.privateKey);
    expect(await access.verify(request(jwt), settings)).toEqual({ ok: true });
    expect(world.keys.calls).toBe(2);

    // A kid no set has: one more fetch, then a refusal.
    expect(await access.verify(request(await world.jwt({ kid: "key-9" })), settings)).toEqual({
      ok: false,
      status: 403,
      reason: "unknown_key",
    });
    expect(world.keys.calls).toBe(3);
  });

  it("does not refetch for an unknown kid within the cooldown", async () => {
    const world = new World();
    const access = verifier(world);
    expect((await access.verify(request(await world.jwt()), settings)).ok).toBe(true);
    expect((await access.verify(request(await world.jwt({ kid: "key-9" })), settings)).ok).toBe(false);
    expect(world.keys.calls).toBe(1);
  });

  it.each<[KeyEndpoint["mode"], string]>([
    ["down", "a network failure"],
    ["error_status", "a non-200 status"],
    ["hang", "no answer within the timeout"],
  ])("answers 503 when the key endpoint has %s (%s)", async (mode) => {
    const world = new World();
    world.keys.mode = mode;
    const outcome = await verifier(world, { keyTimeoutMs: 50 }).verify(request(await world.jwt()), settings);
    expect(outcome).toEqual({ ok: false, status: 503, reason: "keys_unavailable" });
  });

  it("refuses with 403 when no key of a well-formed set fits", async () => {
    const world = new World();
    world.keys.keys = [{ kty: "nonsense", kid: "key-1" }];
    const outcome = await verifier(world).verify(request(await world.jwt()), settings);
    expect(outcome).toEqual({ ok: false, status: 403, reason: "unknown_key" });
  });

  it("answers 503 for a malformed key set", async () => {
    const world = new World();
    world.keys.keys = ["not a key"];
    const outcome = await verifier(world).verify(request(await world.jwt()), settings);
    expect(outcome).toEqual({ ok: false, status: 503, reason: "keys_unavailable" });
  });

  it("does not reuse a set past its maximum age when the endpoint is down", async () => {
    const world = new World();
    const access = verifier(world, { maxAgeMs: 0 });
    expect((await access.verify(request(await world.jwt()), settings)).ok).toBe(true);
    world.keys.mode = "down";
    expect(await access.verify(request(await world.jwt()), settings)).toEqual({
      ok: false,
      status: 503,
      reason: "keys_unavailable",
    });
  });
});
