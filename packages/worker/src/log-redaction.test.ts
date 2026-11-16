import { env } from "cloudflare:workers";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BucketProbe, captureLogs, DatabaseProbe, never, TOKENS, World } from "./test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

// DATA-1, TOK-2: markers for every kind of value that must never reach the console.
const MARKERS = {
  title: "TITLE-MARKER",
  description: "DESCRIPTION-MARKER",
  path: "PATH-MARKER",
  bytes: "BYTES-MARKER",
  claim: "JWT-CLAIM-MARKER",
  cookie: "COOKIE-MARKER",
  error: "ERROR-MESSAGE-MARKER",
  badToken: "art_markermarkermarkermarkermarker",
  config: "CONFIG-MARKER",
};

describe("DATA-1: log redaction", () => {
  it("logs no secret and no artifact content on any route or failure path", async () => {
    const world = new World({ timeouts: { r2Ms: 50, d1ReadMs: 50 }, keyTimeoutMs: 50 });
    const logs = captureLogs();
    const responses: Response[] = [];
    const keep = async (response: Response | Promise<Response>) => {
      const resolved = await response;
      responses.push(resolved.clone());
      return resolved;
    };
    const files = { "index.html": `<p>${MARKERS.bytes}</p>`, [`${MARKERS.path}.txt`]: MARKERS.bytes };

    // Changes and reads.
    const created = await (
      await keep(world.create({ title: MARKERS.title, description: MARKERS.description, files }))
    ).json<{ artifact: { id: string } }>();
    const id = created.artifact.id;
    await keep(
      world.update(id, { base_version: 1, title: `${MARKERS.title}2`, files: { [`${MARKERS.path}2`]: MARKERS.bytes } }),
    );
    await keep(world.api("GET", `/v1/artifacts/${id}`));
    await keep(world.api("GET", "/v1/artifacts"));
    await keep(world.api("GET", `/v1/artifacts/${id}/versions`));
    await keep(world.api("GET", `/v1/artifacts/${id}/versions/1/files/${MARKERS.path}.txt`));
    await keep(world.patch(id, { public: true, archive: "kept" }));
    const jwt = await world.jwt();
    await keep(world.content(id, `/${MARKERS.path}.txt`, { jwt }));
    await keep(world.public(id, `/_v/1/${MARKERS.path}.txt`));

    // Refusals.
    await keep(world.api("GET", "/v1/artifacts", { token: MARKERS.badToken }));
    await keep(
      world.api("GET", "/v1/artifacts", { token: null, headers: { Authorization: `Basic ${MARKERS.badToken}` } }),
    );
    const foreign = await new SignJWT({ marker: MARKERS.claim, exp: Math.floor(world.clock.now / 1000) + 60 })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("k".repeat(32)));
    await keep(world.content(id, "/", { jwt: foreign }));
    await keep(world.content(id, "/", { jwt: await world.jwt({ aud: MARKERS.claim }) }));
    await keep(world.content(id, "/", { jwt: null, headers: { Cookie: `CF_Authorization=${MARKERS.cookie}` } }));
    await keep(world.create({ title: MARKERS.title, files: { "index.html": "x", [`_v/${MARKERS.path}`]: "x" } }));
    await keep(world.create({ title: `${MARKERS.title}\n`, files: { "index.html": "x" } }));

    // Storage failures with marker messages.
    const bucket = new BucketProbe();
    const database = new DatabaseProbe();
    world.env = { ...world.env, FILES: bucket.binding, DB: database.binding };
    bucket.behave = (op) => (op === "put" ? Promise.reject(new Error(MARKERS.error)) : undefined);
    await keep(world.create({ title: MARKERS.title, files: { "index.html": `${MARKERS.bytes}-new` } }));
    bucket.behave = (op) => (op === "get" ? never() : undefined);
    await keep(world.content(id, "/"));
    bucket.behave = () => undefined;
    database.behave = (_index, statements) =>
      statements.length > 2 ? Promise.reject(new Error(MARKERS.error)) : undefined;
    await keep(world.create({ title: MARKERS.title, files: { "index.html": `${MARKERS.bytes}-other` } }));
    await keep(world.update(id, { base_version: 2, files: { [`${MARKERS.path}3`]: `${MARKERS.bytes}-3` } }));
    database.behave = () => Promise.reject(new Error(MARKERS.error));
    await keep(world.api("GET", `/v1/artifacts/${id}`));
    await keep(world.patch(id, { public: false }));
    database.behave = () => undefined;
    bucket.behave = (op) => (op === "delete" ? Promise.reject(new Error(MARKERS.error)) : undefined);
    await keep(world.api("DELETE", `/v1/artifacts/${id}`));

    // A thrown error outside the operations.
    const throwing = { ...world.env };
    Object.defineProperty(throwing, "DB", {
      get() {
        throw new Error(MARKERS.error);
      },
    });
    world.env = throwing;
    await keep(world.api("GET", "/v1/artifacts"));
    world.env = { ...env, FILES: bucket.binding };

    // An unreachable key set and an invalid configuration.
    const down = new World({ keyTimeoutMs: 50 });
    down.keys.mode = "down";
    await keep(down.content(id, "/"));
    const misconfigured = new World({ vars: { API_TOKENS: `{"${MARKERS.config}": 1}` } });
    await keep(misconfigured.api("GET", "/v1/artifacts"));

    const text = logs.text();
    expect(logs.lines.length).toBeGreaterThan(10);
    for (const event of [
      "artifact.created",
      "artifact.updated",
      "artifact.changed",
      "artifact.deleted",
      "token.refused",
      "access.refused",
      "access.unavailable",
      "operation.failed",
      "cleanup.failed",
      "request.failed",
      "config.invalid",
    ]) {
      expect(text).toContain(event);
    }
    for (const marker of [...Object.values(MARKERS), TOKENS.codex, jwt, foreign]) {
      expect(text).not.toContain(marker);
    }

    // TOK-2: no response echoes a token.
    for (const response of responses) {
      const echoed = `${[...response.headers].join("\n")}\n${await response.text()}`;
      for (const token of [TOKENS.codex, MARKERS.badToken]) expect(echoed).not.toContain(token);
    }
  });
});
