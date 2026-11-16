/**
 * Helpers for the Worker's tests: a Worker built with a test clock, ID queue, key endpoint and short timeouts; requests
 * to each host class; Access JWTs from a local key; an MCP client of the SDK; and probes that wrap the D1 and R2
 * bindings to inject failures.
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { vi } from "vitest";

import { AccessVerifier } from "./access.ts";
import { isArtifactId, newArtifactId } from "./id.ts";
import { createWorker, type Worker } from "./index.ts";
import type { Timeouts } from "./timeout.ts";

export const TEAM = "team.example.com";
export const APP_AUD = "app-audience";
export const CONTENT_AUD = "content-audience";
export const APP_HOST = "artifacts.example.com";
export const API_HOST = "artifacts-api.example.com";
export const CONTENT_SUFFIX = "-art.example.com";
export const PUBLIC_SUFFIX = "-pub.example.com";
export const API = `https://${API_HOST}`;
export const START = Date.UTC(2026, 10, 16, 9, 0, 0);
export const DAY_MS = 86_400_000;

/** Tokens by name; `removed` has the form of a token but no entry in API_TOKENS. */
export const TOKENS = {
  codex: `art_${"c".repeat(32)}`,
  claude: `art_${"d".repeat(32)}`,
  removed: `art_${"r".repeat(32)}`,
} as const;

export async function sha256Text(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const API_TOKENS = JSON.stringify({
  codex: await sha256Text(TOKENS.codex),
  claude: await sha256Text(TOKENS.claude),
});

export type Vars = Partial<Env>;

export function testEnv(vars: Vars = {}): Env {
  return { ...env, API_TOKENS, ...vars };
}

const signing = await generateKeyPair("RS256", { extractable: true });
const other = await generateKeyPair("RS256", { extractable: true });
export const KEY_ID = "key-1";
export const publicJwk = async (key: CryptoKey, kid: string): Promise<JWK> => ({
  ...(await exportJWK(key)),
  kid,
  alg: "RS256",
  use: "sig",
});
const SIGNING_JWK = await publicJwk(signing.publicKey, KEY_ID);

/** The Access key endpoint of the test team: counts calls; can serve other keys, fail, or never answer. */
export class KeyEndpoint {
  calls = 0;
  /** The set's `keys`; anything, so a test can serve a malformed set. */
  keys: unknown[] = [SIGNING_JWK];
  mode: "ok" | "down" | "error_status" | "hang" = "ok";

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.calls++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response("unexpected", { status: 418 });
    switch (this.mode) {
      case "down":
        throw new TypeError("network connection lost");
      case "error_status":
        return new Response("", { status: 502 });
      case "hang":
        // Like fetch, it rejects when its signal aborts (jose's timeout).
        return new Promise((_, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      case "ok":
        return Response.json({ keys: this.keys });
      default:
        return this.mode satisfies never;
    }
  };
}

export type JwtOptions = {
  readonly aud?: string;
  readonly iss?: string;
  /** Seconds from the clock's now; null for no `exp`. */
  readonly expiresIn?: number | null;
  readonly kid?: string;
  readonly key?: "signing" | "other";
  readonly alg?: "RS256" | "RS384" | "PS256";
};

export class Clock {
  now = START;
}

/** A mutable world: the Worker under test, its clock, key endpoint, ID queue and environment. */
export class World {
  readonly clock = new Clock();
  readonly keys = new KeyEndpoint();
  /** IDs handed out before random ones, for ISO-1. */
  readonly ids: string[] = [];
  /** Waits the Worker asked for (R2 retries); they return at once. */
  readonly sleeps: number[] = [];
  env: Env;
  readonly worker: Worker;

  constructor(options: { vars?: Vars; timeouts?: Timeouts; keyTimeoutMs?: number } = {}) {
    this.env = testEnv(options.vars);
    const access = new AccessVerifier({
      fetch: this.keys.fetch,
      now: () => this.clock.now,
      cooldownMs: 0,
      ...(options.keyTimeoutMs === undefined ? {} : { keyTimeoutMs: options.keyTimeoutMs }),
    });
    this.worker = createWorker({
      now: () => this.clock.now,
      newId: () => {
        const id = this.ids.shift();
        return id !== undefined && isArtifactId(id) ? id : newArtifactId();
      },
      sleep: async (ms) => {
        this.sleeps.push(ms);
      },
      timeouts: options.timeouts ?? { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 2_000 },
      access,
    });
  }

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = typeof input === "string" ? new Request(input, init) : input;
    return this.worker.fetch(request, this.env, createExecutionContext());
  }

  async jwt(options: JwtOptions = {}): Promise<string> {
    const seconds = Math.floor(this.clock.now / 1000);
    const payload: JWTPayload = { sub: "owner", email: "owner@example.com", iat: seconds };
    if (options.expiresIn !== null) payload.exp = seconds + (options.expiresIn ?? 3600);
    const alg = options.alg ?? "RS256";
    const key =
      alg !== "RS256"
        ? (await generateKeyPair(alg)).privateKey
        : options.key === "other"
          ? other.privateKey
          : signing.privateKey;
    return new SignJWT(payload)
      .setProtectedHeader({ alg, kid: options.kid ?? KEY_ID })
      .setIssuer(options.iss ?? `https://${TEAM}`)
      .setAudience(options.aud ?? CONTENT_AUD)
      .sign(key);
  }

  /** An API request with a bearer token (`codex` by default; null for none). */
  async api(
    method: string,
    path: string,
    options: { token?: string | null; body?: BodyInit; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    const token = options.token === undefined ? TOKENS.codex : options.token;
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) init.body = options.body;
    return this.fetch(`${API}${path}`, init);
  }

  async create(input: PublishInput, token: string = TOKENS.codex): Promise<Response> {
    const { meta, form } = multipart(input);
    return this.api("POST", "/v1/artifacts", { token, body: form(meta) });
  }

  async update(
    id: string,
    input: PublishInput & { base_version: number; remove?: string[] },
    token: string = TOKENS.codex,
  ) {
    const { meta, form } = multipart(input);
    return this.api("POST", `/v1/artifacts/${id}/versions`, { token, body: form(meta) });
  }

  /** Creates an artifact and returns its JSON; fails the test when the create fails. */
  async created(input: PublishInput, token: string = TOKENS.codex): Promise<PublishJson> {
    const response = await this.create(input, token);
    if (response.status !== 201) throw new Error(`create answered ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async updated(id: string, input: PublishInput & { base_version: number; remove?: string[] }): Promise<PublishJson> {
    const response = await this.update(id, input);
    if (response.status !== 201) throw new Error(`update answered ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async patch(id: string, body: unknown, token: string = TOKENS.codex): Promise<Response> {
    return this.api("PATCH", `/v1/artifacts/${id}`, {
      token,
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  /** A request to the artifact's private content host, with a valid content JWT unless `jwt` is given. */
  async content(
    id: string,
    path: string,
    options: { jwt?: string | null; headers?: Record<string, string>; method?: string } = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    const jwt = options.jwt === undefined ? await this.jwt() : options.jwt;
    if (jwt !== null) headers.set("Cf-Access-Jwt-Assertion", jwt);
    return this.fetch(`https://${id}${CONTENT_SUFFIX}${path}`, { method: options.method ?? "GET", headers });
  }

  async public(id: string, path: string, options: { headers?: Record<string, string>; method?: string } = {}) {
    return this.fetch(`https://${id}${PUBLIC_SUFFIX}${path}`, {
      method: options.method ?? "GET",
      headers: new Headers(options.headers),
    });
  }
}

export type FileSpec = string | Uint8Array | { readonly body: string | Uint8Array; readonly type?: string };

export type PublishInput = {
  readonly title?: string;
  readonly description?: string;
  readonly files?: Readonly<Record<string, FileSpec>>;
  readonly [field: string]: unknown;
};

export type PublishJson = {
  artifact: { id: string; latest_version: number; [key: string]: unknown };
  version: {
    number: number;
    files: { path: string; sha256: string; size: number; content_type: string }[];
    [key: string]: unknown;
  };
};

const bytesOf = (body: string | Uint8Array): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

/** The multipart body of a publish: a `meta` part and one `file` part per file, in `meta.files` order. */
export function multipart(input: PublishInput): { meta: Record<string, unknown>; form: (meta: unknown) => FormData } {
  const { files, ...rest } = input;
  const entries = Object.entries(files ?? {});
  const meta: Record<string, unknown> = { ...rest };
  if (files !== undefined) {
    meta.files = entries.map(([path, spec]) =>
      typeof spec === "object" && "body" in spec && spec.type !== undefined
        ? { path, content_type: spec.type }
        : { path },
    );
  }
  return {
    meta,
    form: (value) => {
      const form = new FormData();
      form.append("meta", JSON.stringify(value));
      for (const [, spec] of entries) {
        const body = typeof spec === "object" && "body" in spec ? spec.body : spec;
        form.append("file", new Blob([bytesOf(body)]), "ignored-name.bin");
      }
      return form;
    },
  };
}

/** The MCP revisions `/mcp` serves (PL-27): the 2025-era ones through `initialize`, the modern one through discovery. */
export const MCP_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] as const;
export type McpVersion = (typeof MCP_VERSIONS)[number];
const MODERN: McpVersion = "2026-07-28";

/** What an MCP client needs of the Worker: a World, or a stand-in that calls the MCP adapter directly. */
export type Fetcher = { fetch(request: Request): Promise<Response> };

/** An SDK client connected to the Worker's `/mcp` with a bearer token (`codex` by default), speaking `version`. */
export async function mcpClient(
  world: Fetcher,
  options: { token?: string; version?: McpVersion; headers?: Record<string, string> } = {},
): Promise<Client> {
  const token = options.token ?? TOKENS.codex;
  const version = options.version ?? "2025-11-25";
  const transport = new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
      return world.fetch(new Request(input, { ...init, headers }));
    },
  });
  const client = new Client(
    { name: "artifacts-test", version: "0.0.0" },
    version === MODERN ? { versionNegotiation: { mode: { pin: MODERN } } } : { supportedProtocolVersions: [version] },
  );
  await client.connect(transport);
  return client;
}

/** A tool call's outcome: its structured content, or the object of an `isError` result. */
export type ToolOutcome = { ok: boolean; value: unknown };

export function toolOutcome(result: CallToolResult): ToolOutcome {
  const [first] = result.content;
  const text = first?.type === "text" ? first.text : "";
  if (result.isError === true) {
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // A refusal the SDK formed is plain text.
    }
    return { ok: false, value };
  }
  return { ok: true, value: result.structuredContent };
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  return toolOutcome(await client.callTool({ name, arguments: args }));
}

/** The keys under an artifact's prefix in the real bucket. */
export async function objectKeys(id: string): Promise<string[]> {
  const listed = await env.FILES.list({ prefix: `a/${id}/` });
  return listed.objects.map((object) => object.key).toSorted();
}

/** Every row of the three tables, for before/after comparisons. */
export async function snapshot(): Promise<{
  artifacts: unknown[];
  versions: unknown[];
  files: unknown[];
  objects: string[];
}> {
  const [artifacts, versions, files] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM artifacts ORDER BY id"),
    env.DB.prepare("SELECT * FROM versions ORDER BY artifact_id, number"),
    env.DB.prepare("SELECT * FROM version_files ORDER BY artifact_id, number, path"),
  ]);
  const objects = (await env.FILES.list()).objects.map((object) => object.key).toSorted();
  return {
    artifacts: artifacts?.results ?? [],
    versions: versions?.results ?? [],
    files: files?.results ?? [],
    objects,
  };
}

/** Removes every row and object; storage is shared by the tests of one file. */
export async function clearStorage(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM version_files"),
    env.DB.prepare("DELETE FROM versions"),
    env.DB.prepare("DELETE FROM artifacts"),
  ]);
  for (;;) {
    const listed = await env.FILES.list();
    if (listed.objects.length === 0) return;
    await env.FILES.delete(listed.objects.map((object) => object.key));
  }
}

/** Empties `OAUTH_KV`, which the tests share like D1 and R2. */
export async function clearOAuthStorage(): Promise<void> {
  const kv = env.OAUTH_KV;
  if (kv === undefined) return;
  for (;;) {
    const listed = await kv.list();
    if (listed.keys.length === 0) return;
    await Promise.all(listed.keys.map((key) => kv.delete(key.name)));
  }
}

/** A promise with its resolver, for holding a call until the test releases it. */
export function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

export type BucketOp = "head" | "put" | "get" | "list" | "delete";

/**
 * Wraps the real bucket: records calls, and lets a test replace one call (by operation and its count) with its own
 * behavior. `behave` returns undefined to let the real call through.
 */
export class BucketProbe {
  readonly calls: { op: BucketOp; key: string }[] = [];
  behave: (op: BucketOp, key: string, count: number) => Promise<unknown> | undefined = () => undefined;

  readonly binding: R2Bucket;

  constructor(base: R2Bucket = env.FILES) {
    const counts = new Map<BucketOp, number>();
    const run = (op: BucketOp, key: string, real: () => Promise<unknown>) => {
      const count = (counts.get(op) ?? 0) + 1;
      counts.set(op, count);
      this.calls.push({ op, key });
      return this.behave(op, key, count) ?? real();
    };
    // Each wrapped method calls the binding's own, so the binding sees itself as `this`.
    this.binding = new Proxy(base, {
      get: (target, property) => {
        switch (property) {
          case "head":
            return (key: string) => run("head", key, () => target.head(key));
          case "get":
            return (key: string) => run("get", key, () => target.get(key));
          case "put":
            return (key: string, value: Blob, options?: R2PutOptions) =>
              run("put", key, () => target.put(key, value, options));
          case "list":
            return (options?: R2ListOptions) => run("list", options?.prefix ?? "", () => target.list(options));
          case "delete":
            return (keys: string | string[]) =>
              run("delete", Array.isArray(keys) ? keys.join(",") : keys, () => target.delete(keys));
          default:
            return undefined;
        }
      },
    });
  }

  count(op: BucketOp): number {
    return this.calls.filter((call) => call.op === op).length;
  }
}

/** An R2 error as the binding throws it: its code in a `code` property, at the end of the message, or both. */
export function r2Error(code: number, carrier: "both" | "property" | "message" = "both"): Error {
  const message = carrier === "property" ? "put: We encountered an error." : `put: We encountered an error. (${code})`;
  return carrier === "message" ? new Error(message) : Object.assign(new Error(message), { code });
}

/** Never settles: a call that hangs until the timeout. */
export const never = (): Promise<never> => new Promise(() => {});

/**
 * Wraps the real database so that batches can be held, delayed or extended with a failing statement (which makes D1
 * roll the whole batch back).
 */
export class DatabaseProbe {
  batches = 0;
  behave: (index: number, statements: D1PreparedStatement[]) => Promise<D1Result[]> | undefined = () => undefined;
  readonly binding: D1Database;

  constructor(base: D1Database = env.DB) {
    this.binding = new Proxy(base, {
      get: (target, property) => {
        switch (property) {
          case "prepare":
            return (query: string) => target.prepare(query);
          case "batch":
            return (statements: D1PreparedStatement[]) => {
              this.batches++;
              return this.behave(this.batches, statements) ?? target.batch(statements);
            };
          default:
            return undefined;
        }
      },
    });
  }

  /** The batch with `statements` plus a statement that fails, so D1 rolls all of it back. */
  static failing(base: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
    return base.batch([...statements, base.prepare("SELECT * FROM no_such_table")]);
  }
}

/** Captures every console method, for DATA-1 log redaction. */
export function captureLogs(): { lines: string[]; text: () => string } {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(
        JSON.stringify(args, (_key, value: unknown) =>
          value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
        ),
      );
    });
  }
  return { lines, text: () => lines.join("\n") };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at `path` in a JSON value, or undefined when the path does not exist. */
export function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === "number" && Array.isArray(current)) current = current[key];
    else if (typeof key === "string" && isRecord(current)) current = current[key];
    else return undefined;
  }
  return current;
}

/** The string at `path`; fails the test when there is none. */
export function stringAt(value: unknown, ...path: (string | number)[]): string {
  const found = at(value, ...path);
  if (typeof found !== "string") throw new Error(`no string at ${path.join(".")}`);
  return found;
}

/** The parsed log lines (each the JSON object logEvent wrote). */
export function logEvents(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => {
    const args: unknown = JSON.parse(line);
    const event: unknown = Array.isArray(args) ? JSON.parse(String(args[0])) : undefined;
    if (!isRecord(event)) throw new Error("a log line is not a logEvent object");
    return event;
  });
}
