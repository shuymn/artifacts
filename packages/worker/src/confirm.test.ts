// The confirmation pages (design.md section 10; PL-11, PL-56 to PL-59): their routes and methods, Access, the pages,
// the POST's origin checks and form, the change through the operation, the result page and its script, the headers of
// every answer, and the logs.
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessVerifier, type AccessOutcome } from "./access.ts";
import { byClass, elements, parseHtml, textOf, type HtmlNode } from "./gallery/test-html.ts";
import { newArtifactId } from "./id.ts";
import { createWorker } from "./index.ts";
import {
  APP_AUD,
  APP_HOST,
  BucketProbe,
  captureLogs,
  clearStorage,
  CONTENT_AUD,
  CONTENT_SUFFIX,
  DatabaseProbe,
  logEvents,
  never,
  PUBLIC_SUFFIX,
  snapshot,
  START,
  World,
} from "./test-support.ts";

beforeEach(async () => {
  await clearStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const APP = `https://${APP_HOST}`;
const UNKNOWN_ID = "abcdefghijklmnopqrstuvwxyz";
/** Design.md section 10: the form is at most 1 KiB, written out so that a change of the constant fails. */
const FORM_BYTES = 1024;

type Options = { jwt?: string | null; method?: string; headers?: Record<string, string>; body?: BodyInit };

/** A request to the app host, with a valid app JWT unless `jwt` is given. */
async function appRequest(world: World, path: string, options: Options = {}): Promise<Request> {
  const headers = new Headers(options.headers);
  const jwt = options.jwt === undefined ? await world.jwt({ aud: APP_AUD }) : options.jwt;
  if (jwt !== null) headers.set("Cf-Access-Jwt-Assertion", jwt);
  return new Request(`${APP}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

async function app(world: World, path: string, options: Options = {}): Promise<Response> {
  return world.fetch(await appRequest(world, path, options));
}

/** What a browser sends with the page's own form. */
const FORM = {
  Origin: APP,
  "Sec-Fetch-Site": "same-origin",
  "Content-Type": "application/x-www-form-urlencoded",
} as const;

/**
 * The form's POST, with headers replaced (or removed, with null). A text body declares its length, as a browser's form
 * does (the runtime's `Request` sets none); a stream declares none.
 */
async function post(
  world: World,
  path: string,
  body: BodyInit,
  replaced: Record<string, string | null> = {},
): Promise<Response> {
  const length = typeof body === "string" ? { "Content-Length": String(new TextEncoder().encode(body).length) } : {};
  const headers: Record<string, string> = { ...FORM, ...length };
  for (const [name, value] of Object.entries(replaced)) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  return app(world, path, { method: "POST", headers, body });
}

async function create(world: World, title = "Page", files: Record<string, string> = {}): Promise<string> {
  const created = await world.created({ title, files: { "index.html": `<p>${title}</p>`, ...files } });
  return created.artifact.id;
}

async function isPublic(world: World, id: string): Promise<boolean | undefined> {
  const response = await world.api("GET", `/v1/artifacts/${id}`);
  if (response.status !== 200) return undefined;
  return (await response.json<{ artifact: { public: boolean } }>()).artifact.public;
}

async function documentOf(response: Response): Promise<HtmlNode> {
  return parseHtml(await response.text());
}

const one = (nodes: HtmlNode[]): HtmlNode => {
  expect(nodes).toHaveLength(1);
  return nodes[0] ?? { tag: "", attributes: new Map(), children: [], text: "" };
};
const byTag = (doc: HtmlNode, tag: string) => elements(doc).filter((node) => node.tag === tag);
const attributesOf = (node: HtmlNode) => ({ tag: node.tag, ...Object.fromEntries(node.attributes) });

/** The info card's rows, label to text. */
const infoOf = (doc: HtmlNode) =>
  Object.fromEntries(
    byClass(doc, "info-row").map((row) => {
      const [label, value] = row.children.filter((child) => child.tag !== "#text");
      return [label === undefined ? "" : textOf(label), value === undefined ? "" : textOf(value)];
    }),
  );

/** A response's CSP, by directive name. */
function policyOf(response: Response): Record<string, string> {
  const policy = response.headers.get("Content-Security-Policy") ?? "";
  return Object.fromEntries(
    policy.split(";").map((directive) => {
      const [name = "", ...values] = directive.trim().split(/\s+/);
      return [name, values.join(" ")];
    }),
  );
}

/** A body of exactly `bytes` bytes that holds the given fields: `&` separates nothing, so it adds no field. */
const padded = (fields: string, bytes: number) => fields + "&".repeat(bytes - fields.length);

function chunked(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 100) controller.enqueue(bytes.slice(i, i + 100));
      controller.close();
    },
  });
}

/** An Access verifier that throws, so the request reaches the Worker's outer error handler. */
class ThrowingVerifier extends AccessVerifier {
  override verify(): Promise<AccessOutcome> {
    return Promise.reject(new Error("verifier failed"));
  }
}

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

const PATHS = (id: string) => [`/a/${id}/public`, `/a/${id}/delete`];

// PL-11, PL-56, ISO-3, ACC-1.
describe("section 10: routes, methods and Access", () => {
  it.each(["PUT", "DELETE", "PATCH", "OPTIONS", "PROPFIND"])(
    "answers %s with 405 and its Allow, before Access or storage",
    async (method) => {
      const world = new World();
      const { db, bucket } = untouchable(world);
      for (const path of PATHS(UNKNOWN_ID)) {
        const response = await app(world, path, {
          jwt: null,
          method,
          headers: { Origin: APP },
          ...(method === "OPTIONS" || method === "PROPFIND" ? {} : { body: "public=true" }),
        });
        expect({ path, status: response.status }).toEqual({ path, status: 405 });
        expect(response.headers.get("Allow")).toBe("GET, HEAD, POST");
      }
      expect(db.batches).toBe(0);
      expect(bucket.calls).toEqual([]);
      expect(world.keys.calls).toBe(0);
    },
  );

  it("takes the exact paths only", async () => {
    const world = new World();
    const id = await create(world);
    for (const path of [`/a/${id}/public/`, `/a/${id}/Delete`, `/a/${id}/public/x`, `/a/${id}/v/1/delete`]) {
      expect({ path, status: (await app(world, path)).status }).toEqual({ path, status: 404 });
      const posted = await post(world, path, "public=true");
      expect({ path, status: posted.status, allow: posted.headers.get("Allow") }).toEqual({
        path,
        status: 405,
        allow: "GET, HEAD",
      });
    }
    expect(await isPublic(world, id)).toBe(false);
  });

  it("refuses GET, HEAD and POST without an app-audience JWT, before reading the body or storage", async () => {
    const world = new World();
    const { db, bucket } = untouchable(world);
    for (const jwt of [null, await world.jwt({ aud: CONTENT_AUD })]) {
      for (const path of PATHS(UNKNOWN_ID)) {
        for (const method of ["GET", "HEAD"]) {
          expect((await app(world, path, { jwt, method })).status).toBe(403);
        }
        const request = await appRequest(world, path, {
          jwt,
          method: "POST",
          headers: FORM,
          body: chunked("public=true"),
        });
        expect((await world.fetch(request)).status).toBe(403);
        expect({ path, bodyUsed: request.bodyUsed }).toEqual({ path, bodyUsed: false });
      }
    }
    expect(db.batches).toBe(0);
    expect(bucket.calls).toEqual([]);
  });

  it("answers 404 for an unknown, a malformed and a deleted artifact", async () => {
    const world = new World();
    const deleted = await create(world);
    expect((await world.api("DELETE", `/v1/artifacts/${deleted}`)).status).toBe(204);
    for (const id of [UNKNOWN_ID, "short", deleted]) {
      for (const path of PATHS(id)) {
        expect({ path, status: (await app(world, path)).status }).toEqual({ path, status: 404 });
      }
      const posted = await post(world, `/a/${id}/public`, "public=true");
      expect({ id, status: posted.status }).toEqual({ id, status: 404 });
    }
    // A delete repeated on a tombstone succeeds, as on REST; an ID that never existed is not found.
    expect((await post(world, `/a/${deleted}/delete`, "")).status).toBe(200);
    expect((await post(world, `/a/${UNKNOWN_ID}/delete`, "")).status).toBe(404);
  });
});

// PL-56, ISO-5: what each page shows and posts.
describe("section 10: the pages", () => {
  it("offers Make public for a private artifact, with its versions and public URL", async () => {
    const world = new World();
    const id = await create(world, "Chart");
    await world.updated(id, { base_version: 1, files: { "b.html": "b" } });
    const doc = await documentOf(await app(world, `/a/${id}/public`));
    expect(textOf(one(byTag(doc, "title")))).toBe("Make public · artifacts");
    expect(textOf(one(byTag(doc, "h1")))).toBe("Make this artifact public?");
    expect(infoOf(doc)).toEqual({
      Artifact: "Chart",
      ID: id,
      Versions: "2; every version becomes public",
      "Public link": `https://${id}${PUBLIC_SUFFIX}/`,
    });
    expect(attributesOf(one(byTag(doc, "form")))).toEqual({
      tag: "form",
      class: "form",
      method: "post",
      action: `/a/${id}/public`,
    });
    expect(byTag(doc, "input").map(attributesOf)).toEqual([
      { tag: "input", type: "hidden", name: "public", value: "true" },
    ]);
    expect(byTag(doc, "button").map((button) => [textOf(button), button.attributes.get("class")])).toEqual([
      ["Make public", "button button--primary"],
    ]);
    const cancel = one(byClass(doc, "button--secondary"));
    expect([cancel.tag, textOf(cancel), cancel.attributes.get("href")]).toEqual(["a", "Cancel", `/a/${id}`]);
    expect(byTag(doc, "script")).toEqual([]);
  });

  it("offers Make private for a public artifact, posting public=false", async () => {
    const world = new World();
    const id = await create(world, "Chart");
    expect((await world.patch(id, { public: true })).status).toBe(200);
    const doc = await documentOf(await app(world, `/a/${id}/public`));
    expect(textOf(one(byTag(doc, "h1")))).toBe("Make this artifact private?");
    expect(infoOf(doc)).toEqual({
      Artifact: "Chart",
      ID: id,
      Versions: "1; every version becomes private",
      "Public link": `https://${id}${PUBLIC_SUFFIX}/`,
    });
    expect(textOf(one(byClass(doc, "notice")))).toBe(
      "Every version’s public URL answers 404 from the next request. Make it public again at any time.",
    );
    expect(byTag(doc, "input").map((input) => input.attributes.get("value"))).toEqual(["false"]);
    expect(byTag(doc, "button").map(textOf)).toEqual(["Make private"]);
  });

  it("states what a delete removes and offers Delete, with a form without fields", async () => {
    const world = new World();
    const id = await create(world, "Chart", { "a.css": "x".repeat(1_500) });
    expect((await world.patch(id, { public: true })).status).toBe(200);
    const doc = await documentOf(await app(world, `/a/${id}/delete`));
    expect(textOf(one(byTag(doc, "h1")))).toBe("Delete this artifact?");
    expect(textOf(one(byClass(doc, "page-heading")))).toContain("never used again");
    expect(infoOf(doc)).toEqual({
      Artifact: "Chart",
      ID: id,
      Versions: "1 version, 2 files, 1.5 KB",
      Visibility: "Public",
    });
    const notice = one(byClass(doc, "notice"));
    expect(notice.attributes.get("class")).toBe("notice notice--danger");
    expect(textOf(notice)).toContain("Every URL of every version answers 404");
    expect(attributesOf(one(byTag(doc, "form")))).toMatchObject({ method: "post", action: `/a/${id}/delete` });
    expect(byTag(doc, "input")).toEqual([]);
    expect(byTag(doc, "button").map((button) => [textOf(button), button.attributes.get("class")])).toEqual([
      ["Delete", "button button--danger"],
    ]);
  });

  it("answers HEAD with GET's headers and no body", async () => {
    const world = new World();
    const id = await create(world);
    for (const path of PATHS(id)) {
      const get = await app(world, path);
      const head = await app(world, path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect([...head.headers]).toEqual([...get.headers]);
      expect(Number(get.headers.get("Content-Length"))).toBe((await get.arrayBuffer()).byteLength);
      expect(await head.text()).toBe("");
    }
  });

  it("keeps markup in a title as text on the pages and the result page", async () => {
    const TITLE = `"><script>alert(1)</script><img src=x onerror=alert(1)>'&amp;</form><form action="https://evil.example.org">`;
    const world = new World();
    const id = await create(world, TITLE);
    const pages = [
      await app(world, `/a/${id}/public`),
      await app(world, `/a/${id}/delete`),
      await post(world, `/a/${id}/public`, "public=true"),
    ];
    for (const response of pages) {
      expect(response.status).toBe(200);
      const doc = await documentOf(response);
      expect(infoOf(doc).Artifact).toBe(TITLE);
      expect(byTag(doc, "img").map((img) => img.attributes.get("class"))).toEqual(["brand__icon"]);
      expect(byTag(doc, "form").length).toBeLessThanOrEqual(1);
      expect(byTag(doc, "form").map((form) => form.attributes.get("action")?.startsWith(`/a/${id}/`))).not.toContain(
        false,
      );
      expect(
        elements(doc)
          .flatMap((node) => [...node.attributes.keys()])
          .filter((name) => name.startsWith("on")),
      ).toEqual([]);
    }
    // The result page's one script is its own; the title added none.
    expect(byTag(await documentOf(await post(world, `/a/${id}/public`, "public=false")), "script")).toHaveLength(1);
  });
});

/** Every directive the gallery's CSP sets on these pages, besides `form-action` and `script-src`. */
const BASE_POLICY = {
  "default-src": "'none'",
  "style-src": "'self'",
  "font-src": "'self'",
  "img-src": "'self'",
  "base-uri": "'none'",
  "frame-ancestors": "'none'",
};

// PL-11, PL-56, ISO-2, ISO-4, ISO-5: the pages' headers, with their policy, on every status.
describe("section 10: headers", () => {
  it("sends no-store, same-origin referrers, the CSP and no cookie on every answer", async () => {
    const world = new World({ keyTimeoutMs: 50 });
    const id = await create(world);
    const other = await create(world, "Other");
    const answers: [string, Response][] = [
      ["form", await app(world, `/a/${id}/public`)],
      ["form", await app(world, `/a/${id}/delete`)],
      ["form", await app(world, `/a/${id}/public`, { method: "HEAD" })],
      ["form", await app(world, `/a/${id}/public`, { headers: { "If-None-Match": "*" } })],
      ["result", await post(world, `/a/${id}/public`, "public=true")],
      ["result", await post(world, `/a/${other}/delete`, "")],
      ["refusal", await app(world, `/a/${UNKNOWN_ID}/public`)],
      ["refusal", await app(world, `/a/${id}/public`, { method: "PUT" })],
      ["refusal", await app(world, `/a/${id}/public`, { jwt: null })],
      ["refusal", await post(world, `/a/${id}/public`, "public=true", { Origin: null })],
      ["refusal", await post(world, `/a/${id}/public`, "public=true", { "Sec-Fetch-Site": "cross-site" })],
      ["refusal", await post(world, `/a/${id}/public`, "public=toggle")],
      ["refusal", await post(world, `/a/${id}/public`, padded("public=true", FORM_BYTES + 1))],
    ];
    // A read that times out, a key set that cannot be fetched, and the outer handler's 500.
    const slow = new World({ timeouts: { r2Ms: 2_000, d1ReadMs: 50, kvReadMs: 2_000 } });
    const db = new DatabaseProbe();
    db.behave = () => never();
    slow.env = { ...slow.env, DB: db.binding };
    answers.push(["refusal", await app(slow, `/a/${id}/public`)]);
    const unreachable = new World({ keyTimeoutMs: 50 });
    unreachable.keys.mode = "hang";
    answers.push(["refusal", await app(unreachable, `/a/${id}/delete`)]);
    const failing = createWorker({
      now: () => START,
      newId: newArtifactId,
      sleep: async () => {},
      timeouts: { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 2_000 },
      access: new ThrowingVerifier({ fetch: world.keys.fetch, now: () => START }),
    });
    captureLogs();
    const failed = await failing.fetch(new Request(`${APP}/a/${id}/public`), world.env, createExecutionContext());
    answers.push(["refusal", failed]);
    expect(answers.map(([, response]) => response.status)).toEqual([
      200, 200, 200, 200, 200, 200, 404, 405, 403, 403, 403, 400, 413, 503, 503, 500,
    ]);
    // The result page's script, by its hash (its value is checked against the script's in the result page's tests).
    const scriptHash = { "script-src": expect.stringMatching(/^'sha256-[A-Za-z0-9+/]{43}='$/) };
    for (const [kind, response] of answers) {
      const headers = response.headers;
      expect(headers.get("Cache-Control")).toBe("no-store");
      expect(headers.get("Referrer-Policy")).toBe("same-origin");
      expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
      for (const absent of ["ETag", "Vary", "Cross-Origin-Opener-Policy", "Set-Cookie"]) {
        expect({ absent, value: headers.get(absent) }).toEqual({ absent, value: null });
      }
      expect([...headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
      expect(policyOf(response)).toEqual({
        ...BASE_POLICY,
        "form-action": kind === "form" ? "'self'" : "'none'",
        ...(kind === "result" ? scriptHash : {}),
      });
    }
  });
});

// PL-57, ISO-3, RES-1, PUB-2.
describe("section 10: the POST", () => {
  const ORIGINS: [string, string | null][] = [
    ["missing", null],
    ["null", "null"],
    ["a content host's", `https://${UNKNOWN_ID}${CONTENT_SUFFIX}`],
    ["a public host's", `https://${UNKNOWN_ID}${PUBLIC_SUFFIX}`],
    ["the app host's over http", `http://${APP_HOST}`],
    ["the app host's on another port", `https://${APP_HOST}:8443`],
    ["another site's", "https://evil.example.org"],
  ];

  it.each(ORIGINS)("refuses the Origin %s and changes nothing", async (_name, origin) => {
    const world = new World();
    const id = await create(world);
    const before = await snapshot();
    const logs = captureLogs();
    for (const [path, body] of [
      [`/a/${id}/public`, "public=true"],
      [`/a/${id}/delete`, ""],
    ] as const) {
      expect((await post(world, path, body, { Origin: origin })).status).toBe(403);
    }
    expect(await snapshot()).toEqual(before);
    expect(logEvents(logs.lines)).toEqual([
      { event: "confirm.refused", reason: "origin" },
      { event: "confirm.refused", reason: "origin" },
    ]);
  });

  it.each([
    ["missing", null],
    ["same-site", "same-site"],
    ["cross-site", "cross-site"],
    ["none", "none"],
  ])("refuses Sec-Fetch-Site %s and changes nothing", async (_name, site) => {
    const world = new World();
    const id = await create(world);
    const before = await snapshot();
    const logs = captureLogs();
    expect((await post(world, `/a/${id}/public`, "public=true", { "Sec-Fetch-Site": site })).status).toBe(403);
    expect((await post(world, `/a/${id}/delete`, "", { "Sec-Fetch-Site": site })).status).toBe(403);
    expect(await snapshot()).toEqual(before);
    expect(logEvents(logs.lines)).toEqual([
      { event: "confirm.refused", reason: "site" },
      { event: "confirm.refused", reason: "site" },
    ]);
  });

  // ISO-3: an artifact page, same-site in the shared-domain layout, sends its own origin; so does a page on another
  // subdomain of the zone, and a page of another site.
  it("refuses a form posted by an artifact page, another subdomain of the zone, or another site", async () => {
    const world = new World();
    const id = await create(world);
    const before = await snapshot();
    for (const [origin, site] of <[string, string][]>[
      [`https://${id}${CONTENT_SUFFIX}`, "same-site"],
      [`https://${id}${PUBLIC_SUFFIX}`, "same-site"],
      ["https://other.example.com", "same-site"],
      ["https://evil.example.org", "cross-site"],
    ]) {
      for (const [path, body] of [
        [`/a/${id}/public`, "public=true"],
        [`/a/${id}/delete`, ""],
      ] as const) {
        const response = await post(world, path, body, { Origin: origin, "Sec-Fetch-Site": site });
        expect({ origin, path, status: response.status }).toEqual({ origin, path, status: 403 });
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it.each<[string, string, string, string | null]>([
    ["another content type", "public", "public=true", "text/plain"],
    ["a multipart body", "public", "public=true", "multipart/form-data; boundary=x"],
    ["JSON", "public", '{"public":true}', "application/json"],
    ["no content type", "public", "public=true", null],
    ["a missing field", "public", "", FORM["Content-Type"]],
    ["a repeated field", "public", "public=true&public=true", FORM["Content-Type"]],
    ["an unknown field", "public", "public=true&title=x", FORM["Content-Type"]],
    ["another name", "public", "Public=true", FORM["Content-Type"]],
    ["a toggle", "public", "public=toggle", FORM["Content-Type"]],
    ["another spelling", "public", "public=TRUE", FORM["Content-Type"]],
    ["a field on the delete form", "delete", "confirm=1", FORM["Content-Type"]],
    ["the public field on the delete form", "delete", "public=false", FORM["Content-Type"]],
  ])("refuses %s with 400 and changes nothing", async (_name, action, body, type) => {
    const world = new World();
    const id = await create(world);
    const before = await snapshot();
    const logs = captureLogs();
    expect((await post(world, `/a/${id}/${action}`, body, { "Content-Type": type })).status).toBe(400);
    expect(await snapshot()).toEqual(before);
    expect(logEvents(logs.lines)).toEqual([{ event: "confirm.refused", reason: "body" }]);
  });

  it("takes a form of 1 KiB and refuses one byte more, with or without Content-Length", async () => {
    const world = new World();
    const id = await create(world);
    const kept = await create(world, "Kept");
    const before = await snapshot();
    expect((await post(world, `/a/${id}/public`, padded("public=true", FORM_BYTES + 1))).status).toBe(413);
    expect((await post(world, `/a/${id}/public`, chunked(padded("public=true", FORM_BYTES + 1)))).status).toBe(413);
    expect((await post(world, `/a/${kept}/delete`, chunked(padded("", FORM_BYTES + 1)))).status).toBe(413);
    expect(await snapshot()).toEqual(before);
    expect((await post(world, `/a/${id}/public`, chunked(padded("public=true", FORM_BYTES)))).status).toBe(200);
    expect(await isPublic(world, id)).toBe(true);
    expect((await post(world, `/a/${id}/public`, padded("public=false", FORM_BYTES))).status).toBe(200);
    expect(await isPublic(world, id)).toBe(false);
    expect((await post(world, `/a/${kept}/delete`, padded("", FORM_BYTES))).status).toBe(200);
    expect(await isPublic(world, kept)).toBeUndefined();
  });

  it("applies the state the form names, so a repeated POST does not reverse it", async () => {
    const world = new World();
    const id = await create(world);
    for (let i = 0; i < 2; i++) {
      const response = await post(world, `/a/${id}/public`, "public=true");
      expect(response.status).toBe(200);
      expect(textOf(one(byTag(await documentOf(response), "h1")))).toBe("The artifact is public");
      expect(await isPublic(world, id)).toBe(true);
      expect((await world.public(id, "/")).status).toBe(200);
    }
    for (let i = 0; i < 2; i++) {
      const response = await post(world, `/a/${id}/public`, "public=false");
      expect(response.status).toBe(200);
      expect(textOf(one(byTag(await documentOf(response), "h1")))).toBe("The artifact is private");
      expect(await isPublic(world, id)).toBe(false);
      expect((await world.public(id, "/")).status).toBe(404);
    }
  });

  it("deletes the artifact, and answers a repeated delete like the first", async () => {
    const world = new World();
    const id = await create(world);
    for (let i = 0; i < 2; i++) {
      const response = await post(world, `/a/${id}/delete`, "");
      expect(response.status).toBe(200);
      expect(textOf(one(byTag(await documentOf(response), "h1")))).toBe("The artifact is deleted");
    }
    expect((await world.api("GET", `/v1/artifacts/${id}`)).status).toBe(404);
    expect((await world.content(id, "/")).status).toBe(404);
    expect((await app(world, `/a/${id}`)).status).toBe(404);
  });
});

/** The result page's one script: its text and the policy's source for it. */
async function scriptOf(response: Response): Promise<{ text: string; source: string | undefined; hash: string }> {
  const source = policyOf(response.clone())["script-src"];
  const doc = await documentOf(response);
  const script = one(byTag(doc, "script"));
  const text = script.children.map((child) => child.text).join("");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return { text, source, hash: `'sha256-${btoa(String.fromCharCode(...digest))}'` };
}

/** The result page's target: its one link marked `data-opener`. */
const targetOf = (doc: HtmlNode) => one(elements(doc).filter((node) => node.attributes.has("data-opener")));

/** The info card's links, each as its text and `href`. */
const linksOf = (doc: HtmlNode) =>
  byClass(doc, "info-row__link").map((value) => {
    const link = one(byTag(value, "a"));
    return [textOf(link), link.attributes.get("href")];
  });

// PL-58, ISO-5.
describe("section 10: the result page", () => {
  it("admits its one script by its hash, the same bytes for every artifact and result", async () => {
    const world = new World();
    const first = await create(world, "First");
    const second = await create(world, "Second");
    const results = [
      await post(world, `/a/${first}/public`, "public=true"),
      await post(world, `/a/${second}/public`, "public=true"),
      await post(world, `/a/${first}/public`, "public=false"),
      await post(world, `/a/${second}/delete`, ""),
    ];
    const scripts = await Promise.all(results.map(scriptOf));
    for (const script of scripts) expect(script.source).toBe(script.hash);
    expect(new Set(scripts.map((script) => script.text)).size).toBe(1);
    expect(scripts[0]?.text).toContain("window.opener");
  });

  it("marks the artifact's URL as the target after a visibility change and the gallery after a delete", async () => {
    const world = new World();
    const id = await create(world, "Chart");
    const madePublic = await documentOf(await post(world, `/a/${id}/public`, "public=true"));
    expect(targetOf(madePublic).attributes.get("href")).toBe(`https://${id}${CONTENT_SUFFIX}/`);
    expect(linksOf(madePublic)).toEqual([
      [`https://${id}${CONTENT_SUFFIX}/ ↗`, `https://${id}${CONTENT_SUFFIX}/`],
      [`https://${id}${PUBLIC_SUFFIX}/ ↗`, `https://${id}${PUBLIC_SUFFIX}/`],
      ["Artifact page", `/a/${id}`],
      ["All artifacts", "/"],
    ]);
    expect(infoOf(madePublic).Artifact).toBe("Chart");

    const madePrivate = await documentOf(await post(world, `/a/${id}/public`, "public=false"));
    expect(targetOf(madePrivate).attributes.get("href")).toBe(`https://${id}${CONTENT_SUFFIX}/`);
    expect(linksOf(madePrivate).map(([, href]) => href)).toEqual([`https://${id}${CONTENT_SUFFIX}/`, `/a/${id}`, "/"]);

    const deleted = await documentOf(await post(world, `/a/${id}/delete`, ""));
    expect(targetOf(deleted).attributes.get("href")).toBe("/");
    expect(linksOf(deleted)).toEqual([["All artifacts", "/"]]);
    expect(infoOf(deleted).ID).toBe(id);
  });
});

// PL-59, TOK-3, DATA-1.
describe("section 11: logs", () => {
  it("logs a change with via: gallery and neither token nor grant, and a refusal with its reason only", async () => {
    const world = new World();
    const id = await create(world);
    const logs = captureLogs();
    await post(world, `/a/${id}/public`, "public=true");
    await post(world, `/a/${id}/public`, "public=false");
    await post(world, `/a/${id}/public`, "public=true", { Origin: "https://evil.example.org" });
    await post(world, `/a/${id}/public`, "public=true", { "Sec-Fetch-Site": "same-site" });
    await post(world, `/a/${id}/public`, "public=maybe");
    await post(world, `/a/${id}/delete`, "");
    expect(logEvents(logs.lines)).toEqual([
      { event: "artifact.changed", via: "gallery", artifact: id, public: true },
      { event: "artifact.changed", via: "gallery", artifact: id, public: false },
      { event: "confirm.refused", reason: "origin" },
      { event: "confirm.refused", reason: "site" },
      { event: "confirm.refused", reason: "body" },
      { event: "artifact.deleted", via: "gallery", artifact: id },
    ]);
  });
});
