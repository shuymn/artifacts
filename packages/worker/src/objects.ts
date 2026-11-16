/**
 * File bytes in R2 (design.md section 3). A file's bytes are the object `a/<id>/<sha256 hex>`: equal bytes are stored
 * once per artifact and no object is shared between artifacts, so deleting an artifact deletes its prefix (VER-4). An
 * object's key is the SHA-256 the Worker computed from its bytes, and R2 checks it on `put` (VER-1).
 */
import type { ArtifactId } from "./id.ts";
import type { StorageFailure } from "./log.ts";
import { TimeoutError, withTimeout, type Timeouts } from "./timeout.ts";

/** Uploads in flight at once. */
const UPLOAD_CONCURRENCY = 6;
/** R2 accepts one write per second per key and answers others with 429; a rate-limited `put` is retried twice. */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_WAIT_MS = 1000;
/** R2's error code for 429 TooManyRequests, at the end of the binding's error message. */
const R2_TOO_MANY_REQUESTS = 10058;
/** R2 deletes at most 1000 keys per call and lists at most 1000 per page. */
const R2_PAGE = 1000;

export type ObjectStore = {
  readonly bucket: R2Bucket;
  readonly timeouts: Timeouts;
  readonly sleep: (ms: number) => Promise<void>;
};

/** A storage call that failed; `failure` is the logged reason. */
export class StorageError extends Error {
  override readonly name = "StorageError";
  constructor(readonly failure: StorageFailure) {
    super(failure);
  }
}

export function objectKey(id: ArtifactId, sha256: string): string {
  return `a/${id}/${sha256}`;
}

export function objectPrefix(id: ArtifactId): string {
  return `a/${id}/`;
}

function isRateLimited(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    ("code" in error && error.code === R2_TOO_MANY_REQUESTS) || error.message.endsWith(`(${R2_TOO_MANY_REQUESTS})`)
  );
}

function storageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  return new StorageError(error instanceof TimeoutError ? "timeout" : "error");
}

async function call<T>(store: ObjectStore, work: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(work(), store.timeouts.r2Ms);
  } catch (error) {
    throw storageError(error);
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export async function sha256Hex(body: Blob): Promise<string> {
  const digest = new crypto.DigestStream("SHA-256");
  await body.stream().pipeTo(digest);
  let hex = "";
  for (const byte of new Uint8Array(await digest.digest)) hex += HEX[byte];
  return hex;
}

async function put(store: ObjectStore, key: string, body: Blob, sha256: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await withTimeout(store.bucket.put(key, body, { sha256 }), store.timeouts.r2Ms);
      return;
    } catch (error) {
      if (!isRateLimited(error)) throw storageError(error);
      if (attempt >= RATE_LIMIT_RETRIES) throw new StorageError("rate_limited");
      await store.sleep(RATE_LIMIT_WAIT_MS);
    }
  }
}

/** Runs `work` over `items`, `size` at a time. After a failure no new item starts; the first error is thrown. */
async function inPool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  // One iterator shared by the runners: each takes the next item when it is free.
  const queue = items.values();
  let failed: { error: unknown } | undefined;
  const runner = async () => {
    for (const item of queue) {
      if (failed !== undefined) return;
      try {
        await work(item);
      } catch (error) {
        failed ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, runner));
  if (failed !== undefined) throw failed.error;
}

/**
 * Stores the bytes of each hash not in `present` (the hashes the base version references): `head` its key, `put` it
 * when missing. An existing object is already correct, being content-addressed. No locks: a concurrent publish of the
 * same bytes writes the same object.
 */
export async function uploadObjects(
  store: ObjectStore,
  id: ArtifactId,
  objects: ReadonlyMap<string, Blob>,
  present: ReadonlySet<string>,
): Promise<void> {
  const missing = [...objects].filter(([sha256]) => !present.has(sha256));
  await inPool(missing, UPLOAD_CONCURRENCY, async ([sha256, body]) => {
    const key = objectKey(id, sha256);
    const head = await call(store, () => store.bucket.head(key));
    if (head === null) await put(store, key, body, sha256);
  });
}

export async function getObject(store: ObjectStore, id: ArtifactId, sha256: string): Promise<R2ObjectBody> {
  let pending: Promise<R2ObjectBody | null> | undefined;
  let object: R2ObjectBody | null;
  try {
    object = await call(store, () => {
      pending = store.bucket.get(objectKey(id, sha256));
      return pending;
    });
  } catch (error) {
    // A get that answers after its timeout is not used: its body is cancelled, so no stream is left open.
    void pending?.then(
      (late) => late?.body.cancel().catch(() => {}),
      () => {},
    );
    throw error;
  }
  if (object === null) throw new StorageError("object_missing");
  return object;
}

/**
 * The whole body of a fetched object, read under the R2 timeout; at most `size` bytes, its stored size. The stream is
 * cancelled on every exit, so a body that stalls past the timeout is not left open.
 */
export async function readBody(store: ObjectStore, object: R2ObjectBody, size: number): Promise<Uint8Array> {
  const reader = object.body.getReader();
  const read = async () => {
    const bytes = new Uint8Array(size);
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > size) throw new StorageError("error");
      bytes.set(value, length);
      length += value.byteLength;
    }
    if (length !== size) throw new StorageError("error");
    return bytes;
  };
  try {
    return await call(store, read);
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** VER-4: deletes every object under the artifact's prefix, a page at a time. */
export async function deletePrefix(store: ObjectStore, id: ArtifactId): Promise<void> {
  const prefix = objectPrefix(id);
  let cursor: string | undefined;
  do {
    const options: R2ListOptions =
      cursor === undefined ? { prefix, limit: R2_PAGE } : { prefix, limit: R2_PAGE, cursor };
    const page = await call(store, () => store.bucket.list(options));
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await call(store, () => store.bucket.delete(keys));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}
