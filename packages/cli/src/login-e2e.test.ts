// PL-49 to PL-51 end to end (design.md section 7, "Testing OAuth"): `login`, a command with the stored login, a
// refresh and `logout` against the Worker in the local runtime (wrangler's test harness, with D1, R2 and KV) on
// production-shaped hosts. The Worker is src/e2e-worker.ts of the Worker's package: the deployed Worker with the
// test's own Access key set, so the test plays the owner's browser on the consent page with an app-audience JWT. Every
// other step runs through the Worker; the CLI's requests reach it through the harness, and the browser's last step,
// the redirect, reaches the CLI's loopback listener over the network.
import { createHash, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "jsonc-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";

import type { Fetch } from "./api.ts";
import { Credentials } from "./login-test-support.ts";
import { cli, tempDir, writeTree, type Ran } from "./test-support.ts";

const WORKER = fileURLToPath(new URL("../../worker/", import.meta.url));
const APP_HOST = "artifacts.example.com";
const API = "https://artifacts-api.example.com";
const TEAM = "team.example.com";
const APP_AUD = "app-audience";
const AUTHORIZE = `https://${APP_HOST}/oauth/authorize`;

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY: JsonWebKey = { ...keys.publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256", use: "sig" };

let server: TestHarness;
/** An API token the Worker admits, for reading the grant listing as the owner would. */
let apiToken: string;

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The owner's Access JWT for the app host, as Access adds it. */
function accessJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "e2e", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: `https://${TEAM}`, aud: APP_AUD, sub: "owner", iat: now, exp: now + 600 }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), keys.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Hands a request to the Worker as the harness dispatches it: by absolute URL, so the Worker sees each host. */
async function toWorker(input: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(input, init);
  const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
  const answer = await server.fetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
    ...(init.signal === null || init.signal === undefined ? {} : { signal: init.signal }),
  });
  return new Response(answer.body, { status: answer.status, headers: [...answer.headers] });
}

beforeAll(async () => {
  const generated = await cli(["token", "e2e"]);
  const [token = "", entry = ""] = generated.stdout.split("\n");
  apiToken = token;
  const config: Record<string, unknown> = parse(await readFile(join(WORKER, "wrangler.jsonc"), "utf8"));
  delete config.$schema;
  server = createTestHarness({
    root: WORKER,
    workers: [
      {
        config: {
          ...config,
          main: "./src/e2e-worker.ts",
          vars: {
            APP_HOST,
            API_HOST: new URL(API).host,
            CONTENT_HOST_SUFFIX: "-art.example.com",
            PUBLIC_HOST_SUFFIX: "-pub.example.com",
            ARCHIVE_AFTER_DAYS: "30",
            ACCESS_TEAM_DOMAIN: TEAM,
            ACCESS_APP_AUD: APP_AUD,
            ACCESS_CONTENT_AUD: "content-audience",
            API_TOKENS: `{${entry}}`,
            TEST_ACCESS_KEYS: JSON.stringify([KEY]),
          },
        },
      },
    ],
  });
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
}, 120_000);

afterAll(async () => {
  await server?.close();
});

/**
 * The owner's browser: opens the authorization URL with the app-audience JWT, keeps the consent page's cookie, allows
 * the request as `publisher` and follows the redirect to the CLI's listener. Resolves to the listener's answer.
 */
async function allow(authorizationUrl: string, publisher: string): Promise<{ status: number; text: string }> {
  expect(`${new URL(authorizationUrl).origin}${new URL(authorizationUrl).pathname}`).toBe(AUTHORIZE);
  const jwt = accessJwt();
  const page = await toWorker(authorizationUrl, { headers: { "Cf-Access-Jwt-Assertion": jwt } });
  const html = await page.text();
  expect({ status: page.status, html }).toMatchObject({ status: 200 });
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = page.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  const allowed = await toWorker(AUTHORIZE, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": jwt, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "approve", publisher }).toString(),
  });
  expect(allowed.status).toBe(303);
  const callback = await globalThis.fetch(allowed.headers.get("Location") ?? "");
  return { status: callback.status, text: await callback.text() };
}

type Seen = { requests: string[] };

/** The CLI against the Worker, recording `METHOD path status` of each request. */
async function artifacts(
  argv: readonly string[],
  env: Record<string, string>,
  seen: Seen = { requests: [] },
  publisher = "artifacts-cli",
): Promise<Ran & { browser: Promise<{ status: number; text: string }> | undefined }> {
  const fetch: Fetch = async (input, init) => {
    const response = await toWorker(input, init);
    seen.requests.push(`${init.method ?? "GET"} ${new URL(input).pathname} ${response.status}`);
    return response;
  };
  let browser: Promise<{ status: number; text: string }> | undefined;
  const ran = await cli(argv, {
    env,
    fetch,
    openBrowser: (url) => {
      browser = allow(url, publisher);
    },
  });
  return { ...ran, browser };
}

/** The part of the Worker's KV binding the test uses. */
type Kv = {
  get(key: string, type: "json"): Promise<Record<string, unknown> | null>;
  put(key: string, value: string): Promise<void>;
};

/** The KV key of an access token's record, as the library reads it. */
function tokenKey(token: string): string {
  const [user = "", grant = ""] = token.split(":");
  return `token:${user}:${grant}:${createHash("sha256").update(token).digest("hex")}`;
}

async function grantIds(): Promise<string[]> {
  const response = await toWorker(`${API}/v1/grants`, { headers: { Authorization: `Bearer ${apiToken}` } });
  const listed: { grants: { id: string }[] } = JSON.parse(await response.text());
  return listed.grants.map(({ id }) => id);
}

describe("the CLI's login against the Worker", () => {
  let credentials: Credentials;
  let env: Record<string, string>;

  // One stored login through the steps below, so the directory outlives each test.
  beforeAll(async () => {
    credentials = Credentials.at(await mkdtemp(join(tmpdir(), "artifacts-cli-e2e-")));
    env = { ARTIFACTS_API_URL: API, XDG_CONFIG_HOME: credentials.home };
  });

  afterAll(async () => {
    await rm(credentials.home, { recursive: true, force: true });
  });

  it("signs in through DCR, the consent page and the code exchange, and stores the tokens 0600", async () => {
    const seen: Seen = { requests: [] };
    const ran = await artifacts(["login"], env, seen);
    expect(ran).toMatchObject({ status: 0, stdout: `signed in to ${API}\n` });
    expect(await ran.browser).toEqual({ status: 200, text: "Signed in to artifacts. Return to the terminal.\n" });
    expect(seen.requests).toEqual([
      "GET /.well-known/oauth-protected-resource/v1 200",
      "GET /.well-known/oauth-authorization-server 200",
      "POST /oauth/register 201",
      "POST /oauth/token 200",
    ]);
    const stored = (await credentials.read())[API];
    expect(stored?.tokens?.access_token).toMatch(/^owner:[\w-]{16}:/);
    expect(await credentials.modes()).toEqual({ directory: 0o700, file: 0o600 });
    expect((await stat(credentials.file)).size).toBeGreaterThan(0);
  });

  it("publishes and lists with the stored login, as the publisher named on the consent page", async () => {
    const site = await tempDir();
    await writeTree(site, { "index.html": "<p>signed in</p>" });
    const published = await artifacts(["publish", site, "--title", "Signed in", "--json"], env);
    expect(published).toMatchObject({ status: 0 });
    expect(JSON.parse(published.stdout)).toMatchObject({ version: { published_by: "artifacts-cli" } });
    expect((await artifacts(["list"], env)).stdout).toContain("Signed in");
  });

  it("refreshes an access token about to expire before the request, rotating the stored tokens", async () => {
    const before = (await credentials.read())[API]?.tokens;
    await credentials.expire(API);
    const seen: Seen = { requests: [] };
    const ran = await artifacts(["list"], env, seen);
    expect(ran).toMatchObject({ status: 0 });
    expect(seen.requests).toEqual([
      "GET /.well-known/oauth-authorization-server 200",
      "POST /oauth/token 200",
      "GET /v1/artifacts 200",
    ]);
    const after = (await credentials.read())[API]?.tokens;
    expect(after?.access_token).not.toBe(before?.access_token);
    expect(after?.refresh_token).not.toBe(before?.refresh_token);
  });

  it("follows a 401 with one refresh and one replay", async () => {
    const token = (await credentials.read())[API]?.tokens?.access_token ?? "";
    // The server's record of the access token expires, while the file still says it is valid.
    const kv = (await server.getWorker<{ OAUTH_KV: Kv }>().getEnv()).OAUTH_KV;
    const record = await kv.get(tokenKey(token), "json");
    expect(record).not.toBeNull();
    await kv.put(tokenKey(token), JSON.stringify({ ...record, expiresAt: Math.floor(Date.now() / 1000) - 1 }));
    const seen: Seen = { requests: [] };
    const ran = await artifacts(["list"], env, seen);
    expect(ran).toMatchObject({ status: 0 });
    expect(seen.requests).toEqual([
      "GET /v1/artifacts 401",
      "GET /.well-known/oauth-authorization-server 200",
      "POST /oauth/token 200",
      "GET /v1/artifacts 200",
    ]);
  });

  it("lists the login's grant with its publisher name, and revokes another, whose tokens are then refused", async () => {
    const stored = (await credentials.read())[API];
    const grant = stored?.tokens?.access_token?.split(":")[1] ?? "";
    // Another client's login makes another grant.
    const other = await Credentials.create();
    const otherEnv = { ARTIFACTS_API_URL: API, XDG_CONFIG_HOME: other.home };
    const signedIn = await artifacts(["login"], otherEnv, { requests: [] }, "other-agent");
    expect(signedIn).toMatchObject({ status: 0 });
    expect((await signedIn.browser)?.status).toBe(200);
    const otherStored = (await other.read())[API];
    const otherGrant = otherStored?.tokens?.access_token?.split(":")[1] ?? "";
    expect(otherGrant).not.toBe(grant);

    const listed = await artifacts(["grants"], env);
    expect(listed).toMatchObject({ status: 0, stderr: "" });
    for (const [id, publisher, client] of [
      [grant, "artifacts-cli", stored?.client_id],
      [otherGrant, "other-agent", otherStored?.client_id],
    ]) {
      expect(listed.stdout).toContain(
        `${id}  publisher: ${publisher}\n  client: artifacts CLI (${client})\n` +
          `  redirect host: 127.0.0.1  resource: ${API}/v1\n`,
      );
    }

    const seen: Seen = { requests: [] };
    const revoked = await artifacts(["revoke", "--", otherGrant], env, seen);
    expect(revoked).toMatchObject({ status: 0, stdout: `revoked ${otherGrant}\n`, stderr: "" });
    expect(seen.requests).toEqual([`DELETE /v1/grants/${otherGrant} 204`]);
    // The listing, read with an API token as well, no longer holds it; the login's own grant stays.
    const after = await artifacts(["grants", "--json"], { ARTIFACTS_API_URL: API, ARTIFACTS_TOKEN: apiToken });
    const afterJson: { grants: { id: string }[] } = JSON.parse(after.stdout);
    const ids = afterJson.grants.map(({ id }) => id);
    expect(ids).toContain(grant);
    expect(ids).not.toContain(otherGrant);

    // The revoked grant's access token answers 401, and its refresh is refused.
    const refusedSeen: Seen = { requests: [] };
    const refused = await artifacts(["list"], otherEnv, refusedSeen);
    expect(refused).toMatchObject({
      status: 1,
      stderr: "artifacts: the server no longer accepts the stored login; sign in with artifacts login\n",
    });
    expect(refusedSeen.requests).toEqual([
      "GET /v1/artifacts 401",
      "GET /.well-known/oauth-authorization-server 200",
      "POST /oauth/token 400",
    ]);
  });

  it("signs out: revokes its grant with its own token, keeps the client ID, and commands then name login", async () => {
    const stored = (await credentials.read())[API];
    const grant = stored?.tokens?.access_token?.split(":")[1] ?? "";
    expect(await grantIds()).toContain(grant);
    const seen: Seen = { requests: [] };
    const ran = await artifacts(["logout"], env, seen);
    expect(ran).toMatchObject({ status: 0, stdout: `signed out of ${API}\n` });
    expect(seen.requests).toEqual([`DELETE /v1/grants/${grant} 204`]);
    expect((await credentials.read())[API]).toEqual({ client_id: stored?.client_id, tokens: null });
    expect(await grantIds()).not.toContain(grant);
    const list = await artifacts(["list"], env);
    expect(list.status).toBe(1);
    expect(list.stderr).toContain("sign in with artifacts login");
  });

  it("keeps the client ID the Worker knows: the made-up code is answered invalid_grant", async () => {
    const client = (await credentials.read())[API]?.client_id;
    const seen: Seen = { requests: [] };
    const ran = await artifacts(["login"], env, seen);
    expect(ran).toMatchObject({ status: 0 });
    expect(seen.requests).toEqual([
      "GET /.well-known/oauth-protected-resource/v1 200",
      "GET /.well-known/oauth-authorization-server 200",
      "POST /oauth/token 400",
      "POST /oauth/token 200",
    ]);
    expect((await credentials.read())[API]?.client_id).toBe(client);
  });

  it("registers again when the Worker no longer knows the stored client: invalid_client", async () => {
    const other = await Credentials.create();
    await other.put(API, { client: "unknown-client-0", tokens: null });
    const seen: Seen = { requests: [] };
    const ran = await artifacts(["login"], { ARTIFACTS_API_URL: API, XDG_CONFIG_HOME: other.home }, seen);
    expect(ran).toMatchObject({ status: 0 });
    expect(seen.requests).toEqual([
      "GET /.well-known/oauth-protected-resource/v1 200",
      "GET /.well-known/oauth-authorization-server 200",
      "POST /oauth/token 401",
      "POST /oauth/register 201",
      "POST /oauth/token 200",
    ]);
    expect((await other.read())[API]?.client_id).not.toBe("unknown-client-0");
  });
});
