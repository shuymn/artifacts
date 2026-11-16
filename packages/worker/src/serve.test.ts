import { describe, expect, it } from "vitest";

import favicon from "./gallery/favicon.ico";
import { APP_HOST, CONTENT_SUFFIX, objectKeys, PUBLIC_SUFFIX, World } from "./test-support.ts";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-cache",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const PUBLIC_HEADERS = {
  "cache-control": "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** An artifact with three versions; `page.txt` differs per version and `only-v3.txt` exists only in the latest. */
async function threeVersions(world: World): Promise<string> {
  const created = await world.created({
    title: "v1",
    files: { "index.html": "index v1", "page.txt": "page v1", "docs/index.html": "docs v1" },
  });
  const id = created.artifact.id;
  await world.updated(id, { base_version: 1, files: { "page.txt": "page v2", "index.html": "index v2" } });
  await world.updated(id, { base_version: 2, files: { "page.txt": "page v3", "only-v3.txt": "new" } });
  return id;
}

function noCors(response: Response): void {
  expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
  expect(response.headers.has("Set-Cookie")).toBe(false);
}

// PL-16, SRV-2.
describe("SRV-2: path resolution on content hosts", () => {
  it.each([
    ["/", "index v2"],
    ["/index.html", "index v2"],
    ["/page.txt", "page v3"],
    ["/only-v3.txt", "new"],
    ["/docs/", "docs v1"],
    ["/_v/1/", "index v1"],
    ["/_v/1/page.txt", "page v1"],
    ["/_v/2/page.txt", "page v2"],
    ["/_v/3/page.txt", "page v3"],
    ["/_v/1/docs/index.html", "docs v1"],
  ])("serves %s as %j", async (path, body) => {
    const world = new World();
    const id = await threeVersions(world);
    const response = await world.content(id, path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it.each([
    ["/_v/1/only-v3.txt", "a file only the latest has, pinned to an older version"],
    ["/_v/0/", "version 0"],
    ["/_v/01/", "a non-canonical number"],
    ["/_v/4/", "one past the latest"],
    ["/_v/", "no number"],
    ["/missing.txt", "an unknown file"],
    ["/page.txt/", "a file named as a directory"],
    ["/docs//index.html", "a doubled slash"],
    ["//index.html", "a leading doubled slash"],
    ["/_v/2//page.txt", "a doubled slash in a pinned path"],
    ["/_v/2/../page.txt", "a dot segment, which URL parsing removes into /_v/page.txt"],
    ["/_v/2/%2e%2e/page.txt", "an encoded dot segment, which URL parsing also removes"],
    ["/page%2Etxt%2F", "an encoded slash"],
    ["/page.txt%", "a malformed escape"],
  ])("answers 404 for %s (%s)", async (path) => {
    const world = new World();
    const id = await threeVersions(world);
    const response = await world.content(id, path);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("selects the version and path after URL parsing removed dot segments", async () => {
    const world = new World();
    const id = await threeVersions(world);
    const request = new Request(`https://${id}${CONTENT_SUFFIX}/_v/3/docs/../_v/x/../page.txt`, {
      headers: { "Cf-Access-Jwt-Assertion": await world.jwt() },
    });
    expect(new URL(request.url).pathname).toBe("/_v/3/_v/page.txt");
    // Version 3 has no file "_v/page.txt", and nothing falls back to another version.
    expect((await world.fetch(request)).status).toBe(404);
    expect((await world.content(id, "/_v/3/docs/../page.txt")).status).toBe(200);
    expect(await (await world.content(id, "/_v/3/docs/../page.txt")).text()).toBe("page v3");
    expect(await (await world.content(id, "/docs/../_v/1/page.txt")).text()).toBe("page v1");
  });

  it("answers 308 to the path with a slash for a directory and /_v/<n>", async () => {
    const world = new World();
    const id = await threeVersions(world);
    for (const [path, location] of [
      ["/docs", "/docs/"],
      ["/_v/1/docs", "/_v/1/docs/"],
      ["/_v/2", "/_v/2/"],
      ["/docs?x=1", "/docs/?x=1"],
    ] as const) {
      const response = await world.content(id, path);
      expect({ path, status: response.status, location: response.headers.get("Location") }).toEqual({
        path,
        status: 308,
        location,
      });
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    }
    expect((await world.content(id, "/_v/4")).status).toBe(404);
  });

  it("serves names with %, #, ? and \\ at their percent-encoded paths, in NFC", async () => {
    const world = new World();
    const created = await world.created({
      title: "names",
      files: { "index.html": "i", "a%b#c?d\\e.txt": "odd", "café.txt": "nfc", "sp ace/x.txt": "space" },
    });
    const id = created.artifact.id;
    expect(await (await world.content(id, "/a%25b%23c%3Fd%5Ce.txt")).text()).toBe("odd");
    expect(await (await world.content(id, "/cafe%CC%81.txt")).text()).toBe("nfc");
    expect(await (await world.content(id, "/caf%C3%A9.txt")).text()).toBe("nfc");
    expect(await (await world.content(id, "/sp%20ace/x.txt")).text()).toBe("space");
    expect(await (await world.content(id, "/sp ace/x.txt")).text()).toBe("space");
    expect((await world.content(id, "/a%b#c?d")).status).toBe(404);
  });
});

// PL-13, SRV-1, section 6: headers per host class, latest and pinned.
describe("SRV-1: response headers", () => {
  it.each([
    ["/", "text/html; charset=utf-8"],
    ["/_v/1/", "text/html; charset=utf-8"],
    ["/data.bin", "application/x-custom; v=1"],
    ["/_v/1/data.bin", "application/x-custom; v=1"],
    ["/noext", "application/octet-stream"],
  ])("sends the stored type and the class headers for %s", async (path, type) => {
    const world = new World();
    const created = await world.created({
      title: "h",
      files: { "index.html": "<p>x</p>", "data.bin": { body: "bytes", type: "application/x-custom; v=1" }, noext: "n" },
    });
    const id = created.artifact.id;
    expect((await world.patch(id, { public: true })).status).toBe(200);
    const file = created.version.files.find(
      (f) => `/${f.path}` === path.replace(/^\/_v\/1/, "").replace(/\/$/, "/index.html"),
    );
    for (const [response, classHeaders] of [
      [await world.content(id, path), PRIVATE_HEADERS],
      [await world.public(id, path), PUBLIC_HEADERS],
    ] as const) {
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toEqual({
        ...classHeaders,
        "content-type": type,
        "content-length": String(file?.size),
        etag: expect.stringMatching(/^"[0-9a-f]{32}"$/),
      });
      noCors(response);
    }
  });
});

// PL-10, ISO-2: CORP on every private content and app response; none on public hosts; no CORS anywhere.
describe("ISO-2: cross-origin headers", () => {
  it("sends CORP on content-host 200, 304, 308, 403, 404, 405 and 503", async () => {
    const world = new World({ keyTimeoutMs: 50 });
    const id = await threeVersions(world);
    const origin = { Origin: "https://other.example.org" };
    const etag = (await world.content(id, "/page.txt")).headers.get("ETag") ?? "";
    const responses = [
      await world.content(id, "/", { headers: origin }),
      await world.content(id, "/page.txt", { headers: { ...origin, "If-None-Match": etag } }),
      await world.content(id, "/docs", { headers: origin }),
      await world.content(id, "/", { jwt: null, headers: origin }),
      await world.content(id, "/nothing", { headers: origin }),
      await world.content(id, "/", { method: "POST", headers: origin }),
    ];
    const fresh = new World({ keyTimeoutMs: 50 });
    fresh.keys.mode = "down";
    responses.push(await fresh.content(id, "/", { headers: origin }));
    expect(responses.map((r) => r.status)).toEqual([200, 304, 308, 403, 404, 405, 503]);
    for (const response of responses) {
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      noCors(response);
    }
  });

  it("sends CORP on app-host 200, 304, 403, 404 and 405", async () => {
    const world = new World();
    const id = await threeVersions(world);
    const app = (path: string, init: RequestInit = {}) => world.fetch(`https://${APP_HOST}${path}`, init);
    const jwt = { "Cf-Access-Jwt-Assertion": await world.jwt({ aud: "app-audience" }) };
    const etag = (await app("/assets/gallery.css", { headers: jwt })).headers.get("ETag") ?? "";
    const responses = [
      await app("/", { headers: jwt }),
      await app("/archived", { headers: jwt }),
      await app(`/a/${id}`, { headers: jwt }),
      await app("/assets/gallery.css", { headers: { ...jwt, "If-None-Match": etag } }),
      await app("/"),
      await app("/a/x", { headers: jwt }),
      await app("/", { method: "DELETE" }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 304, 403, 404, 405]);
    for (const response of responses) {
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      noCors(response);
    }
  });

  it("sends no CORP on public-host 200, 304, 308, 404 and 405", async () => {
    const world = new World();
    const id = await threeVersions(world);
    await world.patch(id, { public: true });
    const etag = (await world.public(id, "/page.txt")).headers.get("ETag") ?? "";
    const responses = [
      await world.public(id, "/"),
      await world.public(id, "/page.txt", { headers: { "If-None-Match": etag } }),
      await world.public(id, "/docs"),
      await world.public(id, "/nothing"),
      await world.public(id, "/", { method: "PUT" }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 304, 308, 404, 405]);
    for (const response of responses) {
      expect(response.headers.has("Cross-Origin-Resource-Policy")).toBe(false);
      noCors(response);
    }
  });
});

// PL-14, SRV-3: a 304 never skips a check.
describe("SRV-3: If-None-Match after the checks", () => {
  it.each(["/page.txt", "/_v/1/page.txt"])("answers 304 for a matching tag at %s only while allowed", async (path) => {
    const world = new World();
    const id = await threeVersions(world);
    await world.patch(id, { public: true });
    const etag = (await world.content(id, path)).headers.get("ETag") ?? "";
    const conditional = { "If-None-Match": etag };

    const fresh = await world.content(id, path, { headers: conditional });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("ETag")).toBe(etag);
    expect((await world.content(id, path, { headers: { "If-None-Match": `W/${etag}, "other"` } })).status).toBe(304);
    expect((await world.content(id, path, { headers: { "If-None-Match": '"other"' } })).status).toBe(200);
    expect((await world.public(id, path, { headers: conditional })).status).toBe(304);

    // Without access: 403, not 304.
    expect((await world.content(id, path, { jwt: null, headers: conditional })).status).toBe(403);
    expect(
      (await world.content(id, path, { jwt: await world.jwt({ key: "other" }), headers: conditional })).status,
    ).toBe(403);

    // Made private: the public host answers 404, not 304.
    await world.patch(id, { public: false });
    expect((await world.public(id, path, { headers: conditional })).status).toBe(404);

    // Deleted: 404 on the content host.
    expect((await world.api("DELETE", `/v1/artifacts/${id}`)).status).toBe(204);
    expect((await world.content(id, path, { headers: conditional })).status).toBe(404);
  });

  it("gives the same bytes published with another type another tag, so the old tag gets no 304", async () => {
    const world = new World();
    const created = await world.created({
      title: "t",
      files: { "index.html": "<p>x</p>", "data.bin": { body: "same bytes", type: "application/x-old" } },
    });
    const id = created.artifact.id;
    const old = (await world.content(id, "/data.bin")).headers.get("ETag") ?? "";
    const updated = await world.updated(id, {
      base_version: 1,
      files: { "data.bin": { body: "same bytes", type: "application/x-new" } },
    });
    const sha = (version: typeof created.version) => version.files.find((f) => f.path === "data.bin")?.sha256;
    expect(sha(updated.version)).toBe(sha(created.version));

    const latest = await world.content(id, "/data.bin", { headers: { "If-None-Match": old } });
    expect(latest.status).toBe(200);
    expect(latest.headers.get("Content-Type")).toBe("application/x-new");
    expect(latest.headers.get("ETag")).not.toBe(old);
    const api = await world.api("GET", `/v1/artifacts/${id}/versions/2/files/data.bin`);
    expect(api.headers.get("ETag")).toBe(latest.headers.get("ETag"));
    // Version 1 still holds the old type, so its tag still matches.
    expect((await world.content(id, "/_v/1/data.bin", { headers: { "If-None-Match": old } })).status).toBe(304);
  });
});

// PL-9, ISO-1.
describe("ISO-1: one artifact per host", () => {
  it("serves each artifact its own bytes for the same path", async () => {
    const world = new World();
    const a = await world.created({ title: "a", files: { "index.html": "page a", "x.css": "a{}" } });
    const b = await world.created({ title: "b", files: { "index.html": "page b", "x.css": "b{}" } });
    expect(await (await world.content(a.artifact.id, "/x.css")).text()).toBe("a{}");
    expect(await (await world.content(b.artifact.id, "/x.css")).text()).toBe("b{}");
    expect(await (await world.content(a.artifact.id, "/_v/1/")).text()).toBe("page a");
    expect(await (await world.content(b.artifact.id, "/_v/1/")).text()).toBe("page b");
  });

  it("refuses to create an artifact under a deleted ID", async () => {
    const world = new World();
    const old = await world.created({ title: "old", files: { "index.html": "old page" } });
    const id = old.artifact.id;
    expect((await world.api("DELETE", `/v1/artifacts/${id}`)).status).toBe(204);

    world.ids.push(id);
    const response = await world.create({ title: "new", files: { "index.html": "new page" } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "internal error" } });
    expect((await world.content(id, "/")).status).toBe(404);
    expect((await world.api("GET", `/v1/artifacts/${id}`)).status).toBe(404);
    // A repeated delete removes what the refused create uploaded under the old prefix.
    expect((await world.api("DELETE", `/v1/artifacts/${id}`)).status).toBe(204);
    expect(await objectKeys(id)).toEqual([]);
  });
});

// PL-17, PUB-1, PUB-2.
describe("PUB-1: public hosts", () => {
  it("answers private, deleted and unknown artifacts with the same 404", async () => {
    const world = new World();
    const isPrivate = await world.created({ title: "p", files: { "index.html": "private" } });
    const deleted = await world.created({ title: "d", files: { "index.html": "deleted" } });
    await world.patch(deleted.artifact.id, { public: true });
    await world.api("DELETE", `/v1/artifacts/${deleted.artifact.id}`);
    const responses = [
      await world.public(isPrivate.artifact.id, "/"),
      await world.public(deleted.artifact.id, "/"),
      await world.public("abcdefghijklmnopqrstuvwxyz", "/"),
    ];
    const shapes = await Promise.all(
      responses.map(async (r) => ({ status: r.status, headers: [...r.headers], body: await r.text() })),
    );
    expect(shapes[0]?.status).toBe(404);
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it("is off at creation, serves every version while on, and stops on the next request after off", async () => {
    const world = new World();
    const id = await threeVersions(world);
    const before = await (await world.api("GET", `/v1/artifacts/${id}`)).json<{ artifact: { public: boolean } }>();
    expect(before.artifact.public).toBe(false);
    expect((await world.public(id, "/")).status).toBe(404);

    const on = await world.patch(id, { public: true });
    expect(await on.json()).toMatchObject({ artifact: { public: true, public_url: `https://${id}${PUBLIC_SUFFIX}/` } });
    expect(await (await world.public(id, "/")).text()).toBe("index v2");
    expect(await (await world.public(id, "/_v/1/page.txt")).text()).toBe("page v1");
    expect(await (await world.public(id, "/_v/2/page.txt")).text()).toBe("page v2");

    await world.patch(id, { public: false });
    expect((await world.public(id, "/")).status).toBe(404);
    expect((await world.public(id, "/_v/1/page.txt")).status).toBe(404);
    // The private host is unaffected.
    expect(await (await world.content(id, "/_v/1/page.txt")).text()).toBe("page v1");
  });

  it("never serves the gallery or the API on a public host", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "x" } });
    await world.patch(created.artifact.id, { public: true });
    expect((await world.public(created.artifact.id, "/v1/artifacts")).status).toBe(404);
    expect((await world.public(created.artifact.id, "/a/x")).status).toBe(404);
  });
});

/** A response's status, headers and body, to compare answers whole. */
async function whole(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

// PL-33, section 6: `/favicon.ico` of an artifact without the file is the gallery's icon, after the checks of any file.
describe("section 6: the fallback icon", () => {
  const ICO = "image/vnd.microsoft.icon";
  const icon = new Uint8Array(favicon);

  it("answers /favicon.ico of an artifact without the file with the icon and the host class's headers", async () => {
    const world = new World();
    const id = await threeVersions(world);
    await world.patch(id, { public: true });
    for (const [response, classHeaders] of [
      [await world.content(id, "/favicon.ico"), PRIVATE_HEADERS],
      [await world.public(id, "/favicon.ico"), PUBLIC_HEADERS],
    ] as const) {
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toEqual({
        ...classHeaders,
        "content-type": ICO,
        "content-length": String(icon.byteLength),
        etag: expect.stringMatching(/^"[0-9a-f]{32}"$/),
      });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(icon);
      noCors(response);
    }
    const head = await world.content(id, "/favicon.ico", { method: "HEAD" });
    expect([...head.headers]).toEqual([...(await world.content(id, "/favicon.ico")).headers]);
    expect(await head.text()).toBe("");
  });

  it("revalidates the icon by its ETag, with CORP on the 304 of a content host", async () => {
    const world = new World();
    const id = await threeVersions(world);
    const etag = (await world.content(id, "/favicon.ico")).headers.get("ETag") ?? "";
    const again = await world.content(id, "/favicon.ico", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(again.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(again.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it("serves the artifact's own favicon.ico instead, and the icon again once a version removes it", async () => {
    const world = new World();
    const created = await world.created({ title: "f", files: { "index.html": "x" } });
    const id = created.artifact.id;
    const fallback = (await world.content(id, "/favicon.ico")).headers.get("ETag") ?? "";

    await world.updated(id, { base_version: 1, files: { "favicon.ico": { body: "own", type: ICO } } });
    // A cache holding the icon revalidates and gets the artifact's file, not a 304.
    const own = await world.content(id, "/favicon.ico", { headers: { "If-None-Match": fallback } });
    expect(own.status).toBe(200);
    expect(own.headers.get("ETag")).not.toBe(fallback);
    expect(await own.text()).toBe("own");

    await world.updated(id, { base_version: 2, remove: ["favicon.ico"] });
    const again = await world.content(id, "/favicon.ico");
    expect(again.headers.get("ETag")).toBe(fallback);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(icon);
  });

  it("answers a favicon.ico directory with its 308, as any other path", async () => {
    const world = new World();
    const created = await world.created({ title: "d", files: { "index.html": "x", "favicon.ico/index.html": "d" } });
    const response = await world.content(created.artifact.id, "/favicon.ico");
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("/favicon.ico/");
  });

  it("has no fallback on a pinned path, which serves exactly the version's files", async () => {
    const world = new World();
    const created = await world.created({ title: "p", files: { "index.html": "x" } });
    const id = created.artifact.id;
    await world.updated(id, { base_version: 1, files: { "favicon.ico": "v2 icon" } });
    expect(await whole(await world.content(id, "/_v/1/favicon.ico"))).toEqual(
      await whole(await world.content(id, "/_v/1/missing.txt")),
    );
    expect(await (await world.content(id, "/_v/2/favicon.ico")).text()).toBe("v2 icon");
    expect(await (await world.content(id, "/favicon.ico")).text()).toBe("v2 icon");
  });

  it("answers an unknown host, an unknown or deleted artifact and a private one on its public host as before", async () => {
    const world = new World();
    const unknown = "abcdefghijklmnopqrstuvwxyz";
    const isPrivate = (await world.created({ title: "p", files: { "index.html": "x" } })).artifact.id;
    const deleted = (await world.created({ title: "d", files: { "index.html": "x" } })).artifact.id;
    await world.patch(deleted, { public: true });
    expect((await world.api("DELETE", `/v1/artifacts/${deleted}`)).status).toBe(204);

    const host = (path: string) => world.fetch(`https://nothing.example.org${path}`);
    expect(await whole(await host("/favicon.ico"))).toEqual(await whole(await host("/missing.txt")));
    const contentMiss = await whole(await world.content(unknown, "/missing.txt"));
    expect(contentMiss.status).toBe(404);
    expect(await whole(await world.content(unknown, "/favicon.ico"))).toEqual(contentMiss);
    expect(await whole(await world.content(deleted, "/favicon.ico"))).toEqual(contentMiss);
    const publicMiss = await whole(await world.public(unknown, "/missing.txt"));
    expect(publicMiss.status).toBe(404);
    for (const id of [unknown, deleted, isPrivate]) {
      expect(await whole(await world.public(id, "/favicon.ico"))).toEqual(publicMiss);
    }
  });

  // SRV-3 for the icon: Access, the public flag and existence come before the icon and its 304.
  it("checks Access, the public flag and existence before the icon or its 304", async () => {
    const world = new World();
    const id = (await world.created({ title: "c", files: { "index.html": "x" } })).artifact.id;
    await world.patch(id, { public: true });
    const etag = (await world.public(id, "/favicon.ico")).headers.get("ETag") ?? "";
    const conditional = { "If-None-Match": etag };
    expect((await world.public(id, "/favicon.ico", { headers: conditional })).status).toBe(304);
    expect((await world.content(id, "/favicon.ico", { jwt: null })).status).toBe(403);
    expect((await world.content(id, "/favicon.ico", { jwt: null, headers: conditional })).status).toBe(403);

    await world.patch(id, { public: false });
    expect((await world.public(id, "/favicon.ico", { headers: conditional })).status).toBe(404);
    expect((await world.content(id, "/favicon.ico", { headers: conditional })).status).toBe(304);
    expect((await world.api("DELETE", `/v1/artifacts/${id}`)).status).toBe(204);
    expect((await world.content(id, "/favicon.ico", { headers: conditional })).status).toBe(404);
  });
});
