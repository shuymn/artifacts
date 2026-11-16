import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BucketProbe,
  clearStorage,
  CONTENT_SUFFIX,
  DAY_MS,
  gate,
  objectKeys,
  snapshot,
  START,
  World,
  type PublishJson,
} from "./test-support.ts";

beforeEach(async () => {
  await clearStorage();
});

type ArtifactJson = PublishJson["artifact"] & {
  archived: boolean;
  archive: string | null;
  updated_at: string;
  title: string;
};
type Page = { artifacts: ArtifactJson[]; next_cursor: string | null };

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function withBucket(world: World): BucketProbe {
  const probe = new BucketProbe();
  world.env = { ...world.env, FILES: probe.binding };
  return probe;
}

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!ready()) throw new Error("the condition never held");
}

/** Every page of a listing, following next_cursor. */
async function traverse(world: World, query: string, between?: (page: number) => Promise<void>): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const suffix: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const body: Page = await json<Page>(await world.api("GET", `/v1/artifacts?${query}${suffix}`));
    ids.push(...body.artifacts.map((a) => a.id));
    cursor = body.next_cursor;
    if (cursor === null) return ids;
    await between?.(page);
  }
  throw new Error("the listing never ended");
}

describe("REST contract", () => {
  it("creates, gets, lists versions, reads a file and deletes with the design's shapes", async () => {
    const world = new World();
    const created = await world.create({
      title: "Quarterly chart",
      files: { "index.html": "<p>chart</p>", "style.css": { body: "p{}", type: "text/css" } },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    const body = await json<PublishJson>(created);
    const id = body.artifact.id;
    expect(body).toEqual({
      artifact: {
        id,
        title: "Quarterly chart",
        description: "",
        public: false,
        archived: false,
        archive: null,
        latest_version: 1,
        created_at: "2026-11-16T09:00:00.000Z",
        updated_at: "2026-11-16T09:00:00.000Z",
        url: `https://${id}${CONTENT_SUFFIX}/`,
        public_url: null,
        gallery_url: `https://artifacts.example.com/a/${id}`,
      },
      version: {
        number: 1,
        created_at: "2026-11-16T09:00:00.000Z",
        published_by: "codex",
        title: "Quarterly chart",
        description: "",
        file_count: 2,
        total_bytes: 15,
        url: `https://${id}${CONTENT_SUFFIX}/_v/1/`,
        files: [
          {
            path: "index.html",
            size: 12,
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            content_type: "text/html; charset=utf-8",
          },
          { path: "style.css", size: 3, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), content_type: "text/css" },
        ],
      },
    });

    world.clock.now += 1000;
    await world.updated(id, { base_version: 1, title: "Quarterly chart v2" });
    expect(await json(await world.api("GET", `/v1/artifacts/${id}`))).toMatchObject({
      artifact: { latest_version: 2, title: "Quarterly chart v2", updated_at: "2026-11-16T09:00:01.000Z" },
      version: { number: 2, files: [{ path: "index.html" }, { path: "style.css" }] },
    });
    expect(await json(await world.api("GET", `/v1/artifacts/${id}/versions/1`))).toMatchObject({
      artifact: { latest_version: 2 },
      version: { number: 1, title: "Quarterly chart" },
    });
    const versions = await json<{ versions: Record<string, unknown>[]; next_cursor: null }>(
      await world.api("GET", `/v1/artifacts/${id}/versions`),
    );
    expect(versions.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(versions.versions.every((v) => !("files" in v))).toBe(true);
    expect(versions.next_cursor).toBeNull();

    const file = await world.api("GET", `/v1/artifacts/${id}/versions/1/files/style.css`);
    expect(file.headers.get("Content-Type")).toBe("text/css");
    expect(await file.text()).toBe("p{}");
    const directory = await world.api("GET", `/v1/artifacts/${id}/versions/1/files/sub`);
    expect(directory.status).toBe(404);

    const deleted = await world.api("DELETE", `/v1/artifacts/${id}`);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
  });

  it.each<[string, string, string]>([
    ["PUT", "/v1/artifacts", "GET, HEAD, POST"],
    ["DELETE", "/v1/artifacts", "GET, HEAD, POST"],
    ["POST", "/v1/artifacts/abcdefghijklmnopqrstuvwxyz", "GET, HEAD, PATCH, DELETE"],
    ["PATCH", "/v1/artifacts/abcdefghijklmnopqrstuvwxyz/versions", "GET, HEAD, POST"],
    ["POST", "/v1/artifacts/abcdefghijklmnopqrstuvwxyz/versions/1", "GET, HEAD"],
    ["DELETE", "/v1/artifacts/abcdefghijklmnopqrstuvwxyz/versions/1/files/index.html", "GET, HEAD"],
  ])("answers %s %s with 405 and Allow", async (method, path, allow) => {
    const world = new World();
    const response = await world.api(method, path);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(allow);
    expect(await response.json()).toMatchObject({ error: { code: "method_not_allowed" } });
  });

  it.each([
    ["/v1/artifacts/abc", "a malformed ID"],
    ["/v1/artifacts/abcdefghijklmnopqrstuvwxyz", "an unknown ID"],
    ["/v1/artifacts/abcdefghijklmnopqrstuvwxyz/versions/0", "version 0"],
    ["/v1/artifacts/abcdefghijklmnopqrstuvwxyz/versions/01", "a non-canonical version"],
    ["/v1/artifacts/abcdefghijklmnopqrstuvwxyz/other", "an unknown sub-route"],
    ["/v1/artifacts/abcdefghijklmnopqrstuvwxyz/versions/1/files", "a file route without a path"],
  ])("answers 404 not_found for %s (%s)", async (path) => {
    const world = new World();
    const response = await world.api("GET", path);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers 404 for a version past the latest and for a missing file", async () => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i", "docs/index.html": "d" } });
    expect((await world.api("GET", `/v1/artifacts/${artifact.id}/versions/2`)).status).toBe(404);
    expect((await world.api("GET", `/v1/artifacts/${artifact.id}/versions/1/files/nope`)).status).toBe(404);
    const dir = await world.api("GET", `/v1/artifacts/${artifact.id}/versions/1/files/docs`);
    expect(dir.status).toBe(308);
    expect(dir.headers.get("Location")).toBe(`/v1/artifacts/${artifact.id}/versions/1/files/docs/`);
    expect(await (await world.api("GET", `/v1/artifacts/${artifact.id}/versions/1/files/docs/`)).text()).toBe("d");
  });

  it.each<[string, Record<string, string>, BodyInit | undefined, number, string]>([
    ["a JSON create", { "Content-Type": "application/json" }, "{}", 415, "unsupported_media_type"],
    [
      "a multipart PATCH",
      { "Content-Type": "multipart/form-data; boundary=x" },
      "--x--",
      415,
      "unsupported_media_type",
    ],
  ])("refuses %s with %i", async (name, headers, body, status, code) => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i" } });
    const path = name.includes("PATCH") ? `/v1/artifacts/${artifact.id}` : "/v1/artifacts";
    const method = name.includes("PATCH") ? "PATCH" : "POST";
    const response = await world.api(method, path, { headers, ...(body === undefined ? {} : { body }) });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it.each<[string, (form: FormData) => void, { field: string; reason: string }]>([
    ["no meta part", () => {}, { field: "meta", reason: "required" }],
    ["meta that is not JSON", (form) => form.append("meta", "{nope"), { field: "meta", reason: "invalid_json" }],
    [
      "two meta parts",
      (form) => {
        form.append("meta", "{}");
        form.append("meta", "{}");
      },
      { field: "meta", reason: "duplicate_part" },
    ],
    [
      "a part with another name",
      (form) => {
        form.append("meta", JSON.stringify({ title: "t", files: [] }));
        form.append("files", new Blob(["x"]));
      },
      { field: "body", reason: "unknown_part" },
    ],
    [
      "fewer file parts than meta.files",
      (form) => form.append("meta", JSON.stringify({ title: "t", files: [{ path: "index.html" }] })),
      { field: "files", reason: "count_mismatch" },
    ],
  ])("refuses a multipart body with %s", async (_name, build, issue) => {
    const world = new World();
    const form = new FormData();
    build(form);
    const response = await world.api("POST", "/v1/artifacts", { body: form });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request", issues: [issue] } });
  });

  it("takes paths and types from meta only, ignoring part file names and types", async () => {
    const world = new World();
    const form = new FormData();
    form.append("meta", JSON.stringify({ title: "t", files: [{ path: "index.html" }, { path: "b.txt" }] }));
    form.append("file", new File(["page"], "evil/../name.js", { type: "application/x-evil" }));
    form.append("file", new Blob(["text part"]));
    const response = await world.api("POST", "/v1/artifacts", { body: form });
    expect(response.status).toBe(201);
    const body = await json<PublishJson>(response);
    expect(body.version.files.map((f) => [f.path, f.content_type])).toEqual([
      ["b.txt", "text/plain; charset=utf-8"],
      ["index.html", "text/html; charset=utf-8"],
    ]);
    expect(await (await world.content(body.artifact.id, "/b.txt")).text()).toBe("text part");
  });

  it("refuses a file part without a file name, whose bytes would arrive as text, before any write", async () => {
    const world = new World();
    const before = await snapshot();
    const bucket = withBucket(world);
    // A hand-built body: the second file part has no filename and holds the byte FF, which is not UTF-8.
    const encoder = new TextEncoder();
    const parts = [
      encoder.encode(
        '--b\r\nContent-Disposition: form-data; name="meta"\r\n\r\n' +
          `${JSON.stringify({ title: "t", files: [{ path: "index.html" }, { path: "bin" }] })}\r\n` +
          '--b\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\npage\r\n' +
          '--b\r\nContent-Disposition: form-data; name="file"\r\n\r\n',
      ),
      new Uint8Array([0x41, 0xff, 0x42]),
      encoder.encode("\r\n--b--\r\n"),
    ];
    const response = await world.api("POST", "/v1/artifacts", {
      body: new Blob(parts),
      headers: { "Content-Type": "multipart/form-data; boundary=b" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request", issues: [{ field: "files[1]", reason: "not_a_file" }] },
    });
    expect(bucket.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps a non-UTF-8 byte of a file part with a file name", async () => {
    const world = new World();
    const form = new FormData();
    form.append("meta", JSON.stringify({ title: "t", files: [{ path: "index.html" }, { path: "bin" }] }));
    form.append("file", new Blob(["page"]), "index.html");
    form.append("file", new Blob([new Uint8Array([0x41, 0xff, 0x42])]), "bin");
    const created = await json<PublishJson>(await world.api("POST", "/v1/artifacts", { body: form }));
    const served = await world.content(created.artifact.id, "/bin");
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([0x41, 0xff, 0x42]);
  });

  it("refuses a malformed multipart body", async () => {
    const world = new World();
    const response = await world.api("POST", "/v1/artifacts", {
      body: "not multipart at all",
      headers: { "Content-Type": "multipart/form-data; boundary=zzz" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { issues: [{ field: "body", reason: "malformed_body" }] } });
  });

  it("refuses an empty PATCH and an invalid JSON PATCH", async () => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i" } });
    expect(await json(await world.patch(artifact.id, {}))).toMatchObject({
      error: { code: "invalid_request", issues: [{ field: "body", reason: "required" }] },
    });
    const bad = await world.api("PATCH", `/v1/artifacts/${artifact.id}`, {
      body: "{",
      headers: { "Content-Type": "application/json" },
    });
    expect(await json(bad)).toMatchObject({ error: { issues: [{ field: "body", reason: "invalid_json" }] } });
    expect((await world.patch("abcdefghijklmnopqrstuvwxyz", { public: true })).status).toBe(404);
  });
});

// PL-22, VER-4.
describe("VER-4: delete", () => {
  it("answers 404 on every URL at once and empties the prefix", async () => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i", "a.txt": "a" } });
    const id = artifact.id;
    await world.updated(id, { base_version: 1, files: { "a.txt": "a2" } });
    await world.patch(id, { public: true });
    expect(await objectKeys(id)).toHaveLength(3);

    expect((await world.api("DELETE", `/v1/artifacts/${id}`)).status).toBe(204);
    for (const response of [
      await world.content(id, "/"),
      await world.content(id, "/_v/1/"),
      await world.public(id, "/"),
      await world.api("GET", `/v1/artifacts/${id}`),
      await world.api("GET", `/v1/artifacts/${id}/versions`),
      await world.api("GET", `/v1/artifacts/${id}/versions/1/files/a.txt`),
    ]) {
      expect(response.status).toBe(404);
    }
    expect((await world.update(id, { base_version: 2 })).status).toBe(404);
    expect((await world.patch(id, { archive: "kept" })).status).toBe(404);
    expect(await objectKeys(id)).toEqual([]);
    const listed = await json<Page>(await world.api("GET", "/v1/artifacts?archived=include"));
    expect(listed.artifacts.map((a) => a.id)).not.toContain(id);
  });

  it("answers 204 again for a tombstone and 404 for an ID that never existed", async () => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i" } });
    expect((await world.api("DELETE", `/v1/artifacts/${artifact.id}`)).status).toBe(204);
    expect((await world.api("DELETE", `/v1/artifacts/${artifact.id}`)).status).toBe(204);
    expect((await world.api("DELETE", "/v1/artifacts/abcdefghijklmnopqrstuvwxyz")).status).toBe(404);
    expect((await world.api("DELETE", "/v1/artifacts/not-an-id")).status).toBe(404);
  });

  it("completes a failed cleanup on the repeated delete", async () => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i", "b.txt": "b" } });
    const bucket = withBucket(world);
    bucket.behave = (op) => (op === "delete" ? Promise.reject(new Error("R2 down")) : undefined);
    expect((await world.api("DELETE", `/v1/artifacts/${artifact.id}`)).status).toBe(204);
    expect((await world.content(artifact.id, "/")).status).toBe(404);
    expect(await objectKeys(artifact.id)).toHaveLength(2);

    bucket.behave = () => undefined;
    expect((await world.api("DELETE", `/v1/artifacts/${artifact.id}`)).status).toBe(204);
    expect(await objectKeys(artifact.id)).toEqual([]);
  });

  it("removes an upload that landed after the cleanup on the repeated delete", async () => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i" } });
    const id = artifact.id;
    const bucket = withBucket(world);
    const held = gate();
    // The upload's put waits for the gate, then writes the file's bytes.
    bucket.behave = (op, key) => (op === "put" ? held.promise.then(() => env.FILES.put(key, "late")) : undefined);

    const update = world.update(id, { base_version: 1, files: { "late.txt": "late" } });
    await until(() => bucket.count("put") === 1);
    expect((await world.api("DELETE", `/v1/artifacts/${id}`)).status).toBe(204);
    expect(await objectKeys(id)).toEqual([]);
    held.open();
    expect((await update).status).toBe(404);
    expect(await objectKeys(id)).toHaveLength(1);

    expect((await world.api("DELETE", `/v1/artifacts/${id}`)).status).toBe(204);
    expect(await objectKeys(id)).toEqual([]);
  });
});

// PL-28, section 8: pagination.
describe("section 8: pagination", () => {
  it("orders ties on updated_at by id, descending, and ends with next_cursor null", async () => {
    const world = new World();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await world.created({ title: `t${i}`, files: { "index.html": "i" } })).artifact.id);
    const expected = ids.toSorted().toReversed();
    expect(await traverse(world, "limit=2")).toEqual(expected);
    const last = await json<Page>(await world.api("GET", "/v1/artifacts?limit=5"));
    expect(last.next_cursor).toBeNull();
    const first = await json<Page>(await world.api("GET", "/v1/artifacts?limit=4"));
    expect(first.next_cursor).not.toBeNull();
  });

  it("orders by updated_at first, and the cursor carries it", async () => {
    const world = new World();
    // IDs ordered against update times: a cursor that compared IDs alone would skip the older artifacts.
    const z = "z".repeat(26);
    const m = "m".repeat(26);
    const a = "a".repeat(26);
    world.ids.push(z, m, a);
    for (const title of ["z", "m", "a"]) {
      await world.created({ title, files: { "index.html": "i" } });
      world.clock.now += 10;
    }
    expect(await traverse(world, "limit=1")).toEqual([a, m, z]);
    await world.updated(z, { base_version: 1 });
    expect(await traverse(world, "limit=1")).toEqual([z, a, m]);
  });

  it.each(["x", "123", "1.ABCDEFGHIJKLMNOPQRSTUVWXYZ", `-1.${"a".repeat(26)}`, `01.${"a".repeat(26)}`])(
    "refuses the malformed cursor %j",
    async (cursor) => {
      const world = new World();
      const response = await world.api("GET", `/v1/artifacts?cursor=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { issues: [{ field: "cursor", reason: "invalid_cursor" }] },
      });
    },
  );

  it("reads empty query parameters as absent", async () => {
    const world = new World();
    expect((await world.api("GET", "/v1/artifacts?archived=&limit=&cursor=")).status).toBe(200);
  });

  it.each(["limit=0", "limit=101", "limit=1.5", "limit=01", "limit=x", "archived=all"])("refuses %s", async (query) => {
    const world = new World();
    expect((await world.api("GET", `/v1/artifacts?${query}`)).status).toBe(400);
  });

  it("does not repeat an artifact updated during the traversal", async () => {
    const world = new World();
    for (let i = 0; i < 6; i++) {
      world.clock.now += 10;
      await world.created({ title: `t${i}`, files: { "index.html": "i" } });
    }
    const all = await traverse(world, "limit=100");
    const seen = await traverse(world, "limit=2", async (page) => {
      if (page !== 0) return;
      world.clock.now += 10;
      // One already seen and one not yet seen move to the front.
      await world.updated(all[0] ?? "", { base_version: 1 });
      await world.updated(all[4] ?? "", { base_version: 1 });
    });
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 2)).toEqual(all.slice(0, 2));
    // Only the artifact that moved before the cursor is missed.
    expect(seen.toSorted()).toEqual(all.filter((id) => id !== all[4]).toSorted());
  });

  it("pages versions newest first", async () => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i" } });
    for (let n = 1; n < 5; n++) await world.updated(artifact.id, { base_version: n });
    const numbers: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "limit=2" : `limit=2&cursor=${cursor}`;
      const page = await json<{ versions: { number: number }[]; next_cursor: string | null }>(
        await world.api("GET", `/v1/artifacts/${artifact.id}/versions?${query}`),
      );
      numbers.push(...page.versions.map((v) => v.number));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(numbers).toEqual([5, 4, 3, 2, 1]);
    expect((await world.api("GET", `/v1/artifacts/${artifact.id}/versions?cursor=0`)).status).toBe(400);
  });
});

type ArchiveIds = { unset: string; archived: string; kept: string };

/** Three artifacts: archive setting unset, archived and kept. */
async function archiveSetup(world: World): Promise<ArchiveIds> {
  const create = async (name: string) =>
    (await world.created({ title: name, files: { "index.html": name } })).artifact.id;
  const ids = { unset: await create("unset"), archived: await create("archived"), kept: await create("kept") };
  await world.patch(ids.archived, { archive: "archived" });
  await world.patch(ids.kept, { archive: "kept" });
  return ids;
}

/** Each artifact's `[archived, archive]` by title. */
async function archiveStates(world: World): Promise<Record<string, [boolean, string | null]>> {
  const page = await json<Page>(await world.api("GET", "/v1/artifacts?archived=include"));
  return Object.fromEntries(page.artifacts.map((a) => [a.title, [a.archived, a.archive]]));
}

// PL-29, section 5: archive.
describe("section 5: archive", () => {
  it("decides by the setting, or by age when unset, either side of ARCHIVE_AFTER_DAYS", async () => {
    const world = new World();
    await archiveSetup(world);
    expect(await archiveStates(world)).toEqual({
      unset: [false, null],
      archived: [true, "archived"],
      kept: [false, "kept"],
    });
    world.clock.now = START + 30 * DAY_MS;
    expect((await archiveStates(world)).unset).toEqual([false, null]);
    world.clock.now = START + 30 * DAY_MS + 1;
    expect(await archiveStates(world)).toEqual({
      unset: [true, null],
      archived: [true, "archived"],
      kept: [false, "kept"],
    });
  });

  it("filters with exclude (the default), only and include", async () => {
    const world = new World();
    const ids = await archiveSetup(world);
    world.clock.now = START + 31 * DAY_MS;
    const titles = async (query: string) =>
      (await json<Page>(await world.api("GET", `/v1/artifacts${query}`))).artifacts.map((a) => a.title).toSorted();
    expect(await titles("")).toEqual(["kept"]);
    expect(await titles("?archived=exclude")).toEqual(["kept"]);
    expect(await titles("?archived=only")).toEqual(["archived", "unset"]);
    expect(await titles("?archived=include")).toEqual(["archived", "kept", "unset"]);
    // Setting null returns the artifact to age deciding.
    await world.patch(ids.kept, { archive: null });
    expect(await titles("?archived=only")).toEqual(["archived", "kept", "unset"]);
  });

  it("filters before cutting the page", async () => {
    const world = new World();
    for (let i = 0; i < 6; i++) {
      world.clock.now += 10;
      const { artifact } = await world.created({ title: `t${i}`, files: { "index.html": "i" } });
      if (i % 2 === 0) await world.patch(artifact.id, { archive: "archived" });
    }
    const only = await traverse(world, "archived=only&limit=1");
    expect(only).toHaveLength(3);
    const first = await json<Page>(await world.api("GET", "/v1/artifacts?archived=exclude&limit=3"));
    expect(first.artifacts).toHaveLength(3);
    expect(first.next_cursor).toBeNull();
  });

  it("changes no version, URL or update time", async () => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "page" } });
    world.clock.now += 5000;
    const before = await json<PublishJson & { artifact: ArtifactJson }>(
      await world.api("GET", `/v1/artifacts/${artifact.id}`),
    );
    const patched = await json<{ artifact: ArtifactJson }>(await world.patch(artifact.id, { archive: "archived" }));
    expect(patched.artifact).toEqual({ ...before.artifact, archived: true, archive: "archived" });
    const after = await json<PublishJson>(await world.api("GET", `/v1/artifacts/${artifact.id}`));
    expect(after.version).toEqual(before.version);
    expect(await (await world.content(artifact.id, "/")).text()).toBe("page");
    expect(await (await world.content(artifact.id, "/_v/1/")).text()).toBe("page");
  });

  it("keeps an archive change made during an in-flight update", async () => {
    const world = new World();
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i" } });
    const bucket = withBucket(world);
    const held = gate();
    bucket.behave = (op) => (op === "head" ? held.promise.then(() => env.FILES.head("none")) : undefined);
    const update = world.update(artifact.id, { base_version: 1, files: { "x.txt": "x" } });
    await until(() => bucket.count("head") === 1);
    expect((await world.patch(artifact.id, { archive: "kept", public: true })).status).toBe(200);
    held.open();
    const updated = await json<PublishJson & { artifact: ArtifactJson }>(await update);
    expect(updated.artifact).toMatchObject({ latest_version: 2, archive: "kept", public: true });
    expect(await json(await world.api("GET", `/v1/artifacts/${artifact.id}`))).toMatchObject({
      artifact: { latest_version: 2, archive: "kept", public: true },
    });
  });

  it("never moves updated_at back when the clock is behind it", async () => {
    const world = new World();
    world.clock.now = START + 10_000;
    const { artifact } = await world.created({ title: "t", files: { "index.html": "i" } });
    world.clock.now = START;
    const updated = await world.updated(artifact.id, { base_version: 1 });
    expect(updated.artifact.updated_at).toBe(new Date(START + 10_000).toISOString());
    expect(updated.version.created_at).toBe(new Date(START).toISOString());
  });
});
