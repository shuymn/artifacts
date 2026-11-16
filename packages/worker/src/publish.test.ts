import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BucketProbe,
  captureLogs,
  DatabaseProbe,
  gate,
  logEvents,
  never,
  objectKeys,
  r2Error,
  sha256Text,
  snapshot,
  TOKENS,
  World,
  type PublishJson,
} from "./test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const SHORT = { r2Ms: 50, d1ReadMs: 50, kvReadMs: 50 };

function withBucket(world: World): BucketProbe {
  const probe = new BucketProbe();
  world.env = { ...world.env, FILES: probe.binding };
  return probe;
}

function withDatabase(world: World): DatabaseProbe {
  const probe = new DatabaseProbe();
  world.env = { ...world.env, DB: probe.binding };
  return probe;
}

/** Waits until `ready` holds, a few milliseconds at a time, failing after a bound. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!ready()) throw new Error("the condition never held");
}

type StoredRow = Record<string, unknown> & { number: number };

async function versionRows(id: string): Promise<{ versions: StoredRow[]; files: StoredRow[] }> {
  const [versions, files] = await env.DB.batch<StoredRow>([
    env.DB.prepare("SELECT * FROM versions WHERE artifact_id = ?1 ORDER BY number").bind(id),
    env.DB.prepare("SELECT * FROM version_files WHERE artifact_id = ?1 ORDER BY number, path").bind(id),
  ]);
  return { versions: versions?.results ?? [], files: files?.results ?? [] };
}

async function latest(world: World, id: string): Promise<number> {
  const response = await world.api("GET", `/v1/artifacts/${id}`);
  return (await response.json<PublishJson>()).artifact.latest_version;
}

const BASE = { "index.html": "index v1", "a.txt": "a v1", "b.txt": "b v1" };

// PL-23, section 4: the merge of an update.
describe("section 4: update merge", () => {
  it.each<[string, Record<string, unknown>, Record<string, string>]>([
    ["omitting files keeps every base file", {}, { "index.html": "index v1", "a.txt": "a v1", "b.txt": "b v1" }],
    [
      "a new path is added",
      { files: { "c.txt": "c" } },
      { "index.html": "index v1", "a.txt": "a v1", "b.txt": "b v1", "c.txt": "c" },
    ],
    [
      "a provided path replaces",
      { files: { "a.txt": "a v2" } },
      { "index.html": "index v1", "a.txt": "a v2", "b.txt": "b v1" },
    ],
    ["a removed path goes", { remove: ["a.txt"] }, { "index.html": "index v1", "b.txt": "b v1" }],
    [
      "all at once",
      { files: { "index.html": "index v2", "d/e.txt": "e" }, remove: ["a.txt", "b.txt"] },
      { "index.html": "index v2", "d/e.txt": "e" },
    ],
  ])("%s", async (_name, change, expected) => {
    const world = new World();
    const created = await world.created({ title: "t", description: "d", files: BASE });
    const id = created.artifact.id;
    const updated = await world.updated(id, { base_version: 1, ...change });
    expect(updated.version.number).toBe(2);
    expect(updated.version.files.map((f) => f.path)).toEqual(Object.keys(expected).toSorted());
    for (const [path, body] of Object.entries(expected)) {
      expect(await (await world.content(id, `/${path}`)).text()).toBe(body);
    }
    expect(updated.version.file_count).toBe(Object.keys(expected).length);
    expect(updated.version.total_bytes).toBe(Object.values(expected).reduce((n, b) => n + b.length, 0));
    // The base is unchanged.
    expect(await (await world.content(id, "/_v/1/a.txt")).text()).toBe("a v1");
  });

  it("keeps the base's title and description unless given", async () => {
    const world = new World();
    const created = await world.created({ title: "first", description: "about", files: BASE });
    const id = created.artifact.id;
    const kept = await world.updated(id, { base_version: 1 });
    expect(kept.version).toMatchObject({ title: "first", description: "about" });
    const changed = await world.updated(id, { base_version: 2, title: "second", description: "" });
    expect(changed.version).toMatchObject({ title: "second", description: "" });
    expect(changed.artifact).toMatchObject({ title: "second", description: "" });
  });

  it.each<[string, Record<string, unknown>, { field: string; reason: string }]>([
    [
      "a path both provided and removed",
      { files: { "a.txt": "x" }, remove: ["a.txt"] },
      { field: "remove[0]", reason: "provided_and_removed" },
    ],
    ["a removed path the base lacks", { remove: ["zzz.txt"] }, { field: "remove[0]", reason: "not_in_base" }],
    ["a path removed twice", { remove: ["a.txt", "a.txt"] }, { field: "remove[1]", reason: "duplicate_path" }],
    ["removing index.html", { remove: ["index.html"] }, { field: "files", reason: "missing_index" }],
  ])("refuses %s", async (_name, change, issue) => {
    const world = new World();
    const created = await world.created({ title: "t", files: BASE });
    const before = await snapshot();
    const response = await world.update(created.artifact.id, { base_version: 1, ...change });
    expect(response.status).toBe(400);
    const body = await response.json<{ error: { code: string; issues: unknown[] } }>();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.issues).toContainEqual(issue);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses an update that removes index.html with the entry-file message", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: BASE });
    const response = await world.update(created.artifact.id, { base_version: 1, remove: ["index.html"] });
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request", message: "every version needs index.html at its root" },
    });
  });

  it("refuses a create without index.html with the entry-file message", async () => {
    const world = new World();
    const response = await world.create({ title: "t", files: { "main.html": "x", "sub/index.html": "y" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "every version needs index.html at its root",
        issues: [{ field: "files", reason: "missing_index" }],
      },
    });
  });

  it("refuses a path given twice, after NFC", async () => {
    const world = new World();
    const response = await world.create({ title: "t", files: { "index.html": "i", café: "1", café: "2" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { issues: [{ field: "files[2].path", reason: "duplicate_path" }] },
    });
  });
});

// PL-32, section 6: reserved first segments, before any write.
describe("section 6: reserved paths", () => {
  it.each([
    ["create", { "index.html": "i", "_v/1/index.html": "x" }],
    ["create", { "index.html": "i", "cdn-cgi/trace": "x" }],
    ["update", { "_v/x": "x" }],
    ["update", { "cdn-cgi/x": "x" }],
  ])("refuses a reserved path on %s, writing nothing", async (kind, files) => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const before = await snapshot();
    const bucket = withBucket(world);
    const response =
      kind === "create"
        ? await world.create({ title: "t", files })
        : await world.update(created.artifact.id, { base_version: 1, files });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request", issues: [{ reason: "reserved_path" }] },
    });
    expect(bucket.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a reserved path in remove", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const response = await world.update(created.artifact.id, { base_version: 1, remove: ["_v/1/index.html"] });
    expect(await response.json()).toMatchObject({
      error: { issues: [{ field: "remove[0]", reason: "reserved_path" }] },
    });
  });
});

// PL-21, section 3: content-addressed writes.
describe("section 3: deduplicated uploads", () => {
  it("writes equal bytes once", async () => {
    const world = new World();
    const bucket = withBucket(world);
    const created = await world.created({
      title: "t",
      files: { "index.html": "same", "copy.html": "same", "x.txt": "x" },
    });
    expect(bucket.count("head")).toBe(2);
    expect(bucket.count("put")).toBe(2);
    expect(await objectKeys(created.artifact.id)).toHaveLength(2);
  });

  it("does not look up hashes the base references, and does not rewrite an existing object", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i", "x.txt": "kept bytes" } });
    const id = created.artifact.id;
    await world.updated(id, { base_version: 1, remove: ["x.txt"] });

    const bucket = withBucket(world);
    // Bytes the base (version 2) references: no head, no put.
    await world.updated(id, { base_version: 2, files: { "again.html": "i" } });
    expect(bucket.calls).toEqual([]);
    // Bytes stored for version 1 but not referenced by the base: a head finds them, no put.
    await world.updated(id, { base_version: 3, files: { "y.txt": "kept bytes" } });
    expect(bucket.count("head")).toBe(1);
    expect(bucket.count("put")).toBe(0);
  });

  it.each([
    ["its code property only", "property"],
    ["its message only", "message"],
  ] as const)("retries a put rate-limited by %s after a second", async (_, carrier) => {
    const world = new World();
    const bucket = withBucket(world);
    bucket.behave = (op, _key, count) =>
      op === "put" && count === 1 ? Promise.reject(r2Error(10058, carrier)) : undefined;
    const response = await world.create({ title: "t", files: { "index.html": "i" } });
    expect(response.status).toBe(201);
    expect(bucket.count("put")).toBe(2);
    expect(world.sleeps).toEqual([1000]);
  });

  it("fails the publish after two retries, committing nothing", async () => {
    const world = new World();
    const before = await snapshot();
    const bucket = withBucket(world);
    bucket.behave = (op) => (op === "put" ? Promise.reject(r2Error(10058)) : undefined);
    const response = await world.create({ title: "t", files: { "index.html": "i" } });
    expect(response.status).toBe(500);
    expect(bucket.count("put")).toBe(3);
    expect(world.sleeps).toEqual([1000, 1000]);
    expect((await snapshot()).artifacts).toEqual(before.artifacts);
  });

  it("does not retry other put errors", async () => {
    const world = new World();
    const bucket = withBucket(world);
    bucket.behave = (op) => (op === "put" ? Promise.reject(r2Error(10001)) : undefined);
    expect((await world.create({ title: "t", files: { "index.html": "i" } })).status).toBe(500);
    expect(bucket.count("put")).toBe(1);
    expect(world.sleeps).toEqual([]);
  });
});

// PL-18, VER-2: a publish is visible only through its commit.
describe("VER-2: all or nothing", () => {
  it.each([1, 2, 3])("leaves no version when upload %i of a create fails", async (failing) => {
    const world = new World();
    const before = await snapshot();
    const bucket = withBucket(world);
    bucket.behave = (op, _key, count) =>
      op === "put" && count === failing ? Promise.reject(new Error("boom")) : undefined;
    const response = await world.create({ title: "t", files: { "index.html": "1", "b.txt": "2", "c.txt": "3" } });
    expect(response.status).toBe(500);
    const after = await snapshot();
    expect([after.artifacts, after.versions, after.files]).toEqual([before.artifacts, before.versions, before.files]);
  });

  it.each([1, 2])("leaves the latest version when upload %i of an update fails", async (failing) => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const id = created.artifact.id;
    const before = await versionRows(id);
    const bucket = withBucket(world);
    bucket.behave = (op, _key, count) =>
      op === "put" && count === failing ? Promise.reject(new Error("boom")) : undefined;
    const response = await world.update(id, { base_version: 1, files: { "a.txt": "a", "b.txt": "b" } });
    expect(response.status).toBe(500);
    expect(await versionRows(id)).toEqual(before);
    expect(await latest(world, id)).toBe(1);
  });

  it.each(["head", "put"] as const)("answers 503 and commits nothing when an R2 %s times out", async (op) => {
    const world = new World({ timeouts: SHORT });
    const before = await snapshot();
    const bucket = withBucket(world);
    bucket.behave = (called) => (called === op ? never() : undefined);
    const response = await world.create({ title: "t", files: { "index.html": "i" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
    const after = await snapshot();
    expect([after.artifacts, after.versions, after.files]).toEqual([before.artifacts, before.versions, before.files]);
  });

  it("rolls the whole commit back when one statement fails", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const id = created.artifact.id;
    const before = await snapshot();
    const db = withDatabase(world);
    db.behave = (_index, statements) => (statements.length > 2 ? DatabaseProbe.failing(env.DB, statements) : undefined);

    expect((await world.create({ title: "t2", files: { "index.html": "x", "y.txt": "y" } })).status).toBe(500);
    expect((await world.update(id, { base_version: 1, files: { "z.txt": "z" } })).status).toBe(500);
    const after = await snapshot();
    expect([after.artifacts, after.versions, after.files]).toEqual([before.artifacts, before.versions, before.files]);
  });

  it("keeps a create whose response was lost: a listing finds it and its objects remain", async () => {
    const world = new World();
    const response = await world.create({ title: "lost create", files: { "index.html": "i" } });
    await response.body?.cancel();
    const list = await (
      await world.api("GET", "/v1/artifacts?limit=100")
    ).json<{ artifacts: { id: string; title: string }[] }>();
    const found = list.artifacts.find((a) => a.title === "lost create");
    expect(found).toBeDefined();
    expect(await objectKeys(found?.id ?? "")).toHaveLength(1);
  });

  it("answers a retried update whose first response was lost with version_conflict", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const id = created.artifact.id;
    const change = { base_version: 1, files: { "a.txt": "a" } };
    await (await world.update(id, change)).body?.cancel();
    const retried = await world.update(id, change);
    expect(retried.status).toBe(409);
    expect(await retried.json()).toEqual({
      error: { code: "version_conflict", message: "base_version is not the latest version", latest_version: 2 },
    });
    expect(await objectKeys(id)).toHaveLength(2);
  });
});

// PL-19, VER-3.
describe("VER-3: updates commit only on the latest version", () => {
  it("refuses a stale or future base", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const id = created.artifact.id;
    await world.updated(id, { base_version: 1 });
    const before = await snapshot();
    for (const base of [1, 3]) {
      const response = await world.update(id, { base_version: base, files: { "x.txt": "x" } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "version_conflict", latest_version: 2 } });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("commits exactly one of two concurrent updates from one base, without mixing files", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const id = created.artifact.id;
    const bucket = withBucket(world);
    const held = gate();
    bucket.behave = (op) => (op === "head" ? held.promise.then(() => env.FILES.head("none")) : undefined);

    const first = world.update(id, { base_version: 1, files: { "first.txt": "first" } });
    const second = world.update(id, { base_version: 1, files: { "second.txt": "second" } });
    await until(() => bucket.count("head") === 2);
    held.open();
    const statuses = [(await first).status, (await second).status].toSorted((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const got = await (await world.api("GET", `/v1/artifacts/${id}`)).json<PublishJson>();
    expect(got.artifact.latest_version).toBe(2);
    const paths = got.version.files.map((f) => f.path);
    expect([
      ["first.txt", "index.html"],
      ["index.html", "second.txt"],
    ]).toContainEqual(paths);
  });

  it("commits nothing when the artifact is deleted between upload and commit", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const id = created.artifact.id;
    const bucket = withBucket(world);
    const held = gate();
    bucket.behave = (op) => (op === "head" ? held.promise.then(() => env.FILES.head("none")) : undefined);

    const update = world.update(id, { base_version: 1, files: { "late.txt": "late" } });
    await until(() => bucket.count("head") === 1);
    // The delete lists and deletes objects; only heads are held.
    expect((await world.api("DELETE", `/v1/artifacts/${id}`)).status).toBe(204);
    held.open();

    const response = await update;
    expect(response.status).toBe(404);
    expect(await versionRows(id)).toEqual({ versions: [], files: [] });
  });
});

// PL-20, VER-1, VER-4.
describe("VER-1: stored versions never change", () => {
  it("keeps earlier versions' rows and bytes, keyed by the SHA-256 of their bytes", async () => {
    const world = new World();
    const a = await world.created({ title: "a", files: { "index.html": "shared", "x.txt": "x1" } });
    const b = await world.created({ title: "b", files: { "index.html": "shared" } });
    const id = a.artifact.id;
    const v1 = await versionRows(id);
    await world.updated(id, { base_version: 1, files: { "x.txt": "x2", "y.txt": "shared" } });
    await world.updated(id, { base_version: 2, remove: ["x.txt"], title: "a3" });

    const after = await versionRows(id);
    expect(after.versions.slice(0, v1.versions.length)).toEqual(v1.versions);
    expect(after.files.filter((f) => f.number === 1)).toEqual(v1.files);

    // Every object is a/<id>/<sha256 of its bytes>, and equal bytes in two artifacts are two objects.
    for (const artifact of [id, b.artifact.id]) {
      for (const key of await objectKeys(artifact)) {
        const object = await env.FILES.get(key);
        expect(key).toBe(`a/${artifact}/${await sha256Text((await object?.text()) ?? "")}`);
      }
    }
    expect(await objectKeys(id)).toHaveLength(3);
    expect(await objectKeys(b.artifact.id)).toHaveLength(1);
    expect(await (await world.content(id, "/_v/1/x.txt")).text()).toBe("x1");
    expect(await (await world.content(id, "/_v/2/x.txt")).text()).toBe("x2");
    expect((await world.content(id, "/_v/3/x.txt")).status).toBe(404);
  });
});

const MiB = 1024 * 1024;

/** A multipart create body of exactly `total` bytes, as a stream without a Content-Length. */
function exactBody(total: number): { body: ReadableStream<Uint8Array>; contentType: string } {
  const boundary = "bound";
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n` +
      `${JSON.stringify({ title: "big", files: [{ path: "index.html" }] })}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f"\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  let remaining = total - head.length - tail.length;
  let stage = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 0) {
        stage = 1;
        controller.enqueue(head);
      } else if (remaining > 0) {
        const n = Math.min(remaining, chunk.length);
        remaining -= n;
        controller.enqueue(chunk.subarray(0, n));
      } else {
        controller.enqueue(tail);
        controller.close();
      }
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** `n` files of equal bytes, index.html first. */
function manyFiles(n: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [i === 0 ? "index.html" : `f${i}`, "same"]));
}

/** A JSON PATCH body of exactly `size` bytes. */
function patchBody(size: number): string {
  const text = JSON.stringify({ public: true });
  return `${text}${" ".repeat(size - text.length)}`;
}

// PL-24, RES-1: request bounds, counted while read.
describe("RES-1: request bounds", () => {
  it("accepts a 32 MiB publish body and refuses one byte more, without Content-Length", async () => {
    const world = new World();
    const at = exactBody(32 * MiB);
    const accepted = await world.api("POST", "/v1/artifacts", {
      body: at.body,
      headers: { "Content-Type": at.contentType },
    });
    expect(accepted.status).toBe(201);

    const before = await snapshot();
    const over = exactBody(32 * MiB + 1);
    const refused = await world.api("POST", "/v1/artifacts", {
      body: over.body,
      headers: { "Content-Type": over.contentType },
    });
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a declared length over the bound before reading", async () => {
    const world = new World();
    const bucket = withBucket(world);
    const request = new Request(`https://artifacts-api.example.com/v1/artifacts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKENS.codex}`,
        "Content-Type": "multipart/form-data; boundary=x",
        "Content-Length": String(32 * MiB + 1),
      },
      body: "--x--",
    });
    expect((await world.fetch(request)).status).toBe(413);
    expect(bucket.calls).toEqual([]);
  });

  it("bounds a PATCH body at 4 KiB", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const id = created.artifact.id;
    const send = (body: string) =>
      world.api("PATCH", `/v1/artifacts/${id}`, { body, headers: { "Content-Type": "application/json" } });
    expect((await send(patchBody(4096))).status).toBe(200);
    expect((await send(patchBody(4097))).status).toBe(413);
  });

  it("bounds files per request and per version at 2000", async () => {
    const world = new World();
    const over = await world.create({ title: "t", files: manyFiles(2001) });
    expect(over.status).toBe(400);
    expect(await over.json()).toMatchObject({ error: { issues: [{ field: "files", reason: "too_many" }] } });

    const full = await world.created({ title: "t", files: manyFiles(2000) });
    const id = full.artifact.id;
    const add = await world.update(id, { base_version: 1, files: { extra: "same" } });
    expect(add.status).toBe(400);
    expect(await add.json()).toMatchObject({ error: { issues: [{ field: "files", reason: "too_many" }] } });
    const swap = await world.update(id, { base_version: 1, files: { extra: "same" }, remove: ["f1"] });
    expect(swap.status).toBe(201);
  });

  it("refuses a title over 1 KiB through REST", async () => {
    const world = new World();
    const response = await world.create({ title: "t".repeat(1025), files: { "index.html": "i" } });
    expect(await response.json()).toMatchObject({ error: { issues: [{ field: "title", reason: "too_long" }] } });
  });
});

// PL-25, RES-2.
describe("RES-2: bounded waits", () => {
  it("answers 503 when a D1 read times out, for the API and for serving", async () => {
    const world = new World({ timeouts: SHORT });
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const id = created.artifact.id;
    const db = withDatabase(world);
    db.behave = () => never();
    expect((await world.api("GET", `/v1/artifacts/${id}`)).status).toBe(503);
    expect((await world.api("GET", "/v1/artifacts")).status).toBe(503);
    expect((await world.api("GET", `/v1/artifacts/${id}/versions`)).status).toBe(503);
    expect((await world.content(id, "/")).status).toBe(503);
    const update = await world.update(id, { base_version: 1, files: { "x.txt": "x" } });
    expect(update.status).toBe(503);
  });

  it("answers 503 when the R2 read of a served file times out", async () => {
    const world = new World({ timeouts: SHORT });
    const created = await world.created({ title: "t", files: { "index.html": "i" } });
    const bucket = withBucket(world);
    bucket.behave = (op) => (op === "get" ? never() : undefined);
    expect((await world.content(created.artifact.id, "/")).status).toBe(503);
    expect((await world.api("GET", `/v1/artifacts/${created.artifact.id}/versions/1/files/index.html`)).status).toBe(
      503,
    );
  });

  it("gives the commit no timeout", async () => {
    const world = new World({ timeouts: SHORT });
    const db = withDatabase(world);
    db.behave = (_index, statements) =>
      new Promise((resolve) => setTimeout(resolve, 200)).then(() => env.DB.batch(statements));
    const response = await world.create({ title: "slow commit", files: { "index.html": "i" } });
    expect(response.status).toBe(201);
  });
});

// PL-7, TOK-3.
describe("TOK-3: every version and change records its token", () => {
  it("stores published_by and logs the token name of each change", async () => {
    const world = new World();
    const logs = captureLogs();
    const created = await world.created({ title: "t", files: { "index.html": "i" } }, TOKENS.codex);
    const id = created.artifact.id;
    expect(created.version.published_by).toBe("codex");
    const updated = await world.update(id, { base_version: 1 }, TOKENS.claude);
    expect((await updated.json<PublishJson>()).version.published_by).toBe("claude");
    await world.patch(id, { public: true }, TOKENS.claude);
    await world.patch(id, { archive: "kept" }, TOKENS.codex);
    await world.api("DELETE", `/v1/artifacts/${id}`, { token: TOKENS.claude });

    const versions = await world.api("GET", `/v1/artifacts/${id}/versions`);
    expect(await versions.json()).toMatchObject({ error: { code: "not_found" } });
    expect(logEvents(logs.lines).filter((line) => line.artifact === id)).toEqual([
      { event: "artifact.created", token: "codex", artifact: id, version: 1 },
      { event: "artifact.updated", token: "claude", artifact: id, version: 2 },
      { event: "artifact.changed", token: "claude", artifact: id, public: true },
      { event: "artifact.changed", token: "codex", artifact: id, archive: "kept" },
      { event: "artifact.deleted", token: "claude", artifact: id },
    ]);
  });
});
