import { env } from "cloudflare:workers";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  API,
  APP_AUD,
  APP_HOST,
  BucketProbe,
  callTool,
  captureLogs,
  DatabaseProbe,
  mcpClient,
  never,
  stringAt,
  TOKENS,
  World,
} from "./test-support.ts";

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
  origin: "ORIGIN-MARKER",
  body: "BODY-MARKER",
};

const file = (path: string, content: string) => ({ path, content });

describe("DATA-1: log redaction", () => {
  it("logs no secret and no artifact content on any route or failure path", async () => {
    const world = new World({ timeouts: { r2Ms: 50, d1ReadMs: 50, kvReadMs: 50 }, keyTimeoutMs: 50 });
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
    // Exports: the archive on REST and the app host, and a version whose paths cannot be extracted, which the answer
    // names and the log never does.
    await (await keep(world.api("GET", `/v1/artifacts/${id}/versions/1/export`))).arrayBuffer();
    const download = world.fetch(`https://${APP_HOST}/a/${id}/v/1/export`, {
      headers: { "Cf-Access-Jwt-Assertion": await world.jwt({ aud: APP_AUD }) },
    });
    await (await keep(download)).arrayBuffer();
    const clash = await (
      await keep(
        world.create({ title: "clash", files: { "index.html": "x", [MARKERS.path]: "x", [`${MARKERS.path}/x`]: "x" } }),
      )
    ).json<{ artifact: { id: string } }>();
    expect((await keep(world.api("GET", `/v1/artifacts/${clash.artifact.id}/versions/1/export`))).status).toBe(409);

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
    await keep(world.api("GET", `/v1/artifacts/${id}/versions/1/export`));
    // An export that fails after its headers: the second file's get (the marker path's) fails.
    let gets = 0;
    bucket.behave = (op) => (op === "get" && ++gets === 2 ? Promise.reject(new Error(MARKERS.error)) : undefined);
    const aborted = await world.api("GET", `/v1/artifacts/${id}/versions/1/export`);
    expect(aborted.status).toBe(200);
    await expect(aborted.arrayBuffer()).rejects.toBeDefined();
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

  it("logs no secret and no artifact content on the MCP route or its failure paths", async () => {
    const world = new World({ timeouts: { r2Ms: 50, d1ReadMs: 50, kvReadMs: 50 } });
    const logs = captureLogs();
    const responses: Response[] = [];
    const fetch = world.fetch.bind(world);
    world.fetch = async (input, init) => {
      const response = await fetch(input, init);
      responses.push(response.clone());
      return response;
    };
    const client = await mcpClient(world);

    // Changes and reads.
    const created = await callTool(client, "create_artifact", {
      title: MARKERS.title,
      description: MARKERS.description,
      files: [file("index.html", MARKERS.bytes), file(`${MARKERS.path}.txt`, MARKERS.bytes)],
    });
    const id = stringAt(created.value, "artifact", "id");
    await callTool(client, "update_artifact", {
      id,
      base_version: 1,
      title: `${MARKERS.title}2`,
      files: [file(`${MARKERS.path}2`, MARKERS.bytes)],
    });
    await callTool(client, "get_artifact", { id });
    await callTool(client, "list_artifacts", {});
    await callTool(client, "list_versions", { id });
    await callTool(client, "read_file", { id, version: 1, path: `${MARKERS.path}.txt` });
    await callTool(client, "set_public", { id, public: true });
    await callTool(client, "set_archive", { id, archive: "kept" });

    // Refusals: schema, operation errors.
    await callTool(client, "create_artifact", { title: `${MARKERS.title}\n`, files: [file("index.html", "x")] });
    await callTool(client, "create_artifact", { title: "t", files: [file(`_v/${MARKERS.path}`, MARKERS.bytes)] });
    await callTool(client, "create_artifact", { title: "t", files: [file(MARKERS.path, MARKERS.bytes)] });
    await callTool(client, "get_artifact", { id: MARKERS.path });
    await callTool(client, "read_file", { id, version: 1, path: MARKERS.path });

    // Transport refusals: tokens, Origin, method, media type, size, malformed and unsupported requests.
    const post = (headers: Record<string, string>, body: BodyInit) =>
      world.fetch(`${API}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body,
      });
    const auth = { Authorization: `Bearer ${TOKENS.codex}` };
    const refusals = [
      await post({ Authorization: `Bearer ${MARKERS.badToken}` }, "{}"),
      await post({ ...auth, Origin: `https://${MARKERS.origin}.example.org` }, "{}"),
      await world.fetch(`${API}/mcp`, { method: "GET", headers: auth }),
      await post({ ...auth, "Content-Type": "text/plain" }, MARKERS.body),
      await post(auth, `"${MARKERS.body}${"x".repeat(4 * 1024 * 1024)}"`),
      await post(auth, `{"${MARKERS.body}`),
    ];
    expect(refusals.map((response) => response.status)).toEqual([401, 403, 405, 415, 413, 400]);
    const unsupported = await post(
      { ...auth, "MCP-Protocol-Version": "2099-01-01" },
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01", marker: MARKERS.body } },
      }),
    );
    expect(unsupported.status).toBe(400);

    // Storage failures with marker messages.
    const bucket = new BucketProbe();
    const database = new DatabaseProbe();
    world.env = { ...world.env, FILES: bucket.binding, DB: database.binding };
    bucket.behave = (op) => (op === "put" ? Promise.reject(new Error(MARKERS.error)) : undefined);
    await callTool(client, "create_artifact", {
      title: MARKERS.title,
      files: [file("index.html", `${MARKERS.bytes}-new`)],
    });
    bucket.behave = (op) => (op === "get" ? never() : undefined);
    await callTool(client, "read_file", { id, version: 1, path: `${MARKERS.path}.txt` });
    bucket.behave = () => undefined;
    database.behave = () => Promise.reject(new Error(MARKERS.error));
    await callTool(client, "list_artifacts", {});
    database.behave = () => undefined;
    bucket.behave = (op) => (op === "delete" ? Promise.reject(new Error(MARKERS.error)) : undefined);
    await callTool(client, "delete_artifact", { id });

    const text = logs.text();
    for (const event of [
      "artifact.created",
      "artifact.updated",
      "artifact.changed",
      "artifact.deleted",
      "token.refused",
      "operation.failed",
      "cleanup.failed",
      "request.failed",
    ]) {
      expect(text).toContain(event);
    }
    for (const marker of [...Object.values(MARKERS), TOKENS.codex]) {
      expect(text).not.toContain(marker);
    }

    // TOK-2: no response echoes a token.
    expect(responses.length).toBeGreaterThan(20);
    for (const response of responses) {
      const echoed = `${[...response.headers].join("\n")}\n${await response.text()}`;
      for (const token of [TOKENS.codex, MARKERS.badToken]) expect(echoed).not.toContain(token);
    }
  });

  // PL-59: the confirmation pages log reason codes and `via`, never a title, an `Origin` value or a form body.
  it("logs no title, Origin value or form body from the confirmation pages", async () => {
    const world = new World({ timeouts: { r2Ms: 50, d1ReadMs: 50, kvReadMs: 50 } });
    const created = await world.created({
      title: MARKERS.title,
      description: MARKERS.description,
      files: { "index.html": "x" },
    });
    const id = created.artifact.id;
    const logs = captureLogs();
    const app = `https://${APP_HOST}`;
    const jwt = await world.jwt({ aud: APP_AUD });
    const request = (path: string, method = "GET", headers: Record<string, string> = {}, body?: string) =>
      world.fetch(`${app}${path}`, {
        method,
        headers: { "Cf-Access-Jwt-Assertion": jwt, ...headers },
        ...(body === undefined ? {} : { body }),
      });
    const form = { Origin: app, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" };
    const statuses = [
      (await request(`/a/${id}/public`)).status,
      (await request(`/a/${id}/delete`)).status,
      (
        await request(
          `/a/${id}/public`,
          "POST",
          { ...form, Origin: `https://${MARKERS.origin}.example.org` },
          "public=true",
        )
      ).status,
      (await request(`/a/${id}/public`, "POST", { ...form, "Sec-Fetch-Site": MARKERS.origin }, "public=true")).status,
      (await request(`/a/${id}/public`, "POST", form, `public=${MARKERS.body}`)).status,
      (await request(`/a/${id}/public`, "POST", form, `${MARKERS.body}=true`)).status,
      (await request(`/a/${id}/public`, "POST", { ...form, "Content-Type": `text/${MARKERS.body}` }, "public=true"))
        .status,
      (await request(`/a/${id}/public`, "POST", form, `public=true&${MARKERS.body}`.padEnd(2_000, "x"))).status,
      (await request(`/a/${MARKERS.path}/public`, "POST", form, "public=true")).status,
      (await request(`/a/${id}/public`, "POST", form, "public=true")).status,
    ];
    // A failed read and a failed delete, with marker messages.
    const database = new DatabaseProbe();
    const bucket = new BucketProbe();
    world.env = { ...world.env, DB: database.binding, FILES: bucket.binding };
    database.behave = () => Promise.reject(new Error(MARKERS.error));
    statuses.push((await request(`/a/${id}/delete`)).status);
    database.behave = () => undefined;
    bucket.behave = (op) => (op === "delete" ? Promise.reject(new Error(MARKERS.error)) : undefined);
    statuses.push((await request(`/a/${id}/delete`, "POST", form, "")).status);
    expect(statuses).toEqual([200, 200, 403, 403, 400, 400, 400, 413, 404, 200, 500, 200]);

    const text = logs.text();
    for (const event of [
      "artifact.changed",
      "artifact.deleted",
      "confirm.refused",
      "operation.failed",
      "cleanup.failed",
    ]) {
      expect(text).toContain(event);
    }
    for (const marker of Object.values(MARKERS)) expect(text).not.toContain(marker);
  });
});
