import { createMcpHandler, type McpHandlerRequestOptions, type McpRequestContext } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import designText from "../../../docs/design.md?raw";
import { parseConfig } from "./config.ts";
import { decodeContent, encodeBase64, ENCODINGS } from "./encoding.ts";
import { ERROR_STATUS, errorBody, OPERATION_ERRORS } from "./errors.ts";
import { newArtifactId } from "./id.ts";
import { handleMcp, INSTRUCTIONS, type McpHandlerFactory } from "./mcp.ts";
import type { OperationDeps } from "./operations.ts";
import {
  API,
  API_HOST,
  at,
  BucketProbe,
  callTool,
  captureLogs,
  clearStorage,
  DatabaseProbe,
  logEvents,
  MCP_VERSIONS,
  mcpClient,
  never,
  snapshot,
  START,
  stringAt,
  testEnv,
  TOKENS,
  toolOutcome,
  World,
  type Fetcher,
  type McpVersion,
  type ToolOutcome,
} from "./test-support.ts";
import { parseApiTokens } from "./tokens.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const MCP = `${API}/mcp`;

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

/** A JSON-RPC POST to `/mcp` as a 2025-era client sends it, without an `initialize` first (stateless serving). */
function rpcRequest(
  body: BodyInit,
  options: { token?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...options.headers,
  });
  const token = options.token === undefined ? TOKENS.codex : options.token;
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return new Request(MCP, { method: "POST", headers, body });
}

const callBody = (name: string, args: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

/** The JSON-RPC result of a response, plain JSON or one SSE message. */
async function rpcResult(response: Response): Promise<{ result?: { isError?: boolean; [key: string]: unknown } }> {
  const text = await response.text();
  const data = response.headers.get("Content-Type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("")
    : text;
  return JSON.parse(data);
}

const index = (content = "<p>page</p>") => ({ path: "index.html", content });

const idOf = (outcome: ToolOutcome): string => stringAt(outcome.value, "artifact", "id");

// AC-11, design.md section 8: the instructions are the design's text, word for word.
describe("server instructions", () => {
  it("are the text of design.md section 8", () => {
    const block = /Server `instructions`:\n\n```text\n([\s\S]*?)\n```/.exec(designText)?.[1];
    expect(block).toBeDefined();
    expect(INSTRUCTIONS).toBe(block);
  });
});

const TOOLS = {
  create_artifact: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update_artifact: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  list_artifacts: { readOnlyHint: true },
  get_artifact: { readOnlyHint: true },
  list_versions: { readOnlyHint: true },
  read_file: { readOnlyHint: true },
  set_public: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  set_archive: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  delete_artifact: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

// PL-27, AC-11: the SDK's client per revision.
describe("PL-27: protocol revisions", () => {
  it.each(MCP_VERSIONS)("serves a %s client: instructions, tools and calls", async (version) => {
    const world = new World();
    const client = await mcpClient(world, { version });
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);

    const { tools } = await client.listTools();
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))).toEqual(TOOLS);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
    }

    const created = await callTool(client, "create_artifact", { title: version, files: [index()] });
    expect(created.ok).toBe(true);
    const id = idOf(created);
    const got = await callTool(client, "get_artifact", { id });
    expect(got).toMatchObject({ ok: true, value: { artifact: { id, title: version }, version: { number: 1 } } });
    await client.close();
  });

  it.each(["GET", "DELETE"])("answers %s with 405", async (method) => {
    const world = new World();
    const response = await world.api(method, "/mcp", { headers: { Accept: "text/event-stream" } });
    expect(response.status).toBe(405);
  });

  it("closes a 2026-07-28 subscriptions/listen stream at once: the tools never change", async () => {
    const world = new World();
    const client = await mcpClient(world, { version: "2026-07-28" });
    const subscription = await client.listen({ toolsListChanged: true });
    expect(subscription.honoredFilter).toEqual({});
    expect(await subscription.closed).toBe("graceful");
    await client.close();
  });
});

// PL-6, HOST-3.
describe("HOST-3: the Origin of /mcp", () => {
  it.each(["https://evil.example.org", "null", `http://${API_HOST}`, `https://${API_HOST}:8443`])(
    "answers Origin %s with 403 before the handler and storage",
    async (origin) => {
      const world = new World();
      const { db, bucket } = untouchable(world);
      const response = await world.fetch(
        rpcRequest(callBody("create_artifact", { title: "t", files: [index()] }), { headers: { Origin: origin } }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
      expect(db.batches).toBe(0);
      expect(bucket.calls).toEqual([]);
    },
  );

  it("serves the API host's own origin and requests without Origin", async () => {
    const world = new World();
    for (const headers of [{ Origin: `https://${API_HOST}` }, {}]) {
      const client = await mcpClient(world, { headers });
      expect((await callTool(client, "list_artifacts", {})).ok).toBe(true);
      await client.close();
    }
  });

  it("checks the token first", async () => {
    const world = new World();
    const response = await world.fetch(
      rpcRequest(callBody("list_artifacts", {}), { token: null, headers: { Origin: "https://evil.example.org" } }),
    );
    expect(response.status).toBe(401);
  });
});

/** Operation dependencies on the test bindings, as the router builds them. */
function testDeps(overrides: Partial<OperationDeps> = {}): OperationDeps {
  const parsed = parseConfig(testEnv());
  if (!parsed.ok) throw new Error("test configuration");
  return {
    db: env.DB,
    bucket: env.FILES,
    config: parsed.config,
    now: () => START,
    newId: newArtifactId,
    sleep: async () => {},
    timeouts: { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 2_000 },
    ...overrides,
  };
}

const CODEX = parseApiTokens(testEnv().API_TOKENS ?? "")?.find((entry) => entry.name === "codex")?.name;

/**
 * A stand-in for the Worker that hands each request to handleMcp as the router does after the credential check: as it
 * arrived, Authorization included, with the token's name.
 */
function atBoundary(deps: OperationDeps, factoryFor?: (request: Request) => McpHandlerFactory): Fetcher {
  if (CODEX === undefined) throw new Error("test configuration");
  const name = CODEX;
  return { fetch: async (request) => handleMcp(request, deps, { name }, factoryFor?.(request)) };
}

// PL-8, TOK-2: what crosses into the SDK.
describe("TOK-2: the MCP handler boundary", () => {
  it.each<McpVersion>(["2025-11-25", "2026-07-28"])(
    "hands the SDK (%s) requests and factory contexts without the token",
    async (version) => {
      const seen: {
        requests: Request[];
        options: (McpHandlerRequestOptions | undefined)[];
        contexts: McpRequestContext[];
      } = { requests: [], options: [], contexts: [] };
      const recording: McpHandlerFactory = (factory, options) => {
        const handler = createMcpHandler((context) => {
          seen.contexts.push(context);
          return factory(context);
        }, options);
        return {
          ...handler,
          fetch: (request, requestOptions) => {
            seen.requests.push(request.clone());
            seen.options.push(requestOptions);
            return handler.fetch(request, requestOptions);
          },
        };
      };
      const sent: Request[] = [];
      const client = await mcpClient(
        atBoundary(testDeps(), (request) => {
          sent.push(request.clone());
          return recording;
        }),
        { version },
      );
      const created = await callTool(client, "create_artifact", { title: "t", files: [index()] });
      await client.close();

      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((request) => request.headers.get("Authorization") === `Bearer ${TOKENS.codex}`)).toBe(true);
      expect(seen.requests).toHaveLength(sent.length);
      for (const request of seen.requests) {
        expect(request.headers.has("Authorization")).toBe(false);
        expect([...request.headers].join("\n")).not.toContain(TOKENS.codex);
      }
      expect(seen.options.every((options) => options?.authInfo === undefined)).toBe(true);
      expect(seen.contexts.length).toBeGreaterThan(0);
      for (const context of seen.contexts) {
        expect(context.authInfo).toBeUndefined();
        expect(context.requestInfo?.headers.has("Authorization")).toBe(false);
        expect([...(context.requestInfo?.headers ?? [])].join("\n")).not.toContain(TOKENS.codex);
      }
      // The factory's closure carries the token name.
      expect(created).toMatchObject({ ok: true, value: { version: { published_by: "codex" } } });
    },
  );
});

// PL-7, TOK-3.
describe("TOK-3: the token name through MCP", () => {
  it("records the caller's token name on versions and change logs", async () => {
    const world = new World();
    const logs = captureLogs();
    const claude = await mcpClient(world, { token: TOKENS.claude });
    const created = await callTool(claude, "create_artifact", { title: "t", files: [index()] });
    const id = idOf(created);
    expect(created).toMatchObject({ ok: true, value: { version: { published_by: "claude" } } });
    const codex = await mcpClient(world);
    const updated = await callTool(codex, "update_artifact", { id, base_version: 1, files: [index("2")] });
    expect(updated).toMatchObject({ ok: true, value: { version: { published_by: "codex" } } });
    await callTool(claude, "set_public", { id, public: true });
    await callTool(codex, "delete_artifact", { id });
    expect(logEvents(logs.lines).filter((line) => line.artifact === id)).toEqual([
      { event: "artifact.created", token: "claude", artifact: id, version: 1 },
      { event: "artifact.updated", token: "codex", artifact: id, version: 2 },
      { event: "artifact.changed", token: "claude", artifact: id, public: true },
      { event: "artifact.deleted", token: "codex", artifact: id },
    ]);
  });
});

// PL-26, PL-23 (the MCP side), P5: one table of cases through both adapters gives the same results and errors.
type Op = "create" | "update" | "list" | "get" | "versions" | "read" | "public" | "archive" | "delete";
type Args = Record<string, unknown>;
type Step = {
  name: string;
  op: Op;
  args: Args | ((previous: ToolOutcome[]) => Args);
  /** A difference design.md section 8 states, pinned as each adapter's outcome. */
  differs?: { rest: ToolOutcome; mcp: ToolOutcome };
};

const TOOL_OF: Record<Op, string> = {
  create: "create_artifact",
  update: "update_artifact",
  list: "list_artifacts",
  get: "get_artifact",
  versions: "list_versions",
  read: "read_file",
  public: "set_public",
  archive: "set_archive",
  delete: "delete_artifact",
};

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const GONE = "cccccccccccccccccccccccccc";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80]);
const NFD = "café.html";
const NFC = "café.html";

const cursorOf = (outcome: ToolOutcome | undefined): string => stringAt(outcome?.value, "next_cursor");

const STEPS: Step[] = [
  {
    name: "create with text, binary, a given type and an NFD path",
    op: "create",
    args: {
      title: "Parity",
      description: "first",
      files: [
        index('<link rel="stylesheet" href="style.css">'),
        { path: "style.css", content: "p { color: red }", content_type: "text/css; charset=utf-8" },
        { path: "img/logo.png", content: encodeBase64(PNG), encoding: "base64" },
        { path: NFD, content: "café" },
        { path: "docs/index.html", content: "<p>docs</p>" },
      ],
    },
  },
  { name: "create without index.html", op: "create", args: { title: "t", files: [{ path: "a.html", content: "a" }] } },
  {
    name: "create with a path given twice after NFC",
    op: "create",
    args: { title: "t", files: [index(), { path: NFC, content: "1" }, { path: NFD, content: "2" }] },
  },
  { name: "create a second artifact", op: "create", args: { title: "Second", files: [index("second")] } },
  {
    name: "update: provide, remove and retitle",
    op: "update",
    args: {
      id: A,
      base_version: 1,
      title: "Parity 2",
      files: [{ path: "style.css", content: "p { color: blue }" }],
      remove: ["img/logo.png"],
    },
  },
  { name: "update from a stale base", op: "update", args: { id: A, base_version: 1, files: [index("late")] } },
  { name: "update removing index.html", op: "update", args: { id: A, base_version: 2, remove: ["index.html"] } },
  {
    name: "update removing a path the base lacks",
    op: "update",
    args: { id: A, base_version: 2, remove: ["nope.txt"] },
  },
  {
    name: "update providing and removing a path",
    op: "update",
    args: { id: A, base_version: 2, files: [{ path: "style.css", content: "x" }], remove: ["style.css"] },
  },
  { name: "update omitting everything keeps the base", op: "update", args: { id: A, base_version: 2 } },
  {
    name: "update replacing index.html and clearing the description",
    op: "update",
    args: { id: A, base_version: 3, description: "", files: [index("v4")] },
  },
  { name: "update an unknown artifact", op: "update", args: { id: GONE, base_version: 1, files: [index()] } },
  { name: "update an invalid ID", op: "update", args: { id: "not-an-id", base_version: 1, files: [index()] } },
  { name: "get the latest", op: "get", args: { id: A } },
  { name: "get version 1", op: "get", args: { id: A, version: 1 } },
  { name: "get a missing version", op: "get", args: { id: A, version: 9 } },
  { name: "get an invalid ID", op: "get", args: { id: "x" } },
  { name: "versions, first page", op: "versions", args: { id: A, limit: 2 } },
  {
    name: "versions, next page",
    op: "versions",
    args: (previous) => ({ id: A, limit: 2, cursor: cursorOf(previous.at(-1)) }),
  },
  { name: "versions with a malformed cursor", op: "versions", args: { id: A, cursor: "0" } },
  { name: "versions of an unknown artifact", op: "versions", args: { id: GONE } },
  { name: "list, first page", op: "list", args: { limit: 1 } },
  { name: "list, next page", op: "list", args: (previous) => ({ limit: 1, cursor: cursorOf(previous.at(-1)) }) },
  { name: "list archived only", op: "list", args: { archived: "only" } },
  { name: "list with a malformed cursor", op: "list", args: { cursor: "bad" } },
  { name: "read text", op: "read", args: { id: A, version: 1, path: "index.html" } },
  { name: "read binary", op: "read", args: { id: A, version: 1, path: "img/logo.png" } },
  { name: "read an NFD path", op: "read", args: { id: A, version: 1, path: NFD } },
  { name: "read a removed path", op: "read", args: { id: A, version: 2, path: "img/logo.png" } },
  { name: "read a directory name", op: "read", args: { id: A, version: 1, path: "img" } },
  {
    name: "read a directory path: REST follows it to index.html, read_file reads exact paths only",
    op: "read",
    args: { id: A, version: 1, path: "docs" },
    differs: {
      rest: { ok: true, value: { status: 308, location: `/v1/artifacts/${A}/versions/1/files/docs/` } },
      mcp: { ok: false, value: errorBody({ code: "not_found" }) },
    },
  },
  { name: "read the directory's index.html", op: "read", args: { id: A, version: 1, path: "docs/index.html" } },
  { name: "read a missing version", op: "read", args: { id: A, version: 9, path: "index.html" } },
  { name: "make public", op: "public", args: { id: A, public: true } },
  { name: "keep out of the archive", op: "archive", args: { id: A, archive: "kept" } },
  { name: "archive", op: "archive", args: { id: A, archive: "archived" } },
  { name: "list archived only, again", op: "list", args: { archived: "only" } },
  { name: "unset the archive setting", op: "archive", args: { id: A, archive: null } },
  { name: "make private", op: "public", args: { id: A, public: false } },
  { name: "make an unknown artifact public", op: "public", args: { id: GONE, public: true } },
  { name: "delete", op: "delete", args: { id: B } },
  { name: "delete again", op: "delete", args: { id: B } },
  { name: "get the deleted artifact", op: "get", args: { id: B } },
  { name: "archive the deleted artifact", op: "archive", args: { id: B, archive: "archived" } },
  { name: "delete an unknown artifact", op: "delete", args: { id: GONE } },
  { name: "delete an invalid ID", op: "delete", args: { id: "x" } },
  { name: "list what is left", op: "list", args: {} },
];

type FileArg = { path: string; content: string; encoding?: "utf8" | "base64"; content_type?: string };

/** The multipart body REST takes for a publish given MCP's arguments. */
function publishForm(args: Args): FormData {
  const { files, ...meta } = args as Args & { files?: FileArg[] };
  const form = new FormData();
  const entries = (files ?? []).map((file) =>
    file.content_type === undefined ? { path: file.path } : { path: file.path, content_type: file.content_type },
  );
  form.append("meta", JSON.stringify(files === undefined ? meta : { ...meta, files: entries }));
  for (const file of files ?? []) {
    const bytes = decodeContent(file.content, file.encoding ?? "utf8");
    if (bytes === undefined) throw new Error("test file content");
    form.append("file", new Blob([bytes]), "f");
  }
  return form;
}

const query = (args: Args) =>
  new URLSearchParams(Object.entries(args).map(([key, value]) => [key, String(value)])).toString();

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A step through REST; an error's status must be the one its code maps to. */
async function viaRest(world: World, op: Op, args: Args): Promise<ToolOutcome> {
  const { id: _id, ...rest } = args;
  const id = String(at(args, "id"));
  const version = String(at(args, "version"));
  let response: Response;
  switch (op) {
    case "create":
      response = await world.api("POST", "/v1/artifacts", { body: publishForm(args) });
      break;
    case "update":
      response = await world.api("POST", `/v1/artifacts/${id}/versions`, { body: publishForm(rest) });
      break;
    case "list":
      response = await world.api("GET", `/v1/artifacts?${query(args)}`);
      break;
    case "get":
      response = await world.api(
        "GET",
        args.version === undefined ? `/v1/artifacts/${id}` : `/v1/artifacts/${id}/versions/${version}`,
      );
      break;
    case "versions":
      response = await world.api("GET", `/v1/artifacts/${id}/versions?${query(rest)}`);
      break;
    case "read": {
      const path = stringAt(args, "path");
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      response = await world.api("GET", `/v1/artifacts/${id}/versions/${version}/files/${encoded}`);
      if (response.status === 308) {
        return { ok: true, value: { status: 308, location: response.headers.get("Location") } };
      }
      if (response.status !== 200) break;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get("Content-Type");
      return {
        ok: true,
        value: { path: path.normalize("NFC"), content_type: contentType, size: bytes.length, bytes: hex(bytes) },
      };
    }
    case "public":
    case "archive":
      response = await world.patch(id, rest);
      break;
    case "delete":
      response = await world.api("DELETE", `/v1/artifacts/${id}`);
      if (response.status === 204) return { ok: true, value: { deleted: id } };
      break;
    default:
      return op satisfies never;
  }
  const value: unknown = await response.json();
  if (response.ok) return { ok: true, value };
  const code = OPERATION_ERRORS.find((known) => known === at(value, "error", "code"));
  expect(code === undefined ? undefined : ERROR_STATUS[code]).toBe(response.status);
  return { ok: false, value };
}

/** A step through MCP; a read's content is decoded to the bytes it stands for. */
async function viaMcp(client: Awaited<ReturnType<typeof mcpClient>>, op: Op, args: Args): Promise<ToolOutcome> {
  const result = await client.callTool({ name: TOOL_OF[op], arguments: args });
  const outcome = toolOutcome(result);
  // The text content carries the same JSON as the structured content.
  const [first] = result.content;
  expect(first?.type === "text" ? JSON.parse(first.text) : undefined).toEqual(outcome.value);
  if (op !== "read" || !outcome.ok) return outcome;
  const encoding = ENCODINGS.find((known) => known === at(outcome.value, "encoding"));
  const bytes = encoding === undefined ? undefined : decodeContent(stringAt(outcome.value, "content"), encoding);
  if (bytes === undefined) throw new Error("read_file returned content that does not decode");
  const value = outcome.value;
  const file = { path: at(value, "path"), content_type: at(value, "content_type"), size: at(value, "size") };
  return { ok: true, value: { ...file, bytes: hex(bytes) } };
}

async function runSteps(through: (world: World) => Promise<(op: Op, args: Args) => Promise<ToolOutcome>>) {
  await clearStorage();
  const world = new World();
  world.ids.push(A, B);
  const run = await through(world);
  const outcomes: ToolOutcome[] = [];
  for (const step of STEPS) {
    world.clock.now += 1_000;
    outcomes.push(await run(step.op, typeof step.args === "function" ? step.args(outcomes) : step.args));
  }
  return outcomes;
}

describe("PL-26: REST and MCP give the same results and operation errors", () => {
  it("runs one table of cases through both adapters (PL-23 on the MCP side)", async () => {
    const rest = await runSteps(async (world) => (op, args) => viaRest(world, op, args));
    const mcp = await runSteps(async (world) => {
      const client = await mcpClient(world);
      return (op, args) => viaMcp(client, op, args);
    });
    STEPS.forEach((step, i) => {
      const expected = step.differs ?? { rest: rest[i], mcp: rest[i] };
      expect({ step: step.name, rest: rest[i], mcp: mcp[i] }).toEqual({ step: step.name, ...expected });
    });
    // The table reaches what it names: the error codes an input that passes both schemas can meet.
    const codes = rest.flatMap((outcome) => (outcome.ok ? [] : [stringAt(outcome.value, "error", "code")]));
    expect(new Set(codes)).toEqual(new Set(["invalid_request", "version_conflict", "not_found"]));
    expect(rest.filter((outcome) => outcome.ok).length).toBeGreaterThan(20);
  });
});

// PL-32, the MCP side: reserved first segments are refused before any write.
describe("PL-32: reserved paths through MCP", () => {
  it.each(["_v/x.html", "cdn-cgi/x.html", "_v", "cdn-cgi"])("refuses %s on create and update", async (path) => {
    await clearStorage();
    const world = new World();
    const client = await mcpClient(world);
    const id = idOf(await callTool(client, "create_artifact", { title: "t", files: [index()] }));
    const before = await snapshot();
    const create = await callTool(client, "create_artifact", { title: "t", files: [index(), { path, content: "x" }] });
    const update = await callTool(client, "update_artifact", { id, base_version: 1, files: [{ path, content: "x" }] });
    for (const outcome of [create, update]) {
      expect(outcome.ok).toBe(false);
      expect(outcome.value).toContain('a path may not start with "_v/" or "cdn-cgi/"');
    }
    expect(await snapshot()).toEqual(before);
  });
});

// Arguments that fail a tool's schema are refused by the SDK as it forms the refusal (design.md section 8, "Errors").
describe("schema refusals through MCP", () => {
  const file = (fields: Record<string, unknown>) => ({ title: "t", files: [index(), { path: "a", ...fields }] });

  it.each<[string, Record<string, unknown>, string]>([
    ["a title with a line break", { title: "a\nb", files: [index()] }, "title: a text has a character"],
    ["an empty title", { title: "", files: [index()] }, "title: a field is empty"],
    ["base64 with whitespace", file({ content: "AAAA AAA", encoding: "base64" }), "files.1.content"],
    ["base64 without padding", file({ content: "AAA", encoding: "base64" }), "files.1.content"],
    ["base64url characters", file({ content: "-_-_", encoding: "base64" }), "files.1.content"],
    ["text that is not well-formed", file({ content: "\ud800" }), "files.1.content"],
    ["an unknown encoding", file({ content: "x", encoding: "hex" }), "files.1.encoding"],
    ["a bad content type", file({ content: "x", content_type: "text" }), "files.1.content_type"],
    ["a NUL in a path", { title: "t", files: [index(), { path: "a\0b", content: "x" }] }, "files.1.path"],
    ["an unknown field", { title: "t", files: [index()], public: true }, "public"],
  ])("refuses %s before any write", async (_name, args, mention) => {
    await clearStorage();
    const world = new World();
    const client = await mcpClient(world);
    const before = await snapshot();
    const outcome = await callTool(client, "create_artifact", args);
    expect(outcome.ok).toBe(false);
    expect(outcome.value).toContain(mention);
    expect(await snapshot()).toEqual(before);
  });

  it("stores utf8 and base64 content as exactly its bytes", async () => {
    const world = new World();
    const client = await mcpClient(world);
    const text = "﻿café 😀";
    const id = idOf(
      await callTool(client, "create_artifact", {
        title: "t",
        files: [
          { path: "index.html", content: text },
          { path: "b.bin", content: encodeBase64(PNG), encoding: "base64" },
          { path: "empty.txt", content: "", encoding: "base64" },
        ],
      }),
    );
    expect(new Uint8Array(await (await world.content(id, "/")).arrayBuffer())).toEqual(new TextEncoder().encode(text));
    expect(new Uint8Array(await (await world.content(id, "/b.bin")).arrayBuffer())).toEqual(PNG);
    expect((await world.content(id, "/empty.txt")).headers.get("Content-Length")).toBe("0");
  });
});

// RES-1: the MCP request bound, 4 MiB counted as the body is read.
const BOUND = 4 * 1024 * 1024;

/** A create call whose JSON body is `bytes` long. */
function sized(bytes: number): string {
  const base = callBody("create_artifact", { title: "t", files: [index("")] });
  return callBody("create_artifact", { title: "t", files: [index("x".repeat(bytes - base.length))] });
}

describe("RES-1: the MCP request body bound", () => {
  it("serves a body of exactly 4 MiB", async () => {
    const world = new World();
    const body = sized(BOUND);
    expect(new TextEncoder().encode(body).byteLength).toBe(BOUND);
    const response = await world.fetch(rpcRequest(body));
    expect(response.status).toBe(200);
    expect((await rpcResult(response)).result?.isError).toBeUndefined();
  });

  it("answers 413 one byte past the bound, with or without Content-Length, before any write", async () => {
    await clearStorage();
    const world = new World();
    const before = await snapshot();
    const body = sized(BOUND + 1);
    expect((await world.fetch(rpcRequest(body))).status).toBe(413);
    const bytes = new TextEncoder().encode(body);
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 65_536) controller.enqueue(bytes.slice(i, i + 65_536));
        controller.close();
      },
    });
    const request = rpcRequest(chunked);
    expect(request.headers.has("Content-Length")).toBe(false);
    expect((await world.fetch(request)).status).toBe(413);
    expect(await snapshot()).toEqual(before);
  });
});

// RES-1: read_file returns at most 1 MiB and names the REST URL of a larger file.
const ODD = "dir/a b\\c#?%é.txt";
/** design.md section 6: read_file returns at most 1 MiB, written out so that a change of the constant fails. */
const MIB = 1_048_576;

async function published(world: World, files: Record<string, Uint8Array | string>): Promise<string> {
  const created = await world.created({ title: "t", files: { "index.html": "x", ...files } });
  return created.artifact.id;
}

describe("read_file", () => {
  it("returns a file of exactly 1 MiB", async () => {
    const world = new World();
    const id = await published(world, { [ODD]: "a".repeat(MIB) });
    const outcome = await callTool(await mcpClient(world), "read_file", { id, version: 1, path: ODD });
    expect(outcome).toMatchObject({ ok: true, value: { size: MIB, encoding: "utf8" } });
    expect(stringAt(outcome.value, "content")).toHaveLength(MIB);
  });

  it("refuses one byte more before reading R2, naming the REST URL that serves it", async () => {
    const world = new World();
    const id = await published(world, { [ODD]: "a".repeat(1_048_577) });
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const outcome = await callTool(await mcpClient(world), "read_file", { id, version: 1, path: ODD });
    const restUrl = `${API}/v1/artifacts/${id}/versions/1/files/dir/a%20b%5Cc%23%3F%25%C3%A9.txt`;
    expect(outcome).toEqual({
      ok: false,
      value: {
        error: {
          code: "invalid_request",
          message: "the file is larger than read_file returns (1 MiB); read its bytes at rest_url",
          issues: [{ field: "path", reason: "too_large" }],
          rest_url: restUrl,
        },
      },
    });
    expect(bucket.count("get")).toBe(0);
    const bytes = await world.fetch(restUrl, { headers: { Authorization: `Bearer ${TOKENS.codex}` } });
    expect(bytes.status).toBe(200);
    expect((await bytes.arrayBuffer()).byteLength).toBe(1_048_577);
  });

  it.each<[string, string | Uint8Array, string | undefined, "utf8" | "base64"]>([
    ["page.html", "<p>é</p>", undefined, "utf8"],
    ["data.json", '{"a":1}', undefined, "utf8"],
    ["bom.txt", "﻿bom", undefined, "utf8"],
    ["latin1.txt", Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), undefined, "base64"],
    ["logo.png", PNG, undefined, "base64"],
    ["ascii.png", "plain ascii", undefined, "base64"],
    ["blob", "no extension", undefined, "base64"],
    ["typed", "text by type", "text/plain; charset=utf-8", "utf8"],
  ])("returns %s as %s, decoding to the stored bytes", async (path, body, type, encoding) => {
    const world = new World();
    const created = await world.created({
      title: "t",
      files: { "index.html": "x", [path]: type === undefined ? body : { body, type } },
    });
    const id = created.artifact.id;
    const outcome = await callTool(await mcpClient(world), "read_file", { id, version: 1, path });
    const stored = typeof body === "string" ? new TextEncoder().encode(body) : body;
    expect(outcome).toMatchObject({ ok: true, value: { encoding, size: stored.byteLength } });
    expect(decodeContent(stringAt(outcome.value, "content"), encoding)).toEqual(stored);
  });

  // RES-2: the object fetch and the read of its body each have the R2 timeout; the stream is cancelled.
  it("answers unavailable when the object or its body stalls, and cancels the body", async () => {
    const world = new World({ timeouts: { r2Ms: 50, d1ReadMs: 2_000, kvReadMs: 2_000 } });
    const id = await published(world, { "a.txt": "abc" });
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const client = await mcpClient(world);

    bucket.behave = (op) => (op === "get" ? never() : undefined);
    expect(await callTool(client, "read_file", { id, version: 1, path: "a.txt" })).toMatchObject({
      ok: false,
      value: { error: { code: "unavailable" } },
    });

    let cancelled = false;
    bucket.behave = (op) =>
      op === "get"
        ? Promise.resolve({
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("a"));
              },
              cancel() {
                cancelled = true;
              },
            }),
          })
        : undefined;
    expect(await callTool(client, "read_file", { id, version: 1, path: "a.txt" })).toMatchObject({
      ok: false,
      value: { error: { code: "unavailable" } },
    });
    expect(cancelled).toBe(true);
  });

  // RES-2: a get that answers after its timeout is not used, and the body it brings is cancelled.
  it("cancels the body of an object that arrives after the timeout", async () => {
    const world = new World({ timeouts: { r2Ms: 50, d1ReadMs: 2_000, kvReadMs: 2_000 } });
    const id = await published(world, { "a.txt": "abc" });
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const client = await mcpClient(world);
    const cancelled = Promise.withResolvers<void>();
    const late = new Promise((resolve) => {
      setTimeout(() => {
        resolve({ body: new ReadableStream<Uint8Array>({ cancel: () => cancelled.resolve() }) });
      }, 150);
    });
    bucket.behave = (op) => (op === "get" ? late : undefined);
    expect(await callTool(client, "read_file", { id, version: 1, path: "a.txt" })).toMatchObject({
      ok: false,
      value: { error: { code: "unavailable" } },
    });
    await late;
    const outcome = await Promise.race([
      cancelled.promise.then(() => "cancelled"),
      new Promise((resolve) => setTimeout(() => resolve("left open"), 500)),
    ]);
    expect(outcome).toBe("cancelled");
  });

  // Design.md section 8, "Errors": an R2 read that fails is unavailable, as one that stalls (above); an object the
  // version lists that R2 does not hold is internal.
  it.each<[string, string, () => Promise<unknown>, string]>([
    ["the get fails", "unavailable", () => Promise.reject(new Error("get failed")), "error"],
    [
      "the body's read fails",
      "unavailable",
      () => Promise.resolve({ body: new ReadableStream({ pull: (controller) => controller.error(new Error("cut")) }) }),
      "error",
    ],
    ["the get finds no object", "internal", () => Promise.resolve(null), "object_missing"],
  ])("answers %s with %s, and the file once the read succeeds", async (_label, code, behavior, reason) => {
    const world = new World();
    const id = await published(world, { "a.txt": "abc" });
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const client = await mcpClient(world);
    bucket.behave = (op) => (op === "get" ? behavior() : undefined);
    const logs = captureLogs();
    expect(await callTool(client, "read_file", { id, version: 1, path: "a.txt" })).toEqual({
      ok: false,
      value: { error: { code, message: expect.any(String) } },
    });
    expect(logEvents(logs.lines)).toEqual([{ event: "operation.failed", reason, error: "other", artifact: id }]);

    bucket.behave = () => undefined;
    expect(await callTool(client, "read_file", { id, version: 1, path: "a.txt" })).toMatchObject({
      ok: true,
      value: { path: "a.txt", size: 3, encoding: "utf8", content: "abc" },
    });
  });

  it("answers internal when the body holds other bytes than its stored size", async () => {
    const world = new World();
    const id = await published(world, { "a.txt": "abc" });
    const bucket = new BucketProbe();
    world.env = { ...world.env, FILES: bucket.binding };
    const client = await mcpClient(world);
    for (const delivered of ["ab", "abcd"]) {
      bucket.behave = (op) => (op === "get" ? Promise.resolve({ body: new Response(delivered).body }) : undefined);
      expect(await callTool(client, "read_file", { id, version: 1, path: "a.txt" })).toMatchObject({
        ok: false,
        value: { error: { code: "internal" } },
      });
    }
  });
});

describe("thrown errors in a tool", () => {
  it("answer internal and log the error class only, not the SDK's echo of the message", async () => {
    const deps = testDeps({
      newId: () => {
        throw new Error("SECRET-MESSAGE");
      },
    });
    const client = await mcpClient(atBoundary(deps));
    const logs = captureLogs();
    const outcome = await callTool(client, "create_artifact", { title: "t", files: [index()] });
    expect(outcome).toEqual({ ok: false, value: { error: { code: "internal", message: "internal error" } } });
    expect(logEvents(logs.lines)).toEqual([{ event: "request.failed", error: "Error", host: "api" }]);
    expect(logs.text()).not.toContain("SECRET-MESSAGE");
  });
});

/** What section 8 sets on an /mcp answer, and what it should be for that answer's type. */
const policyOf = (response: Response) => ({
  status: response.status,
  cache: response.headers.get("Cache-Control"),
  nosniff: response.headers.get("X-Content-Type-Options"),
});
const expected = (response: Response) => ({
  status: response.status,
  cache: response.headers.get("Content-Type")?.startsWith("text/event-stream") ? "no-store, no-transform" : "no-store",
  nosniff: "nosniff",
});

// Design.md section 8: every /mcp answer is the API's: never stored, never sniffed, streams kept untransformed.
describe("section 8: /mcp response headers", () => {
  it.each(MCP_VERSIONS)("sends no-store and nosniff on every answer to a %s client", async (version) => {
    const world = new World();
    const seen: Response[] = [];
    const recording: Fetcher = {
      fetch: async (request) => {
        const response = await world.fetch(request);
        seen.push(response.clone());
        return response;
      },
    };
    const client = await mcpClient(recording, { version });
    await client.listTools();
    expect((await callTool(client, "create_artifact", { title: "h", files: [index()] })).ok).toBe(true);
    await client.close();
    expect(seen.length).toBeGreaterThan(1);
    for (const response of seen) expect(policyOf(response)).toEqual(expected(response));
  });

  it("keeps no-transform on an event stream and sends the same on the SDK's and the Worker's own errors", async () => {
    const world = new World();
    const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const stream = await world.fetch(rpcRequest(list));
    expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
    expect(policyOf(stream)).toEqual({ status: 200, cache: "no-store, no-transform", nosniff: "nosniff" });
    const answers = [
      await world.fetch(rpcRequest(list, { headers: { Accept: "application/json" } })),
      await world.fetch(rpcRequest("{")),
      await world.fetch(rpcRequest(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))),
      await world.api("GET", "/mcp", { headers: { Accept: "text/event-stream" } }),
      await world.fetch(rpcRequest(list, { token: null })),
      await world.fetch(rpcRequest(list, { headers: { Origin: "https://evil.example.org" } })),
    ];
    expect(answers.map((response) => response.status)).toEqual([406, 400, 202, 405, 401, 403]);
    for (const response of answers) {
      expect(policyOf(response)).toEqual({ status: response.status, cache: "no-store", nosniff: "nosniff" });
    }
  });

  it("passes an event stream through as the SDK writes it", async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const streaming: McpHandlerFactory = (factory, options) => ({
      ...createMcpHandler(factory, options),
      fetch: async () =>
        new Response(readable, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
        }),
    });
    const response = await atBoundary(testDeps(), () => streaming).fetch(
      rpcRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })),
    );
    expect(policyOf(response)).toEqual({ status: 200, cache: "no-store, no-transform", nosniff: "nosniff" });
    const writer = writable.getWriter();
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const event = new TextEncoder().encode('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    void writer.write(event);
    // The first event is readable while the stream is still open.
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    expect(first?.value).toEqual(event);
    await writer.close();
    expect((await reader?.read())?.done).toBe(true);
  });
});
