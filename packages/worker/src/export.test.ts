// PL-60 to PL-62: a version exported as a ZIP archive (design.md section 8, "Export"), on the REST route and the app
// host's download. The real HTTP response is in e2e.test.ts, ZIP64 at its boundaries in export-zip64.test.ts.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_AUD,
  APP_HOST,
  BucketProbe,
  captureLogs,
  DatabaseProbe,
  logEvents,
  never,
  sha256Text,
  World,
  type FileSpec,
} from "./test-support.ts";
import { crc32, dosTime, readZip } from "./zip-test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text);

/** The object key of a file whose bytes are `text`. */
const keyOf = async (id: string, text: string) => `a/${id}/${await sha256Text(text)}`;

const restPath = (id: string, version: number) => `/v1/artifacts/${id}/versions/${version}/export`;

function rest(world: World, id: string, version: number, options: { method?: string; token?: null } = {}) {
  return world.api(options.method ?? "GET", restPath(id, version), options.token === null ? { token: null } : {});
}

/** The app host's download, with an app-audience JWT unless `jwt` is given. */
async function download(
  world: World,
  path: string,
  options: { method?: string; jwt?: string | null } = {},
): Promise<Response> {
  const headers = new Headers();
  const jwt = options.jwt === undefined ? await world.jwt({ aud: APP_AUD }) : options.jwt;
  if (jwt !== null) headers.set("Cf-Access-Jwt-Assertion", jwt);
  return world.fetch(`https://${APP_HOST}${path}`, { method: options.method ?? "GET", headers });
}

/** A response body read to its end, or to the error that aborted it, with the bytes that arrived before. */
async function drain(response: Response): Promise<{ bytes: Uint8Array; error: unknown }> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let error: unknown;
  if (reader !== undefined) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } catch (caught) {
      error = caught ?? new Error("aborted");
    }
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, error };
}

async function publish(world: World, files: Readonly<Record<string, FileSpec>>): Promise<string> {
  return (await world.created({ title: "export", files })).artifact.id;
}

/** Resolves when `cancelled` resolves, or with "left open" after `ms`. */
async function settles(cancelled: Promise<void>, ms = 1_000): Promise<string> {
  return Promise.race([
    cancelled.then(() => "cancelled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("left open"), ms)),
  ]);
}

/** A body that sends `first` and then nothing until it is cancelled; `cancelled` resolves then. */
function stalledBody(first: Uint8Array) {
  const cancelled = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
    cancel() {
      cancelled.resolve();
    },
  });
  return { body, cancelled: cancelled.promise };
}

const FILES = {
  "index.html": "<!doctype html><title>export</title>",
  "a/b/c.txt": "nested",
  "データ/表.csv": "a,b\n1,2\n",
  "😀.txt": "astral",
  "ｚ.txt": "fullwidth",
  "100%.txt": "percent",
  "#frag.txt": "hash",
  "what?.txt": "question",
  "empty.txt": "",
  "bytes.bin": Uint8Array.from({ length: 256 }, (_, i) => i),
} satisfies Record<string, FileSpec>;

describe("PL-60: the archive", () => {
  it("holds exactly the version's files in path order, stored with UTF-8 names and the version's time", async () => {
    const world = new World();
    world.clock.now = Date.UTC(2026, 10, 16, 9, 30, 45, 500);
    const id = await publish(world, FILES);
    world.clock.now += 3_600_000;
    await world.updated(id, { base_version: 1, files: { "index.html": "v2", "later.txt": "v2 only" } });

    const listed = await (
      await world.api("GET", `/v1/artifacts/${id}/versions/1`)
    ).json<{
      version: { files: { path: string; size: number }[] };
    }>();
    const response = await rest(world, id, 1);
    expect(response.status).toBe(200);
    const archive = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get("Content-Length")).toBe(String(archive.byteLength));

    const { directory, files } = readZip(archive);
    // Path order is the API's: SQLite's binary order of the UTF-8 bytes, so U+FF5A comes before U+1F600.
    expect(files.map((file) => file.name)).toEqual(listed.version.files.map((file) => file.path));
    expect(files.map((file) => file.name).indexOf("ｚ.txt")).toBeLessThan(
      files.map((file) => file.name).indexOf("😀.txt"),
    );
    expect(Object.fromEntries(files.map((file) => [file.name, file.bytes]))).toEqual(
      Object.fromEntries(
        Object.entries(FILES).map(([path, body]) => [path, typeof body === "string" ? bytesOf(body) : body]),
      ),
    );
    const time = dosTime(Date.UTC(2026, 10, 16, 9, 30, 45, 500));
    for (const file of files) {
      expect(file).toMatchObject({ method: 0, versionNeeded: 45, zip64: false, ...time });
      // Bit 11: the name is UTF-8. Bit 3: sizes and CRC-32 follow the bytes.
      expect(file.flags).toBe(0x0808);
      expect(file.crc).toBe(crc32(file.bytes));
    }
    expect(directory.zip64).toBe(false);
  });

  it("has the same bytes on every export, on REST and on the app host's download", async () => {
    const world = new World();
    const id = await publish(world, FILES);
    const first = new Uint8Array(await (await rest(world, id, 1)).arrayBuffer());
    world.clock.now += 86_400_000;
    const second = new Uint8Array(await (await rest(world, id, 1)).arrayBuffer());
    const fromApp = new Uint8Array(await (await download(world, `/a/${id}/v/1/export`)).arrayBuffer());
    expect(second).toEqual(first);
    expect(fromApp).toEqual(first);
  });

  it("answers with section 8's headers on REST and the app host's class headers on the download", async () => {
    const world = new World();
    const id = await publish(world, FILES);
    const restAnswer = await rest(world, id, 1);
    const length = String((await restAnswer.clone().arrayBuffer()).byteLength);
    expect(Object.fromEntries(restAnswer.headers)).toEqual({
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${id}-v1.zip"`,
      "content-length": length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    // ISO-2, ISO-5: the app host's headers, with no-store in place of its revalidation.
    const appAnswer = await download(world, `/a/${id}/v/1/export`);
    expect(Object.fromEntries(appAnswer.headers)).toEqual({
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${id}-v1.zip"`,
      "content-length": length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "content-security-policy": expect.stringContaining("frame-ancestors 'none'"),
    });
  });

  it("answers HEAD with the GET's headers without reading R2", async () => {
    const world = new World();
    const id = await publish(world, FILES);
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const get = await rest(world, id, 1);
    await get.arrayBuffer();
    const gets = bucket.count("get");
    for (const head of [
      await rest(world, id, 1, { method: "HEAD" }),
      await download(world, `/a/${id}/v/1/export`, { method: "HEAD" }),
    ]) {
      expect(head.status).toBe(200);
      expect(head.headers.get("Content-Length")).toBe(get.headers.get("Content-Length"));
      expect(head.headers.get("Content-Disposition")).toBe(get.headers.get("Content-Disposition"));
      expect(await head.text()).toBe("");
    }
    expect(bucket.count("get")).toBe(gets);
  });

  it("answers not_found for an unknown, deleted or malformed artifact or version", async () => {
    const world = new World();
    const id = await publish(world, FILES);
    const deleted = await publish(world, { "index.html": "gone" });
    expect((await world.api("DELETE", `/v1/artifacts/${deleted}`)).status).toBe(204);
    for (const path of [
      restPath(id, 2),
      restPath(deleted, 1),
      restPath("x", 1),
      `/v1/artifacts/${id}/versions/01/export`,
    ]) {
      const response = await world.api("GET", path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
    for (const path of [
      `/a/${id}/v/2/export`,
      `/a/${deleted}/v/1/export`,
      `/a/${id}/v/01/export`,
      `/a/${id}/v/1/export/`,
    ]) {
      expect((await download(world, path)).status).toBe(404);
    }
  });
});

// PL-61: refused before any R2 read, naming every path that cannot be extracted as stored.
describe("PL-61: not_extractable", () => {
  const cases: { name: string; files: Record<string, string>; paths: string[] }[] = [
    { name: "a path with a backslash", files: { "index.html": "x", "a\\b": "x" }, paths: ["a\\b"] },
    { name: "a path another uses as a directory", files: { "index.html": "x", a: "x", "a/b": "x" }, paths: ["a"] },
    {
      name: "both, and deeper directories",
      files: { "index.html": "x", "x\\y": "x", a: "x", "a/b": "x", "c/d": "x", "c/d/e/f": "x", "c/d2": "x" },
      paths: ["a", "c/d", "x\\y"],
    },
  ];
  for (const { name, files, paths } of cases) {
    it(`refuses ${name}`, async () => {
      const world = new World();
      const id = await publish(world, files);
      const bucket = new BucketProbe();
      world.env = { ...world.env, FILES: bucket.binding };
      const response = await rest(world, id, 1);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "not_extractable",
          message: "the version has paths that cannot be extracted as stored; paths lists each",
          paths,
        },
      });
      const fromApp = await download(world, `/a/${id}/v/1/export`);
      expect(fromApp.status).toBe(409);
      expect(fromApp.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(await fromApp.json()).toMatchObject({ error: { code: "not_extractable", paths } });
      expect(bucket.count("get")).toBe(0);
    });
  }

  it("exports a version without such paths", async () => {
    const world = new World();
    const id = await publish(world, { "index.html": "x", "a/b": "x", "ab/c": "x", "a.b": "x", "a/b2/c": "x" });
    const response = await rest(world, id, 1);
    expect(response.status).toBe(200);
    expect(readZip(new Uint8Array(await response.arrayBuffer())).files.map((file) => file.name)).toEqual([
      "a.b",
      "a/b",
      "a/b2/c",
      "ab/c",
      "index.html",
    ]);
  });
});

// PL-62, RES-2: one body open at a time, each wait bounded, every body cancelled on every exit.
describe("PL-62: streaming", () => {
  // Path order: b.bin, c.txt, index.html.
  const THREE = { "b.bin": "first file", "c.txt": "MIDFILE and the rest", "index.html": "last" };

  it("holds at most one R2 body open", async () => {
    const world = new World();
    const id = await publish(world, { ...THREE, "d/e.txt": "more", "f.txt": "" });
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    let open = 0;
    let most = 0;
    bucket.behave = (op, key) => {
      if (op !== "get") return undefined;
      return env.FILES.get(key).then((object) => {
        if (object === null) return null;
        open++;
        most = Math.max(most, open);
        const reader = object.body.getReader();
        let closed = false;
        const close = () => {
          if (!closed) open--;
          closed = true;
        };
        return {
          body: new ReadableStream<Uint8Array>({
            async pull(controller) {
              // A body that takes its time, as R2's does: an object opened ahead of its turn would overlap.
              await new Promise((resolve) => setTimeout(resolve, 5));
              const { done, value } = await reader.read();
              if (done) {
                close();
                controller.close();
              } else {
                controller.enqueue(value);
              }
            },
            async cancel(reason) {
              close();
              await reader.cancel(reason);
            },
          }),
        };
      });
    };
    const { bytes, error } = await drain(await rest(world, id, 1));
    expect(error).toBeUndefined();
    expect(readZip(bytes).files).toHaveLength(5);
    expect(bucket.count("get")).toBe(5);
    expect(most).toBe(1);
    expect(open).toBe(0);
  });

  // The runtime tells the pipe of a cancelled response at its next write (checked in workerd), so the body sends one
  // more chunk after the client goes away; that write cancels the library's stream and the entries, while the read of
  // the chunk after it is still waiting. That read then ends short, which is not a failure.
  it("cancels the open body when the client goes away and gets no later object, without a log", async () => {
    const world = new World({ timeouts: { r2Ms: 200, d1ReadMs: 2_000, kvReadMs: 2_000 } });
    const middleText = `MIDFILE${"x".repeat(100_000)}`;
    const id = await publish(world, { ...THREE, "c.txt": middleText });
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const goOn = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let pulls = 0;
    const flowing = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          pulls++;
          if (pulls === 2) await goOn.promise;
          if (pulls > 2) await never();
          controller.enqueue(bytesOf(pulls === 1 ? "MIDFILE" : "x".repeat(10)));
        },
        cancel() {
          cancelled.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    const middle = await keyOf(id, middleText);
    bucket.behave = (op, key) => (op === "get" && key === middle ? Promise.resolve({ body: flowing }) : undefined);
    const logs = captureLogs();

    const response = await rest(world, id, 1);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    let seen = "";
    while (!seen.includes("MIDFILE")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("the archive ended");
      seen += new TextDecoder().decode(value);
    }
    await reader.cancel();
    goOn.resolve();
    expect(await settles(cancelled.promise)).toBe("cancelled");
    // Cancelled by the entries while its third read waited, long before its 100,007 bytes.
    expect(pulls).toBe(3);
    // Past the R2 timeout: a read left waiting would fail and log by now.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bucket.calls.filter((call) => call.op === "get").map((call) => call.key)).toEqual([
      await keyOf(id, THREE["b.bin"]),
      middle,
    ]);
    expect(logEvents(logs.lines).filter((event) => event.event === "operation.failed")).toEqual([]);
  });

  it("answers an operation error when the first get fails, stalls or finds no object", async () => {
    const world = new World({ timeouts: { r2Ms: 50, d1ReadMs: 2_000, kvReadMs: 2_000 } });
    const id = await publish(world, THREE);
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const outcomes: [() => Promise<unknown>, number, string][] = [
      [never, 503, "unavailable"],
      [() => Promise.reject(new Error("get failed")), 500, "internal"],
      [() => Promise.resolve(null), 500, "internal"],
    ];
    for (const [behavior, status, code] of outcomes) {
      bucket.behave = (op) => (op === "get" ? behavior() : undefined);
      const response = await rest(world, id, 1);
      expect(response.status).toBe(status);
      expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(await response.json()).toMatchObject({ error: { code } });
      expect((await download(world, `/a/${id}/v/1/export`)).status).toBe(status);
    }
  });

  it("aborts the stream when a later get fails or stalls, and logs operation.failed with its class", async () => {
    const world = new World({ timeouts: { r2Ms: 50, d1ReadMs: 2_000, kvReadMs: 2_000 } });
    const id = await publish(world, THREE);
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const outcomes: [() => Promise<unknown>, string][] = [
      [() => Promise.reject(new Error("get failed")), "error"],
      [never, "timeout"],
      [() => Promise.resolve(null), "object_missing"],
    ];
    const middle = await keyOf(id, THREE["c.txt"]);
    for (const [behavior, reason] of outcomes) {
      const logs = captureLogs();
      bucket.behave = (op, key) => (op === "get" && key === middle ? behavior() : undefined);
      const response = await rest(world, id, 1);
      expect(response.status).toBe(200);
      const { bytes, error } = await drain(response);
      expect(error).toBeDefined();
      expect(bytes.byteLength).toBeLessThan(Number(response.headers.get("Content-Length")));
      expect(logEvents(logs.lines).filter((event) => event.event === "operation.failed")).toEqual([
        { event: "operation.failed", reason, error: "other", artifact: id, version: 1 },
      ]);
      vi.restoreAllMocks();
    }
    // The file after the failure was never asked for.
    const last = await keyOf(id, THREE["index.html"]);
    expect(bucket.calls.filter((call) => call.op === "get" && call.key === last)).toEqual([]);
  });

  it("aborts the stream and cancels the body when it stalls between chunks past the timeout", async () => {
    const world = new World({ timeouts: { r2Ms: 50, d1ReadMs: 2_000, kvReadMs: 2_000 } });
    const id = await publish(world, THREE);
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const stalled = stalledBody(bytesOf("MIDFILE"));
    const middle = await keyOf(id, THREE["c.txt"]);
    bucket.behave = (op, key) => (op === "get" && key === middle ? Promise.resolve(stalled) : undefined);
    const logs = captureLogs();
    const { error } = await drain(await rest(world, id, 1));
    expect(error).toBeDefined();
    expect(await settles(stalled.cancelled)).toBe("cancelled");
    expect(bucket.count("get")).toBe(2);
    expect(logEvents(logs.lines).filter((event) => event.event === "operation.failed")).toEqual([
      { event: "operation.failed", reason: "timeout", error: "other", artifact: id, version: 1 },
    ]);
  });

  it("aborts the stream for an object shorter or longer than its listed size", async () => {
    const world = new World();
    const id = await publish(world, THREE);
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const middle = await keyOf(id, THREE["c.txt"]);
    for (const delivered of ["MIDFILE", `${THREE["c.txt"]}!`]) {
      const logs = captureLogs();
      bucket.behave = (op, key) =>
        op === "get" && key === middle ? Promise.resolve({ body: new Response(delivered).body }) : undefined;
      const response = await rest(world, id, 1);
      const { bytes, error } = await drain(response);
      expect(error).toBeDefined();
      expect(bytes.byteLength).toBeLessThan(Number(response.headers.get("Content-Length")));
      expect(logEvents(logs.lines).filter((event) => event.event === "operation.failed")).toEqual([
        { event: "operation.failed", reason: "error", error: "other", artifact: id, version: 1 },
      ]);
      vi.restoreAllMocks();
    }
  });

  // ACC-1, TOK-1: the download needs an app-audience JWT, REST a credential, before any D1 or R2 call.
  it("refuses the download without an app-audience JWT and REST without a credential", async () => {
    const world = new World();
    const id = await publish(world, THREE);
    const bucket = new BucketProbe();
    const database = new DatabaseProbe();
    world.env = { ...world.env, FILES: bucket.binding, DB: database.binding };
    expect((await download(world, `/a/${id}/v/1/export`, { jwt: null })).status).toBe(403);
    expect((await download(world, `/a/${id}/v/1/export`, { jwt: await world.jwt() })).status).toBe(403);
    expect((await rest(world, id, 1, { token: null })).status).toBe(401);
    expect(database.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
  });
});
