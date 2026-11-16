// OAUTH-5: the KV wrapper that writes a revocation record before each grant deletion, and the record's read.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fitsKvKey, grantOf, hasRevocationRecord, recordingKv, revocationKey } from "./revocation.ts";
import { captureLogs, clearOAuthStorage, logEvents, never } from "./test-support.ts";

beforeEach(async () => {
  await clearOAuthStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);
const GRANT = "AbCdEfGh_-012345";
const GRANT_KEY = `grant:owner:${GRANT}`;

function oauthKv(): KVNamespace {
  if (env.OAUTH_KV === undefined) throw new Error("the test configuration binds OAUTH_KV");
  return env.OAUTH_KV;
}

/** `base` with each call that `fails` picks rejected before it reaches KV; records every call's method and key. */
function probe(base: KVNamespace, fails: (method: string, key: string) => boolean = () => false) {
  const calls: string[] = [];
  const kv = new Proxy(base, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const key = typeof args[0] === "string" ? args[0] : "";
        calls.push(`${String(property)} ${key}`);
        if (fails(String(property), key)) return Promise.reject(new Error("KV-FAILURE"));
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });
  return { kv, calls };
}

describe("OAUTH-5: the recording KV wrapper", () => {
  it("writes the grant's record, then deletes the grant, and logs grant.revoked", async () => {
    const base = probe(oauthKv());
    await base.kv.put(GRANT_KEY, "{}");
    base.calls.length = 0;
    const logs = captureLogs();
    const recording = recordingKv(base.kv, () => NOW);
    await recording.kv.delete(GRANT_KEY);
    expect(base.calls).toEqual([`put ${revocationKey(GRANT)}`, `delete ${GRANT_KEY}`]);
    expect(await oauthKv().get(GRANT_KEY)).toBeNull();
    expect(await oauthKv().get(revocationKey(GRANT))).toBe(new Date(NOW).toISOString());
    // Records never expire.
    const listed = await oauthKv().list({ prefix: "revoked:" });
    expect(listed.keys).toEqual([{ name: revocationKey(GRANT) }]);
    expect(logEvents(logs.lines)).toEqual([{ event: "grant.revoked", grant: GRANT }]);
    expect(recording.failed()).toBe(false);
  });

  it("fails the deletion, leaving the grant, when the record's write fails", async () => {
    await oauthKv().put(GRANT_KEY, "{}");
    const base = probe(oauthKv(), (method, key) => method === "put" && key.startsWith("revoked:"));
    const logs = captureLogs();
    const recording = recordingKv(base.kv, () => NOW);
    await expect(recording.kv.delete(GRANT_KEY)).rejects.toThrow("KV-FAILURE");
    expect(base.calls).toEqual([`put ${revocationKey(GRANT)}`]);
    expect(await oauthKv().get(GRANT_KEY)).toBe("{}");
    expect(logs.lines).toEqual([]);
    expect(recording.failed()).toBe(true);
  });

  it("keeps the record when the deletion after it fails, so a retry completes it", async () => {
    await oauthKv().put(GRANT_KEY, "{}");
    let failing = true;
    const base = probe(oauthKv(), (method) => failing && method === "delete");
    const recording = recordingKv(base.kv, () => NOW);
    await expect(recording.kv.delete(GRANT_KEY)).rejects.toThrow("KV-FAILURE");
    expect(await oauthKv().get(revocationKey(GRANT))).not.toBeNull();
    expect(await oauthKv().get(GRANT_KEY)).toBe("{}");
    expect(recording.failed()).toBe(true);
    failing = false;
    await recording.kv.delete(GRANT_KEY);
    expect(await oauthKv().get(GRANT_KEY)).toBeNull();
  });

  it("refuses to delete a grant key of another shape", async () => {
    const odd = "grant:owner";
    await oauthKv().put(odd, "{}");
    const recording = recordingKv(oauthKv(), () => NOW);
    await expect(recording.kv.delete(odd)).rejects.toThrow("not a grant key of the library's shape");
    expect(await oauthKv().get(odd)).toBe("{}");
    expect((await oauthKv().list({ prefix: "revoked:" })).keys).toEqual([]);
  });

  it("writes no record when a token, a client or a transaction is deleted", async () => {
    const keys = [`token:owner:${GRANT}:hash`, "client:abc", "transaction:xyz"];
    for (const key of keys) await oauthKv().put(key, "{}");
    const logs = captureLogs();
    const recording = recordingKv(oauthKv(), () => NOW);
    for (const key of keys) await recording.kv.delete(key);
    expect((await oauthKv().list()).keys).toEqual([]);
    expect(logs.lines).toEqual([]);
  });

  it("passes every other call through unchanged, on the binding itself", async () => {
    const recording = recordingKv(oauthKv(), () => NOW);
    await recording.kv.put("client:a", JSON.stringify({ n: 1 }), { metadata: { m: 2 }, expirationTtl: 3_600 });
    expect(await recording.kv.get("client:a", { type: "json" })).toEqual({ n: 1 });
    const read = await recording.kv.getWithMetadata("client:a");
    expect(read.metadata).toEqual({ m: 2 });
    const listed = await recording.kv.list({ prefix: "client:" });
    expect(listed.keys.map((key) => key.name)).toEqual(["client:a"]);
    expect(recording.failed()).toBe(false);
  });

  it("marks a failed call, even one the caller catches", async () => {
    const base = probe(oauthKv(), (method) => method === "get");
    const recording = recordingKv(base.kv, () => NOW);
    await recording.kv.get("client:a").catch(() => undefined);
    expect(recording.failed()).toBe(true);
    expect(recordingKv(base.kv, () => NOW).failed()).toBe(false);
  });
});

describe("OAUTH-5: the revocation record's read", () => {
  it("names the grant of a code or token of the library's form, and the key the library reads it under", () => {
    expect(grantOf(`owner:${GRANT}:secret`)).toEqual({ id: GRANT, key: GRANT_KEY });
    for (const malformed of ["", "owner", `owner:${GRANT}`, `owner:${GRANT}:a:b`]) {
      expect(grantOf(malformed)).toBeUndefined();
    }
  });

  it("measures a key in UTF-8 bytes against KV's limit of 512", () => {
    expect(fitsKvKey("k".repeat(512))).toBe(true);
    expect(fitsKvKey("k".repeat(513))).toBe(false);
    expect(fitsKvKey("é".repeat(256))).toBe(true);
    expect(fitsKvKey(`k${"é".repeat(256)}`)).toBe(false);
  });

  it("finds a record and the absence of one", async () => {
    await oauthKv().put(revocationKey(GRANT), "2026-11-16T09:00:00.000Z");
    expect(await hasRevocationRecord(oauthKv(), GRANT, 2_000)).toBe(true);
    expect(await hasRevocationRecord(oauthKv(), "ZZZZZZZZZZZZZZZZ", 2_000)).toBe(false);
  });

  it("rejects when the read does not answer in time (RES-2)", async () => {
    const hanging = new Proxy(oauthKv(), {
      get: (target, property) => (property === "get" ? never : Reflect.get(target, property, target)),
    });
    await expect(hasRevocationRecord(hanging, GRANT, 50)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("answers no record, without a read, for an ID whose key would pass KV's limit", async () => {
    const base = probe(oauthKv());
    expect(await hasRevocationRecord(base.kv, "x".repeat(505), 2_000)).toBe(false);
    expect(base.calls).toEqual([]);
    expect(await hasRevocationRecord(base.kv, "x".repeat(504), 2_000)).toBe(false);
    expect(base.calls).toEqual([`get revoked:${"x".repeat(504)}`]);
  });
});
