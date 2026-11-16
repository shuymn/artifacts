/**
 * A local stand-in for the API host's OAuth side and the REST routes `login`, `logout` and a refresh use: both metadata
 * documents, DCR, the token endpoint (code exchange with PKCE, refresh with rotation), `GET /v1/artifacts` and
 * `/v1/grants`. `approve` plays the owner's browser on the consent page, then calls the CLI's callback. Each test may
 * replace any answer through `override`, and the store's file is set up and read through `credentials`.
 */
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { afterEach } from "vitest";

import { tempDir } from "./test-support.ts";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

export type Answer = { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> };

export type Seen = {
  readonly method: string;
  readonly path: string;
  readonly form: Record<string, string>;
  readonly authorization?: string;
};

type Grant = {
  readonly id: string;
  readonly client: string;
  readonly redirect: string;
  readonly challenge: string;
  readonly created: string;
};

/** A JSON object's fields as text, as the stand-in records them. */
function jsonFields(text: string): Record<string, string> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).map(([name, field]) => [name, String(field)]));
}

const oauthError = (status: number, code: string): Answer => ({ status, body: { error: code } });

const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export class StandIn {
  readonly origin: string;
  /** Every request, in order, with its form or JSON fields. */
  readonly seen: Seen[] = [];
  readonly clients = new Set<string>();
  readonly grants = new Map<string, Grant>();
  /** Access tokens by value: their grant and expiry (ms). */
  readonly access = new Map<string, { grant: string; expires: number }>();
  readonly refreshTokens = new Map<string, string>();
  readonly codes = new Map<string, string>();
  /** The `expires_in` of the next tokens. */
  expiresIn = 3600;
  /** Replaces the answer to a request when it returns one; may wait first. */
  override: (seen: Seen) => Promise<Answer | undefined> | Answer | undefined = () => undefined;
  /** Every callback the browser was sent to, with the CLI's answer. */
  readonly callbacks: Promise<{ status: number; text: string }>[] = [];

  private constructor(origin: string) {
    this.origin = origin;
  }

  static async start(): Promise<StandIn> {
    let standIn: StandIn | undefined;
    const server = createServer((request, response) => {
      void standIn?.handle(request, response);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the stand-in has no port");
    standIn = new StandIn(`http://127.0.0.1:${address.port}`);
    return standIn;
  }

  /** Requests as `METHOD path`, optionally with `grant_type` for the token endpoint. */
  get requests(): string[] {
    return this.seen.map(({ method, path, form }) =>
      form.grant_type === undefined ? `${method} ${path}` : `${method} ${path} ${form.grant_type}`,
    );
  }

  count(line: string): number {
    return this.requests.filter((request) => request === line).length;
  }

  /** A grant, client and tokens as a finished `login` leaves them. */
  issue(client = this.register()): { client: string; grant: string; tokens: Tokens } {
    const grant = random(12);
    this.grants.set(grant, { id: grant, client, redirect: "", challenge: "", created: new Date().toISOString() });
    return { client, grant, tokens: this.tokens(grant) };
  }

  register(): string {
    const client = random(12);
    this.clients.add(client);
    return client;
  }

  tokens(grant: string): Tokens {
    const access = `owner:${grant}:${random(24)}`;
    const refresh = `owner:${grant}:${random(24)}`;
    this.access.set(access, { grant, expires: Date.now() + this.expiresIn * 1000 });
    this.refreshTokens.set(refresh, grant);
    return { access_token: access, token_type: "bearer", expires_in: this.expiresIn, refresh_token: refresh };
  }

  /**
   * The owner's browser: opens the authorization URL, allows the request, and follows the redirect to the CLI's
   * callback with `code`, `state` and `iss`; `query` replaces any of them (null removes one).
   */
  approve(authorizationUrl: string, query: Record<string, string | null> = {}): void {
    const url = new URL(authorizationUrl);
    const params = url.searchParams;
    const grant = random(12);
    this.grants.set(grant, {
      id: grant,
      client: params.get("client_id") ?? "",
      redirect: params.get("redirect_uri") ?? "",
      challenge: params.get("code_challenge") ?? "",
      created: new Date().toISOString(),
    });
    const code = `owner:${grant}:${random(24)}`;
    this.codes.set(code, grant);
    const callback = new URL(params.get("redirect_uri") ?? "");
    const sent: Record<string, string | null> = { code, state: params.get("state"), iss: this.origin, ...query };
    for (const [name, value] of Object.entries(sent)) if (value !== null) callback.searchParams.set(name, value);
    this.callbacks.push(
      fetch(callback).then(async (response) => ({ status: response.status, text: await response.text() })),
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    const text = await bodyOf(request);
    const form: Record<string, string> =
      request.headers["content-type"]?.startsWith("application/json") === true
        ? jsonFields(text)
        : Object.fromEntries(new URLSearchParams(text));
    const seen: Seen = {
      method: request.method ?? "GET",
      path: url.pathname,
      form,
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
    };
    this.seen.push(seen);
    const answer = (await this.override(seen)) ?? this.answer(seen, request.headers.authorization);
    response.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
    response.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
  }

  private bearer(authorization: string | undefined): string | undefined {
    const token = authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : "";
    const found = this.access.get(token);
    return found !== undefined && found.expires > Date.now() && this.grants.has(found.grant) ? found.grant : undefined;
  }

  private answer({ method, path, form }: Seen, authorization: string | undefined): Answer {
    const route = `${method} ${path}`;
    if (route === "GET /.well-known/oauth-protected-resource/v1") {
      return { status: 200, body: { resource: `${this.origin}/v1`, authorization_servers: [this.origin] } };
    }
    if (route === "GET /.well-known/oauth-authorization-server") {
      return {
        status: 200,
        body: {
          issuer: this.origin,
          authorization_endpoint: `${this.origin}/oauth/authorize`,
          token_endpoint: `${this.origin}/oauth/token`,
          registration_endpoint: `${this.origin}/oauth/register`,
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        },
      };
    }
    if (route === "POST /oauth/register") {
      return { status: 201, body: { client_id: this.register(), redirect_uris: [form.redirect_uris] } };
    }
    if (route === "POST /oauth/token") {
      if (!this.clients.has(form.client_id ?? "")) return oauthError(401, "invalid_client");
      if (form.grant_type === "authorization_code") {
        const grant = this.grants.get(this.codes.get(form.code ?? "") ?? "");
        if (grant === undefined || grant.client !== form.client_id) return oauthError(400, "invalid_grant");
        if (grant.redirect !== form.redirect_uri || grant.challenge !== s256(form.code_verifier ?? "")) {
          return oauthError(400, "invalid_grant");
        }
        this.codes.delete(form.code ?? "");
        return { status: 200, body: this.tokens(grant.id) };
      }
      if (form.grant_type === "refresh_token") {
        const grant = this.refreshTokens.get(form.refresh_token ?? "");
        if (grant === undefined || !this.grants.has(grant)) return oauthError(400, "invalid_grant");
        this.refreshTokens.delete(form.refresh_token ?? "");
        return { status: 200, body: this.tokens(grant) };
      }
      return oauthError(400, "unsupported_grant_type");
    }
    const grant = this.bearer(authorization);
    if (path.startsWith("/v1/") && grant === undefined) {
      return { status: 401, body: { error: { code: "unauthorized", message: "a valid bearer token is required" } } };
    }
    if (route === "GET /v1/artifacts") return { status: 200, body: { artifacts: [], next_cursor: null } };
    if (route === "GET /v1/grants") {
      // Newest first, as the Worker answers; the stand-in keeps no consent metadata.
      const grants = [...this.grants.values()].toReversed().map((listed) => ({
        id: listed.id,
        publisher: null,
        client_id: listed.client,
        client_name: null,
        redirect_host: listed.redirect === "" ? null : new URL(listed.redirect).hostname,
        resource: `${this.origin}/v1`,
        created_at: listed.created,
        expires_at: null,
      }));
      return { status: 200, body: { grants } };
    }
    if (method === "DELETE" && path.startsWith("/v1/grants/")) {
      const id = decodeURIComponent(path.slice("/v1/grants/".length));
      if (!this.grants.delete(id)) return { status: 404, body: { error: { code: "not_found", message: "no grant" } } };
      return { status: 204 };
    }
    return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
  }
}

export type Tokens = { access_token: string; token_type: string; expires_in: number; refresh_token: string };

/** A stored login file in a new configuration directory. */
export class Credentials {
  readonly home: string;
  readonly directory: string;
  readonly file: string;

  private constructor(home: string) {
    this.home = home;
    this.directory = join(home, "artifacts");
    this.file = join(this.directory, "credentials.json");
  }

  /** In a new directory, removed after the test. */
  static async create(): Promise<Credentials> {
    return new Credentials(await tempDir());
  }

  /** In `home`, which the caller removes. */
  static at(home: string): Credentials {
    return new Credentials(home);
  }

  /** The environment that points the CLI at `standIn` with this directory and no token. */
  env(standIn: StandIn): Record<string, string> {
    return { ARTIFACTS_API_URL: standIn.origin, XDG_CONFIG_HOME: this.home };
  }

  /** Stores `entry` for `origin`, as a login would, with the access token expiring at `expires` (ms). */
  async put(
    origin: string,
    entry: { client: string; tokens: { access_token: string; refresh_token: string } | null; expires?: number },
    mode = { directory: 0o700, file: 0o600 },
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: mode.directory });
    const tokens =
      entry.tokens === null
        ? null
        : {
            access_token: entry.tokens.access_token,
            refresh_token: entry.tokens.refresh_token,
            expires_at: new Date(entry.expires ?? Date.now() + 3_600_000).toISOString(),
          };
    const body = { logins: { [origin]: { client_id: entry.client, tokens } } };
    await writeFile(this.file, JSON.stringify(body), { mode: mode.file });
  }

  /** Every stored entry; none before the file exists. */
  async read(): Promise<Record<string, { client_id: string; tokens: null | Record<string, string> }>> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
    const parsed: { logins: Record<string, { client_id: string; tokens: null | Record<string, string> }> } =
      JSON.parse(text);
    return parsed.logins;
  }

  /** Moves the stored access token's expiry of `origin` to now, so the next command refreshes it first. */
  async expire(origin: string): Promise<void> {
    const parsed: { logins: Record<string, { tokens: { expires_at: string } | null }> } = JSON.parse(
      await readFile(this.file, "utf8"),
    );
    const login = parsed.logins[origin];
    if (login?.tokens === null || login === undefined) throw new Error("no stored login to expire");
    login.tokens.expires_at = new Date().toISOString();
    await writeFile(this.file, JSON.stringify(parsed));
  }

  /** The tokens stored now, for every origin. */
  async storedTokens(): Promise<string[]> {
    return Object.values(await this.read()).flatMap(({ tokens }) =>
      tokens === null ? [] : [tokens.access_token ?? "", tokens.refresh_token ?? ""],
    );
  }

  async modes(): Promise<{ directory: number; file: number }> {
    return {
      directory: (await stat(this.directory)).mode & 0o777,
      file: (await stat(this.file)).mode & 0o777,
    };
  }
}

/** A promise and the function that settles it: a barrier a test opens. */
export function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Whether `path` exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolves once `condition` holds, looking every 10 ms for at most `ms`. */
export async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("the condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
