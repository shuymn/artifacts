/**
 * Revocation records (design.md section 7, "Revocation"; OAUTH-5). The OAuth library reads a grant and later writes it
 * back during a refresh or a code exchange, so a deletion between the two is undone, and checking an access token reads
 * only the token's record. Every revocation therefore leaves a record, `revoked:<grant ID>`, which never expires, and
 * the router refuses every later use of a grant that has one.
 *
 * The library reaches `OAUTH_KV` only through `recordingKv`: every call passes through unchanged, except that deleting
 * a grant first writes its record and deletes only once that write has succeeded, so a failed write fails the deletion.
 * Only the library's `revokeGrant` deletes a grant key. The library never reads, writes, lists or deletes a `revoked:`
 * key: its keys start with `client:`, `grant:`, `token:`, `transaction:`, `client-assertion-jti:` or `enterprise-jti:`.
 */
import { logEvent } from "./log.ts";
import { withTimeout } from "./timeout.ts";

declare const grantIdBrand: unique symbol;
/** A grant ID as the library generates it: 16 characters of `A-Za-z0-9-_`. Only `isGrantId` makes one. */
export type GrantId = string & { readonly [grantIdBrand]: true };

const GRANT_ID = /^[A-Za-z0-9_-]{16}$/;

export function isGrantId(value: string): value is GrantId {
  return GRANT_ID.test(value);
}

/** `grant:<user>:<grant ID>`; the library refuses a user ID with `:`. */
const GRANT_KEY = /^grant:[^:]+:([^:]+)$/;
/** KV refuses a key longer than 512 bytes. */
const MAX_KEY_BYTES = 512;

export function revocationKey(grantId: string): string {
  return `revoked:${grantId}`;
}

export type RecordingKv = {
  /** `OAUTH_KV` as the library sees it. */
  readonly kv: KVNamespace;
  /** Whether a call through `kv` failed, including one the library caught. */
  readonly failed: () => boolean;
};

/** The library's view of `base` for one request; `now` dates the records it writes. */
export function recordingKv(base: KVNamespace, now: () => number): RecordingKv {
  let failed = false;
  const observe = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const remove = async (key: string): Promise<void> => {
    if (key.startsWith("grant:")) {
      const grant = GRANT_KEY.exec(key)?.[1];
      // Never a deletion without a record: a grant key of another shape is refused rather than deleted.
      if (grant === undefined) throw new Error("not a grant key of the library's shape");
      await base.put(revocationKey(grant), new Date(now()).toISOString());
      logEvent("grant.revoked", isGrantId(grant) ? { grant } : {});
    }
    await base.delete(key);
  };
  const kv = new Proxy(base, {
    get(target, property) {
      if (property === "delete") return (key: string) => observe(() => remove(key));
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      // Each method is called on the binding itself, which must see itself as `this`.
      return (...args: unknown[]) => observe(async () => (await value.apply(target, args)) as unknown);
    },
  });
  return { kv, failed: () => failed };
}

/** The grant ID of a code or token of the library's form, `<user>:<grant ID>:<secret>`. */
export function grantIdOf(credential: string): string | undefined {
  const parts = credential.split(":");
  return parts.length === 3 ? parts[1] : undefined;
}

/**
 * Whether the grant `grantId` has a revocation record, read under the KV-read timeout (RES-2). A grant ID whose record
 * key would pass KV's key limit names no grant, since its grant key is longer still.
 */
export async function hasRevocationRecord(kv: KVNamespace, grantId: string, timeoutMs: number): Promise<boolean> {
  const key = revocationKey(grantId);
  if (new TextEncoder().encode(key).byteLength > MAX_KEY_BYTES) return false;
  return (await withTimeout(kv.get(key), timeoutMs)) !== null;
}
