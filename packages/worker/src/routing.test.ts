import { afterEach, describe, expect, it, vi } from "vitest";

import {
  API,
  API_HOST,
  APP_AUD,
  APP_HOST,
  BucketProbe,
  captureLogs,
  CONTENT_SUFFIX,
  DatabaseProbe,
  logEvents,
  PUBLIC_SUFFIX,
  snapshot,
  TOKENS,
  World,
} from "./test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const ID = "abcdefghijklmnopqrstuvwxyz";

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

// PL-1, HOST-1.
describe("HOST-1: host classification", () => {
  it.each([
    `https://x.${ID}${CONTENT_SUFFIX}/`,
    `https://${ID.slice(1)}${CONTENT_SUFFIX}/`,
    `https://${ID}a${CONTENT_SUFFIX}/`,
    `https://${ID}${CONTENT_SUFFIX}:8443/`,
    `https://abcdefghijklm-opqrstuvwxyz${PUBLIC_SUFFIX}/`,
    `https://www.${APP_HOST}/`,
    `https://${APP_HOST}:8443/`,
    "https://example.com/",
    `https://${API_HOST}.example.org/v1/artifacts`,
  ])("answers 404 for %s without reading D1 or R2", async (url) => {
    const world = new World();
    const { db, bucket } = untouchable(world);
    const response = await world.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${TOKENS.codex}` } });
    expect(response.status).toBe(404);
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
  });

  it("reads the host as URL parsing lowercased it", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "page" } });
    const id = created.artifact.id;
    const request = new Request(`https://${id.toUpperCase()}${CONTENT_SUFFIX.toUpperCase()}/`, {
      headers: { "Cf-Access-Jwt-Assertion": await world.jwt() },
    });
    expect(new URL(request.url).host).toBe(`${id}${CONTENT_SUFFIX}`);
    expect(await (await world.fetch(request)).text()).toBe("page");
  });
});

// PL-2, HOST-2: the Worker refuses a configuration that weakens a boundary.
describe("HOST-2: invalid configuration", () => {
  it.each([
    [
      "a public suffix under the content suffix",
      { CONTENT_HOST_SUFFIX: ".example-content.net", PUBLIC_HOST_SUFFIX: "-s.example-content.net" },
    ],
    ["an app host under a suffix", { APP_HOST: "gallery-art.example.com" }],
    ["a label over 63 characters", { CONTENT_HOST_SUFFIX: `-${"a".repeat(37)}.example.com` }],
    ["localhost mixed with other hosts", { APP_HOST: "app.localhost:8787" }],
  ])("answers 503 for %s on every host, without storage", async (_name, vars) => {
    const world = new World({ vars });
    const { db, bucket } = untouchable(world);
    const logs = captureLogs();
    for (const url of [`https://${APP_HOST}/`, `${API}/v1/artifacts`, `https://${ID}${CONTENT_SUFFIX}/`]) {
      const response = await world.fetch(url);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    }
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
    expect(
      logEvents(logs.lines).every((line) => line.event === "config.invalid" && typeof line.reason === "string"),
    ).toBe(true);
  });
});

// PL-4, ACC-2: Access is verified unless every configured host is a localhost name.
describe("ACC-2: Access outside localhost", () => {
  it("refuses production-shaped hosts without a JWT, before storage", async () => {
    const world = new World();
    const { db, bucket } = untouchable(world);
    for (const url of [
      `https://${APP_HOST}/`,
      `https://${ID}${CONTENT_SUFFIX}/`,
      `https://${ID}${CONTENT_SUFFIX}/_v/1/`,
    ]) {
      expect((await world.fetch(url)).status).toBe(403);
    }
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
  });

  it("refuses an app JWT on a content host and a content JWT on the app host", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "x" } });
    expect((await world.content(created.artifact.id, "/", { jwt: await world.jwt({ aud: APP_AUD }) })).status).toBe(
      403,
    );
    const app = await world.fetch(`https://${APP_HOST}/`, {
      headers: { "Cf-Access-Jwt-Assertion": await world.jwt() },
    });
    expect(app.status).toBe(403);
  });

  it("serves a localhost configuration without Access", async () => {
    const world = new World({
      vars: {
        APP_HOST: "app.localhost:8787",
        API_HOST: "api.localhost:8787",
        CONTENT_HOST_SUFFIX: "-art.localhost:8787",
        PUBLIC_HOST_SUFFIX: "-pub.localhost:8787",
      },
    });
    const form = new FormData();
    form.append("meta", JSON.stringify({ title: "local", files: [{ path: "index.html" }] }));
    form.append("file", new Blob(["local page"]));
    const created = await world.fetch("http://api.localhost:8787/v1/artifacts", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKENS.codex}` },
      body: form,
    });
    expect(created.status).toBe(201);
    const { artifact } = await created.json<{ artifact: { id: string; url: string } }>();
    expect(artifact.url).toBe(`http://${artifact.id}-art.localhost:8787/`);
    const page = await world.fetch(artifact.url);
    expect(await page.text()).toBe("local page");
    expect(world.keys.calls).toBe(0);
  });

  it("answers 503 when the key set cannot be fetched", async () => {
    const world = new World({ keyTimeoutMs: 50 });
    world.keys.mode = "hang";
    const response = await world.content(ID, "/");
    expect(response.status).toBe(503);
  });
});

const ROUTES: [string, string][] = [
  ["GET", "/v1/artifacts"],
  ["POST", "/v1/artifacts"],
  ["GET", `/v1/artifacts/${ID}`],
  ["PATCH", `/v1/artifacts/${ID}`],
  ["DELETE", `/v1/artifacts/${ID}`],
  ["GET", `/v1/artifacts/${ID}/versions`],
  ["POST", `/v1/artifacts/${ID}/versions`],
  ["GET", `/v1/artifacts/${ID}/versions/1`],
  ["GET", `/v1/artifacts/${ID}/versions/1/files/index.html`],
  ["POST", "/mcp"],
  ["GET", "/mcp"],
  ["GET", "/"],
];

// PL-5, TOK-1.
describe("TOK-1: bearer tokens on the API host", () => {
  it.each<[string, Record<string, string>]>([
    ["no header", {}],
    ["another scheme", { Authorization: `Basic ${btoa(`codex:${TOKENS.codex}`)}` }],
    ["an empty bearer", { Authorization: "Bearer " }],
    ["an unknown token", { Authorization: `Bearer art_${"z".repeat(32)}` }],
    ["a removed token", { Authorization: `Bearer ${TOKENS.removed}` }],
    ["a token with a trailing character", { Authorization: `Bearer ${TOKENS.codex}x` }],
  ])("answers 401 to %s on every route and changes nothing", async (_name, headers) => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "x" } });
    const before = await snapshot();
    const { db, bucket } = untouchable(world);
    for (const [method, path] of ROUTES) {
      const route = path.replace(ID, created.artifact.id);
      const response = await world.fetch(`${API}${route}`, {
        method,
        headers: { ...headers, "Content-Type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ public: true }) }),
      });
      expect({ method, route, status: response.status }).toEqual({ method, route, status: 401 });
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("accepts the scheme in any case and either configured token", async () => {
    const world = new World();
    for (const authorization of [`bearer ${TOKENS.codex}`, `BEARER ${TOKENS.claude}`]) {
      const response = await world.fetch(`${API}/v1/artifacts`, { headers: { Authorization: authorization } });
      expect(response.status).toBe(200);
    }
  });

  it("answers 404 for /mcp and unknown routes after the token", async () => {
    const world = new World();
    for (const path of ["/mcp", "/", "/v2/artifacts", "/v1/other"]) {
      const response = await world.api("GET", path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });
});

const METHODS = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"];

// PL-11, ISO-3, ISO-4.
describe("ISO-3: browser hosts only read", () => {
  it.each(METHODS)(
    "answers %s with 405 on the app, content and public hosts, before Access or storage",
    async (method) => {
      const world = new World();
      const { db, bucket } = untouchable(world);
      for (const host of [APP_HOST, `${ID}${CONTENT_SUFFIX}`, `${ID}${PUBLIC_SUFFIX}`]) {
        const response = await world.fetch(`https://${host}/`, {
          method,
          headers: { Origin: "https://evil.example.org", "Access-Control-Request-Method": "POST" },
          ...(method === "OPTIONS" || method === "PROPFIND" ? {} : { body: "x" }),
        });
        expect({ method, host, status: response.status }).toEqual({ method, host, status: 405 });
        expect(response.headers.get("Allow")).toBe("GET, HEAD");
        expect(response.headers.has("Set-Cookie")).toBe(false);
        expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
      }
      expect(db.batches).toBe(0);
      expect(bucket.calls).toEqual([]);
      expect(world.keys.calls).toBe(0);
    },
  );

  it("answers HEAD like GET without a body", async () => {
    const world = new World();
    const created = await world.created({ title: "t", files: { "index.html": "page body" } });
    const get = await world.content(created.artifact.id, "/");
    const head = await world.content(created.artifact.id, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect([...head.headers]).toEqual([...get.headers]);
    expect(await head.text()).toBe("");
  });
});
