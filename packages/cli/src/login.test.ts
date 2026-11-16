// PL-49 and PL-51: `login`, `logout`, the stored login and the credential precedence, against a local stand-in for the
// API host's OAuth side (login-test-support.ts) with the browser step played by the test. The CLI against the Worker
// itself is e2e.test.ts; the lock and the refresh races are lock.test.ts.
import { chmod, readFile, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { Fetch } from "./api.ts";
import { helpText } from "./cli.ts";
import { Credentials, StandIn, until, type Answer } from "./login-test-support.ts";
import { cli, TOKEN, type RunOptions } from "./test-support.ts";

const fetch: Fetch = (input, init) => globalThis.fetch(input, init);

async function setup() {
  const standIn = await StandIn.start();
  const credentials = await Credentials.create();
  return { standIn, credentials, env: credentials.env(standIn) };
}

/** `login`, with the browser allowing what the CLI asks unless `browser` plays it otherwise. */
function login(standIn: StandIn, env: Record<string, string>, options: RunOptions = {}) {
  return cli(["login"], { env, fetch, openBrowser: (url) => standIn.approve(url), ...options });
}

/** The loopback port of the callback in the authorization URL `login` printed. */
function callbackPort(stderr: string): number {
  const url = stderr.split("\n").find((line) => line.includes("/oauth/authorize?"));
  return Number(new URL(new URL(url ?? "").searchParams.get("redirect_uri") ?? "").port);
}

async function refused(port: number): Promise<boolean> {
  try {
    await globalThis.fetch(`http://127.0.0.1:${port}/callback`, { signal: AbortSignal.timeout(2000) });
    return false;
  } catch {
    return true;
  }
}

const redirectTo = (location: string): Answer => ({ status: 302, headers: { Location: location } });

describe("PL-49: login", () => {
  it("registers through DCR, signs in with PKCE S256 for /v1, and stores the tokens in a 0600 file", async () => {
    const { standIn, credentials, env } = await setup();
    const ran = await login(standIn, env);
    expect(ran).toMatchObject({ status: 0, stdout: `signed in to ${standIn.origin}\n` });
    expect(standIn.requests).toEqual([
      "GET /.well-known/oauth-protected-resource/v1",
      "GET /.well-known/oauth-authorization-server",
      "POST /oauth/register",
      "POST /oauth/token authorization_code",
    ]);
    expect(standIn.seen[2]?.form).toMatchObject({
      client_name: "artifacts CLI",
      redirect_uris: "http://127.0.0.1/callback",
      token_endpoint_auth_method: "none",
    });
    const printed = ran.stderr.split("\n").find((line) => line.startsWith(`${standIn.origin}/oauth/authorize?`));
    const query = Object.fromEntries(new URL(printed ?? "").searchParams);
    expect(query).toMatchObject({
      response_type: "code",
      code_challenge_method: "S256",
      resource: `${standIn.origin}/v1`,
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:[0-9]+\/callback$/),
    });
    expect(await standIn.callbacks[0]).toEqual({
      status: 200,
      text: "Signed in to artifacts. Return to the terminal.\n",
    });
    const stored = (await credentials.read())[standIn.origin];
    expect(stored?.client_id).toBe(query.client_id);
    expect(standIn.access.has(stored?.tokens?.access_token ?? "")).toBe(true);
    expect(await credentials.modes()).toEqual({ directory: 0o700, file: 0o600 });
    // The command uses the stored login.
    expect(await cli(["list"], { env, fetch })).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("creates the directory 0700 and the file 0600 under a umask that would narrow them", async () => {
    const { standIn, credentials, env } = await setup();
    // Without the owner's write bit, mkdir's and open's modes alone would leave 0500 and 0400.
    const previous = process.umask(0o277);
    try {
      expect((await login(standIn, env)).status).toBe(0);
    } finally {
      process.umask(previous);
    }
    expect(await credentials.modes()).toEqual({ directory: 0o700, file: 0o600 });
  });

  it.each<[string, (origin: string) => Record<string, unknown>]>([
    ["another resource", (origin) => ({ resource: `${origin}/mcp`, authorization_servers: [origin] })],
    ["another authorization server", () => ({ authorization_servers: ["https://as.example.com"] })],
    ["two authorization servers", (origin) => ({ authorization_servers: [origin, "https://as.example.com"] })],
  ])("refuses protected resource metadata naming %s, before registering", async (_name, body) => {
    const { standIn, credentials, env } = await setup();
    standIn.override = ({ path }) =>
      path === "/.well-known/oauth-protected-resource/v1"
        ? { status: 200, body: { resource: `${standIn.origin}/v1`, ...body(standIn.origin) } }
        : undefined;
    const ran = await login(standIn, env);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("protected resource metadata");
    expect(standIn.requests).toEqual(["GET /.well-known/oauth-protected-resource/v1"]);
    expect(await credentials.read()).toEqual({});
  });

  it("refuses authorization server metadata naming another issuer, before registering", async () => {
    const { standIn, env } = await setup();
    standIn.override = ({ path }) =>
      path === "/.well-known/oauth-authorization-server"
        ? { status: 200, body: { issuer: "https://as.example.com", token_endpoint: `${standIn.origin}/oauth/token` } }
        : undefined;
    const ran = await login(standIn, env);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('"issuer" property does not match the expected value');
    expect(standIn.requests).not.toContain("POST /oauth/register");
  });

  it.each(["token_endpoint", "registration_endpoint"])(
    "refuses metadata with the right issuer and its %s on another origin, sending it nothing",
    async (endpoint) => {
      const { standIn, env } = await setup();
      const other = await StandIn.start();
      const metadata = {
        issuer: standIn.origin,
        authorization_endpoint: `${standIn.origin}/oauth/authorize`,
        token_endpoint: `${standIn.origin}/oauth/token`,
        registration_endpoint: `${standIn.origin}/oauth/register`,
        [endpoint]: `${other.origin}/oauth/${endpoint}`,
      };
      standIn.override = ({ path }) =>
        path === "/.well-known/oauth-authorization-server" ? { status: 200, body: metadata } : undefined;
      const ran = await login(standIn, env);
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain(`puts its ${endpoint} outside ${standIn.origin}`);
      expect(other.seen).toEqual([]);
      expect(standIn.requests).not.toContain("POST /oauth/register");
    },
  );

  it.each([
    "/.well-known/oauth-protected-resource/v1",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/token",
  ])("fails on a redirect from %s without following it", async (redirected) => {
    const { standIn, credentials, env } = await setup();
    const other = await StandIn.start();
    standIn.override = ({ path }) => (path === redirected ? redirectTo(`${other.origin}${path}`) : undefined);
    const ran = await login(standIn, env);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(`${standIn.origin}${redirected} answered with a redirect`);
    expect(other.seen).toEqual([]);
    expect(standIn.requests.filter((line) => line.startsWith(`POST ${redirected}`)).length).toBeLessThanOrEqual(1);
    expect(await credentials.read()).toEqual({});
  });

  it.each<[string, Record<string, string | null>, string]>([
    ["a wrong state", { state: "another-state" }, 'unexpected "state" response parameter value'],
    ["no state", { state: null }, 'response parameter "state" missing'],
    ["a wrong iss", { iss: "https://as.example.com" }, 'unexpected "iss" (issuer) response parameter value'],
    ["no iss", { iss: null }, 'response parameter "iss" (issuer) missing'],
    ["an error", { error: "access_denied", code: null }, "the sign-in was not completed (access_denied)"],
  ])("refuses a callback with %s, exchanges nothing and closes the listener", async (_name, query, message) => {
    const { standIn, credentials, env } = await setup();
    const ran = await login(standIn, env, { openBrowser: (url) => standIn.approve(url, query) });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(message);
    expect(standIn.requests).not.toContain("POST /oauth/token authorization_code");
    expect(await standIn.callbacks[0]).toEqual({
      status: 400,
      text: "The sign-in did not complete. Return to the terminal to see why.\n",
    });
    expect((await credentials.read())[standIn.origin]).toBeUndefined();
    expect(await refused(callbackPort(ran.stderr))).toBe(true);
  });

  it("accepts metadata without iss support and still requires iss on the callback", async () => {
    const { standIn, env } = await setup();
    const base = { status: 200 } as const;
    standIn.override = ({ path }) =>
      path === "/.well-known/oauth-authorization-server"
        ? {
            ...base,
            body: {
              issuer: standIn.origin,
              authorization_endpoint: `${standIn.origin}/oauth/authorize`,
              token_endpoint: `${standIn.origin}/oauth/token`,
              registration_endpoint: `${standIn.origin}/oauth/register`,
            },
          }
        : undefined;
    const ran = await login(standIn, env, { openBrowser: (url) => standIn.approve(url, { iss: null }) });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('response parameter "iss" (issuer) missing');
  });

  it("closes the listener after 5 minutes without a callback (scaled), storing nothing", async () => {
    const { standIn, credentials, env } = await setup();
    const ran = await login(standIn, env, { openBrowser: () => undefined, signIn: { callbackMs: 200 } });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("no sign-in arrived within 0 s");
    expect(await refused(callbackPort(ran.stderr))).toBe(true);
    expect((await credentials.read())[standIn.origin]).toBeUndefined();
  });

  it("accepts one callback: a second one, while the first is exchanged, finds the listener closed", async () => {
    const { standIn, credentials, env } = await setup();
    let port = 0;
    let second: boolean | undefined;
    standIn.override = async ({ form }) => {
      // The code exchange of the first callback waits until a second callback has been tried.
      if (form.grant_type === "authorization_code" && standIn.codes.has(form.code ?? "")) second = await refused(port);
      return undefined;
    };
    const ran = await login(standIn, env, {
      openBrowser: (url) => {
        port = Number(new URL(new URL(url).searchParams.get("redirect_uri") ?? "").port);
        standIn.approve(url);
      },
    });
    expect(ran.status).toBe(0);
    expect(second).toBe(true);
    expect((await credentials.read())[standIn.origin]?.tokens).not.toBeNull();
  });

  it("answers 404 to other paths while it waits, and takes the callback after them", async () => {
    const { standIn, env } = await setup();
    let other: Promise<number> | undefined;
    const ran = await login(standIn, env, {
      openBrowser: (url) => {
        const port = new URL(new URL(url).searchParams.get("redirect_uri") ?? "").port;
        other = globalThis.fetch(`http://127.0.0.1:${port}/favicon.ico`).then((response) => response.status);
        void other.then(() => standIn.approve(url));
      },
    });
    expect(ran.status).toBe(0);
    expect(await other).toBe(404);
  });

  it("refuses a stored login file that another user can read, naming it", async () => {
    const { standIn, credentials, env } = await setup();
    const { client, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens }, { directory: 0o700, file: 0o640 });
    for (const argv of [["list"], ["login"], ["logout"]]) {
      const ran = await cli(argv, { env, fetch, openBrowser: (url) => standIn.approve(url) });
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain(`${credentials.file} can be read or written by another user`);
    }
    expect(standIn.requests.filter((line) => !line.startsWith("GET /.well-known"))).toEqual([]);
  });

  it("refuses a stored login directory that another user can read, naming it", async () => {
    const { standIn, credentials, env } = await setup();
    const { client, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens });
    await chmod(credentials.directory, 0o755);
    const ran = await cli(["list"], { env, fetch });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(`${credentials.directory} can be read or written by another user`);
    expect(standIn.seen).toEqual([]);
  });

  it("on Windows refuses login and logout naming ARTIFACTS_TOKEN, and never reads a stored login", async () => {
    const { standIn, credentials, env } = await setup();
    await credentials.put(standIn.origin, { client: "c", tokens: standIn.issue().tokens });
    await writeFile(credentials.file, "not a stored login", { mode: 0o644 });
    for (const command of ["login", "logout"]) {
      const ran = await cli([command], { env, fetch, platform: "win32" });
      expect(ran).toEqual({
        status: 1,
        stdout: "",
        stderr:
          `artifacts: ${command} is not offered on Windows, which cannot keep a stored login private; ` +
          "set ARTIFACTS_TOKEN to an API token instead\n",
      });
    }
    expect(await cli(["list"], { env, fetch, platform: "win32" })).toEqual({
      status: 1,
      stdout: "",
      stderr: "artifacts: set ARTIFACTS_TOKEN to an API token\n",
    });
    const withToken = await cli(["list"], { env: { ...env, ARTIFACTS_TOKEN: TOKEN }, fetch, platform: "win32" });
    expect(withToken.stderr).toContain("(check ARTIFACTS_TOKEN)\n");
    expect(standIn.seen.map(({ path }) => path)).toEqual(["/v1/artifacts"]);
    expect(helpText("win32")).not.toMatch(/ log(in|out) /);
    expect(helpText("linux")).toMatch(/\n {2}login {3}.*\n {2}logout {3}/s);
  });

  it("names login when no credential is set and none is stored", async () => {
    const { standIn, env } = await setup();
    expect(await cli(["list"], { env, fetch })).toEqual({
      status: 1,
      stdout: "",
      stderr: `artifacts: set ARTIFACTS_TOKEN to an API token, or sign in with artifacts login (no stored login for ${standIn.origin})\n`,
    });
  });
});

describe("login: the stored client ID", () => {
  it("keeps a client the server knows: the made-up code is answered invalid_grant", async () => {
    const { standIn, credentials, env } = await setup();
    const client = standIn.register();
    await credentials.put(standIn.origin, { client, tokens: null });
    expect((await login(standIn, env)).status).toBe(0);
    const probe = standIn.seen.find(({ form }) => form.grant_type === "authorization_code");
    expect(probe?.form).toMatchObject({
      client_id: client,
      code: expect.stringMatching(/^owner:[\w-]{16}:[\w-]{32}$/),
    });
    expect(standIn.requests).not.toContain("POST /oauth/register");
    expect((await credentials.read())[standIn.origin]?.client_id).toBe(client);
  });

  it("registers again when the server answers invalid_client for the stored one", async () => {
    const { standIn, credentials, env } = await setup();
    await credentials.put(standIn.origin, { client: "forgotten-client", tokens: null });
    expect((await login(standIn, env)).status).toBe(0);
    expect(standIn.requests.slice(2, 4)).toEqual(["POST /oauth/token authorization_code", "POST /oauth/register"]);
    const kept = (await credentials.read())[standIn.origin]?.client_id;
    expect(kept).not.toBe("forgotten-client");
    expect(standIn.clients.has(kept ?? "")).toBe(true);
  });

  it("fails, keeping the client ID, when the check gets another answer", async () => {
    const { standIn, credentials, env } = await setup();
    const client = standIn.register();
    await credentials.put(standIn.origin, { client, tokens: null });
    standIn.override = ({ path }) => (path === "/oauth/token" ? { status: 503, body: {} } : undefined);
    let opened = false;
    const ran = await login(standIn, env, { openBrowser: () => (opened = true) });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("the check of the stored client ID");
    expect(opened).toBe(false);
    expect(standIn.requests).not.toContain("POST /oauth/register");
    expect((await credentials.read())[standIn.origin]?.client_id).toBe(client);
  });

  it("drops the client ID when the code exchange answers invalid_client", async () => {
    const { standIn, credentials, env } = await setup();
    const client = standIn.register();
    await credentials.put(standIn.origin, { client, tokens: null });
    standIn.override = ({ form }) =>
      form.grant_type === "authorization_code" && standIn.codes.has(form.code ?? "")
        ? { status: 401, body: { error: "invalid_client" } }
        : undefined;
    const ran = await login(standIn, env);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("the code exchange was refused (401 invalid_client)");
    expect((await credentials.read())[standIn.origin]).toBeUndefined();
  });

  it("drops the client ID when a refresh answers invalid_client", async () => {
    const { standIn, credentials, env } = await setup();
    const { client, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens, expires: Date.now() });
    standIn.clients.delete(client);
    const ran = await cli(["list"], { env, fetch });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("the server no longer knows this CLI's client; sign in with artifacts login");
    expect((await credentials.read())[standIn.origin]).toBeUndefined();
  });
});

describe("PL-51: the credential precedence", () => {
  it("uses ARTIFACTS_TOKEN when it is set, without reading the stored login", async () => {
    const { standIn, credentials, env } = await setup();
    const { client, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens });
    // A file the CLI would refuse if it read it.
    await chmod(credentials.file, 0o644);
    const authorizations: (string | null)[] = [];
    const recording: Fetch = (input, init) => {
      authorizations.push(new Headers(init.headers).get("Authorization"));
      return fetch(input, init);
    };
    const ran = await cli(["list"], { env: { ...env, ARTIFACTS_TOKEN: TOKEN }, fetch: recording });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toBe(
      "artifacts: unauthorized: a valid bearer token is required " +
        "(check ARTIFACTS_TOKEN, or sign in again with artifacts login)\n",
    );
    expect(authorizations).toEqual([`Bearer ${TOKEN}`]);
    expect(standIn.requests).toEqual(["GET /v1/artifacts"]);
  });

  it("login with ARTIFACTS_TOKEN set stores the login and says the token still wins", async () => {
    const { standIn, env } = await setup();
    const ran = await login(standIn, { ...env, ARTIFACTS_TOKEN: TOKEN });
    expect(ran.status).toBe(0);
    expect(ran.stderr).toContain("ARTIFACTS_TOKEN is set, so commands use it instead of this login");
  });
});

describe("PL-51: logout", () => {
  it("revokes the grant its token names with that token, sends nothing after it, and keeps the client ID", async () => {
    const { standIn, credentials, env } = await setup();
    const { client, grant, tokens } = standIn.issue();
    // An earlier login of the same client left another live grant.
    const earlier = standIn.issue(client);
    await credentials.put(standIn.origin, { client, tokens });
    const authorizations: (string | null)[] = [];
    const recording: Fetch = (input, init) => {
      authorizations.push(new Headers(init.headers).get("Authorization"));
      return fetch(input, init);
    };
    const ran = await cli(["logout"], { env, fetch: recording });
    expect(ran).toEqual({ status: 0, stdout: `signed out of ${standIn.origin}\n`, stderr: "" });
    expect(standIn.requests).toEqual([`DELETE /v1/grants/${grant}`]);
    expect(authorizations).toEqual([`Bearer ${tokens.access_token}`]);
    expect([...standIn.grants.keys()]).toEqual([earlier.grant]);
    expect((await credentials.read())[standIn.origin]).toEqual({ client_id: client, tokens: null });
    // Signed out: the next command names login.
    const list = await cli(["list"], { env, fetch });
    expect(list.status).toBe(1);
    expect(list.stderr).toContain("sign in with artifacts login");
    expect(await cli(["logout"], { env, fetch })).toMatchObject({
      status: 0,
      stdout: `not signed in to ${standIn.origin}\n`,
    });
  });

  it.each<[string, Answer | "network", string]>([
    [
      "a 503",
      { status: 503, body: { error: { code: "unavailable", message: "try again" } } },
      "unavailable: try again",
    ],
    [
      "a 404 for a grant not listed yet",
      { status: 404, body: { error: { code: "not_found", message: "no grant" } } },
      "the server does not list this login's grant yet; the login is kept, so run artifacts logout again",
    ],
    ["no answer", "network", "no answer from the API (ECONNRESET)"],
  ])("keeps the login after %s, so running it again completes it", async (_name, answer, message) => {
    const { standIn, credentials, env } = await setup();
    const { client, grant, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens });
    const before = await readFile(credentials.file, "utf8");
    const failing: Fetch = (input, init) =>
      answer === "network" && input.includes("/v1/grants/")
        ? Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))
        : fetch(input, init);
    standIn.override = ({ path }) => (answer !== "network" && path.startsWith("/v1/grants/") ? answer : undefined);
    const ran = await cli(["logout"], { env, fetch: failing });
    expect(ran).toEqual({ status: 1, stdout: "", stderr: `artifacts: ${message}\n` });
    expect(await readFile(credentials.file, "utf8")).toBe(before);
    standIn.override = () => undefined;
    expect((await cli(["logout"], { env, fetch })).status).toBe(0);
    expect(standIn.grants.has(grant)).toBe(false);
  });

  it("removes a stored login the server refuses: a 401, then a refresh answered invalid_grant", async () => {
    const { standIn, credentials, env } = await setup();
    const { client, grant, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens });
    standIn.grants.delete(grant);
    const ran = await cli(["logout"], { env, fetch });
    expect(ran).toEqual({
      status: 0,
      stdout: `the server no longer accepts the stored login for ${standIn.origin}; removed it\n`,
      stderr: "",
    });
    expect(standIn.requests).toEqual([
      `DELETE /v1/grants/${grant}`,
      "GET /.well-known/oauth-authorization-server",
      "POST /oauth/token refresh_token",
    ]);
    expect((await credentials.read())[standIn.origin]).toEqual({ client_id: client, tokens: null });
  });

  it("removes a stored login whose refresh, before the revocation, is refused", async () => {
    const { standIn, credentials, env } = await setup();
    const { client, grant, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens, expires: Date.now() });
    standIn.grants.delete(grant);
    expect((await cli(["logout"], { env, fetch })).status).toBe(0);
    expect(standIn.requests).not.toContain(`DELETE /v1/grants/${grant}`);
    expect((await credentials.read())[standIn.origin]?.tokens).toBeNull();
  });
});

describe("PL-51: no command output carries a stored token", () => {
  it("through a login, failing commands, refreshes and a logout, whatever the server echoes", async () => {
    const { standIn, credentials, env } = await setup();
    const outputs: string[] = [];
    const seen = new Set<string>();
    const record = async (ran: { stdout: string; stderr: string }) => {
      outputs.push(ran.stdout, ran.stderr);
      for (const token of await credentials.storedTokens()) seen.add(token);
    };
    await record(await login(standIn, env));
    // Every failure echoes the tokens stored when it happens and the one the request carried.
    const echo = async (authorization?: string) =>
      [...(await credentials.storedTokens()), authorization?.slice("Bearer ".length) ?? ""].join(" ");
    standIn.override = async ({ path, authorization }) =>
      path === "/v1/artifacts"
        ? { status: 500, body: { error: { code: "internal", message: await echo(authorization) } } }
        : undefined;
    await record(await cli(["list"], { env, fetch }));
    // An expired access token: the refresh's tokens are echoed by the same failure.
    await credentials.expire(standIn.origin);
    await record(await cli(["list"], { env, fetch }));
    // A refused refresh whose description echoes them.
    await credentials.expire(standIn.origin);
    standIn.override = async ({ path }) =>
      path === "/oauth/token"
        ? { status: 400, body: { error: "invalid_grant", error_description: await echo() } }
        : undefined;
    await record(await cli(["list"], { env, fetch }));
    // A revocation that gets no answer, with the tokens in the failure's message, then one answered with them.
    standIn.override = () => undefined;
    const failing: Fetch = async (input, init) =>
      input.includes("/v1/grants/")
        ? Promise.reject(new TypeError(`fetch failed ${await echo()}`))
        : fetch(input, init);
    await record(await cli(["logout"], { env, fetch: failing }));
    standIn.override = async ({ path, authorization }) =>
      path.startsWith("/v1/grants/")
        ? { status: 500, body: { error: { code: "internal", message: await echo(authorization) } } }
        : undefined;
    await record(await cli(["logout"], { env, fetch }));
    expect(seen.size).toBeGreaterThanOrEqual(4);
    for (const output of outputs) for (const token of seen) expect(output).not.toContain(token);
    expect(outputs.join("")).toContain("[token]");
  });
});

describe("the listener", () => {
  it("is gone after login fails on its exchange", async () => {
    const { standIn, env } = await setup();
    standIn.override = ({ form }) =>
      form.grant_type === "authorization_code" && standIn.codes.has(form.code ?? "")
        ? { status: 503, body: {} }
        : undefined;
    const ran = await login(standIn, env);
    expect(ran.status).toBe(1);
    await until(() => standIn.callbacks.length === 1);
    expect((await standIn.callbacks[0])?.status).toBe(400);
    expect(await refused(callbackPort(ran.stderr))).toBe(true);
  });
});
