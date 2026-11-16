// The authorization endpoint and its consent page (design.md section 7, "Authorize and consent"): PL-35 to PL-39, the
// full local sign-in through the Worker, and the replacement of a client's grants on approval (OAUTH-5). Access is
// stubbed with the test key set as everywhere else; every other step runs through the Worker.
import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessVerifier, type AccessOutcome } from "./access.ts";
import { formActionOrigin } from "./consent.ts";
import { assetPath } from "./gallery/assets.ts";
import { proposedPublisher } from "./gallery/pages.ts";
import { byClass, elements, parseHtml, textOf, type HtmlNode } from "./gallery/test-html.ts";
import { OWNER } from "./grants.ts";
import { newArtifactId } from "./id.ts";
import { createWorker } from "./index.ts";
import {
  AUTHORIZE,
  Browser,
  challengeOf,
  faulty,
  handleOf,
  helpers,
  oauthKv,
  REDIRECT,
  redirectQuery,
  refresh,
  REGISTER_URL,
  tokenRequest,
  tokensOf,
  useToken,
  VERIFIER,
} from "./oauth-test-support.ts";
import { revocationKey } from "./revocation.ts";
import {
  API,
  API_HOST,
  APP_AUD,
  APP_HOST,
  at,
  captureLogs,
  clearOAuthStorage,
  CONTENT_SUFFIX,
  gate,
  logEvents,
  PUBLIC_SUFFIX,
  stringAt,
  World,
} from "./test-support.ts";

beforeEach(async () => {
  await clearOAuthStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MCP = `${API}/mcp`;
const V1 = `${API}/v1`;
const ID = "abcdefghijklmnopqrstuvwxyz";
const CIMD_ID = "https://client.example.org/oauth/client.json";

/** An Access verifier that throws, for the outer handler's 500. */
class ThrowingVerifier extends AccessVerifier {
  override verify(): Promise<AccessOutcome> {
    return Promise.reject(new Error("verifier failed"));
  }
}

type Client = { readonly clientId: string; readonly secret?: string };

/** A client registered through the Worker's DCR endpoint, with its secret when it is confidential. */
async function register(world: World, metadata: Record<string, unknown> = {}): Promise<Client> {
  const response = await world.fetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      client_name: "Test Client",
      ...metadata,
    }),
  });
  if (response.status !== 201) throw new Error(`registration answered ${response.status}: ${await response.text()}`);
  const body: unknown = await response.json();
  const secret = at(body, "client_secret");
  return { clientId: stringAt(body, "client_id"), ...(typeof secret === "string" ? { secret } : {}) };
}

/** A CIMD client's document, served by a stub of the library's fetch. */
function cimdDocument(clientId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: "Example Agent",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    ...fields,
  };
}

/** Stubs the global fetch the library uses for CIMD with `documents` by URL; any other URL is unreachable. */
function serveDocuments(documents: Record<string, Record<string, unknown>>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const document = documents[url];
    if (document === undefined) throw new TypeError("unreachable");
    return Response.json(document, { headers: { "Cache-Control": "no-store" } });
  });
}

/** The authorization request of a sign-in: a public client, S256 PKCE, the MCP resource. */
async function params(clientId: string, overrides: Record<string, string | null> = {}): Promise<URLSearchParams> {
  const values: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "state-1",
    code_challenge: await challengeOf(VERIFIER),
    code_challenge_method: "S256",
    resource: MCP,
    ...overrides,
  };
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value !== null) search.set(name, value);
  return search;
}

async function documentOf(response: Response): Promise<HtmlNode> {
  return parseHtml(await response.text());
}

/** The heading and status of an error page. */
async function errorPageOf(response: Response): Promise<{ status: number; heading: string }> {
  const document = await documentOf(response);
  const heading = elements(document).find((node) => node.tag === "h1");
  return { status: response.status, heading: heading === undefined ? "" : textOf(heading) };
}

/** Opens the page and allows it as `publisher`; returns the code the client receives. */
async function signIn(
  browser: Browser,
  clientId: string,
  overrides: Record<string, string | null> = {},
  publisher = "test-agent",
): Promise<string> {
  const handle = await handleOf(await browser.open(await params(clientId, overrides)));
  const response = await browser.post({ handle, decision: "approve", publisher });
  if (response.status !== 303) throw new Error(`approval answered ${response.status}: ${await response.text()}`);
  return stringAt(redirectQuery(response), "code");
}

/** The code exchange; a confidential client authenticates with Basic, a public one names itself in the body. */
const exchange = (world: World, client: Client, code: string, verifier = VERIFIER, redirect = REDIRECT) =>
  tokenRequest(
    world,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      ...(client.secret === undefined ? { client_id: client.clientId } : {}),
    },
    client.secret === undefined ? {} : { Authorization: `Basic ${btoa(`${client.clientId}:${client.secret}`)}` },
  );

const grantIdOf = (code: string) => code.split(":")[1] ?? "";

async function keys(prefix: string): Promise<KVNamespaceListKey<unknown>[]> {
  return (await oauthKv().list({ prefix })).keys;
}

async function grantIds(): Promise<string[]> {
  return (await keys(`grant:${OWNER}:`)).map((key) => key.name.split(":")[2] ?? "").toSorted();
}

const transactions = async () => (await keys("transaction:")).length;

// PL-35, OAUTH-6.
describe("PL-35: a CIMD client's document", () => {
  it("is fetched from an outside host, and the page shows the client with its domain", async () => {
    const world = new World();
    const fetchSpy = serveDocuments({ [CIMD_ID]: cimdDocument(CIMD_ID) });
    const response = await new Browser(world).open(await params(CIMD_ID));
    expect(response.status).toBe(200);
    const document = await documentOf(response);
    const rows = byClass(document, "info-row").map((row) => textOf(row));
    expect(rows[0]).toBe("App Example Agent, identified by client.example.org");
    expect(fetchSpy.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)))).toContain(
      CIMD_ID,
    );
  });

  it("is never fetched when the client ID is on a host of this deployment, which answers an error page", async () => {
    const world = new World();
    const fetchSpy = serveDocuments({});
    const logs = captureLogs();
    const hosts = [
      APP_HOST,
      API_HOST,
      `${ID}${CONTENT_SUFFIX}`,
      `${ID}${PUBLIC_SUFFIX}`,
      // Any name ending in a suffix reaches the Worker's routes, an ID or not.
      `anything${CONTENT_SUFFIX}`,
      `anything${PUBLIC_SUFFIX}`,
      APP_HOST.toUpperCase(),
      `${APP_HOST}.`,
      `${API_HOST}:8443`,
    ];
    for (const host of hosts) {
      const clientId = `https://${host}/client.json`;
      const response = await new Browser(world).open(await params(clientId));
      expect({ host, ...(await errorPageOf(response)) }).toEqual({
        host,
        status: 400,
        heading: "This sign-in can’t continue",
      });
      expect(response.headers.has("Location")).toBe(false);
      expect(response.headers.has("Set-Cookie")).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await transactions()).toBe(0);
    expect(logEvents(logs.lines)).toEqual(
      hosts.map(() => ({ event: "consent.refused", reason: "client_on_deployment" })),
    );
  });

  it.each([
    ["unreachable", () => serveDocuments({})],
    ["invalid", () => serveDocuments({ [CIMD_ID]: cimdDocument("https://client.example.org/other.json") })],
  ] as const)("answers an error page, and no redirect, when the document is %s", async (_case, stub) => {
    const world = new World();
    stub();
    const logs = captureLogs();
    const response = await new Browser(world).open(await params(CIMD_ID));
    expect(await errorPageOf(response)).toEqual({ status: 400, heading: "This sign-in can’t continue" });
    expect(response.headers.has("Location")).toBe(false);
    expect(await transactions()).toBe(0);
    // Besides the router's line, the library's own warning, which design.md section 7 bounds (DATA-1).
    const library = logs.lines.filter((line) => line.includes(`CIMD fetch failed for ${CIMD_ID}:`));
    expect(library).toHaveLength(1);
    expect(logEvents(logs.lines.filter((line) => !library.includes(line)))).toEqual([
      { event: "consent.refused", reason: "client_unverifiable" },
    ]);
  });
});

// PL-36, OAUTH-2.
describe("PL-36: where a code may go", () => {
  it("refuses a redirect URI on each host of this deployment with an error page, never a redirect", async () => {
    const world = new World();
    const hosts = [APP_HOST, API_HOST, `${ID}${CONTENT_SUFFIX}`, `${ID}${PUBLIC_SUFFIX}`, `x${PUBLIC_SUFFIX}`];
    const redirects = hosts.map((host) => `https://${host}/callback`);
    const client = await register(world, { redirect_uris: redirects });
    const logs = captureLogs();
    for (const redirect of [...redirects, `https://${APP_HOST}.:8443/callback`]) {
      // An unknown resource would make the library redirect its error to a redirect URI it validated.
      for (const resource of [MCP, "https://elsewhere.example.org/mcp"]) {
        const response = await new Browser(world).open(
          await params(client.clientId, { redirect_uri: redirect, resource }),
        );
        expect({ redirect, resource, ...(await errorPageOf(response)) }).toEqual({
          redirect,
          resource,
          status: 400,
          heading: "This sign-in can’t continue",
        });
        expect(response.headers.has("Location")).toBe(false);
      }
    }
    expect(await transactions()).toBe(0);
    expect(new Set(logEvents(logs.lines).map((line) => line.reason))).toEqual(new Set(["redirect_on_deployment"]));
  });

  it("refuses a redirect URI the client did not register, and takes a registered loopback one on any port", async () => {
    const world = new World();
    const client = await register(world);
    for (const redirect of ["http://localhost:33418/callback", "http://127.0.0.1:33418/other"]) {
      const response = await new Browser(world).open(await params(client.clientId, { redirect_uri: redirect }));
      expect({ redirect, ...(await errorPageOf(response)) }).toEqual({
        redirect,
        status: 400,
        heading: "This sign-in can’t continue",
      });
      expect(response.headers.has("Location")).toBe(false);
    }
    const otherPort = "http://127.0.0.1:50001/callback";
    const browser = new Browser(world);
    const code = await signIn(browser, client.clientId, { redirect_uri: otherPort });
    await tokensOf(await exchange(world, client, code, VERIFIER, otherPort));
  });

  it("redirects a refusal to a validated redirect URI with the error, state and iss", async () => {
    const world = new World();
    const client = await register(world);
    const response = await new Browser(world).open(
      await params(client.clientId, { resource: "https://elsewhere.example.org/mcp" }),
    );
    expect(response.status).toBe(302);
    expect(redirectQuery(response)).toMatchObject({
      target: REDIRECT,
      error: "invalid_target",
      state: "state-1",
      iss: API,
    });
  });

  // The library requires a challenge only from a client that authenticates with `none` and refuses `plain`; the router
  // requires one from every client, so the confidential client's missing challenge is the router's refusal (the
  // library alone would show it the page).
  it.each([
    ["public", { token_endpoint_auth_method: "none" }, "request_redirected"],
    ["confidential", { token_endpoint_auth_method: "client_secret_basic" }, "pkce_required"],
  ] as const)(
    "requires an S256 challenge from a %s client before consent, and its verifier at the exchange",
    async (_kind, metadata, missing) => {
      const world = new World();
      const client = await register(world, metadata);
      const logs = captureLogs();
      for (const overrides of [
        { code_challenge: null, code_challenge_method: null },
        { code_challenge: VERIFIER, code_challenge_method: "plain" },
        { code_challenge_method: null },
      ]) {
        const response = await new Browser(world).open(await params(client.clientId, overrides));
        expect({ overrides, status: response.status }).toEqual({ overrides, status: 302 });
        expect(redirectQuery(response)).toMatchObject({
          target: REDIRECT,
          error: "invalid_request",
          state: "state-1",
          iss: API,
        });
      }
      expect(await transactions()).toBe(0);
      expect(logEvents(logs.lines).map((line) => line.reason)).toEqual([
        missing,
        "request_redirected",
        "request_redirected",
      ]);

      const browser = new Browser(world);
      const wrong = await exchange(world, client, await signIn(browser, client.clientId), `${VERIFIER}-wrong`);
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
      await tokensOf(await exchange(world, client, await signIn(browser, client.clientId)));
    },
  );
});

// PL-37, OAUTH-1, ACC-1.
describe("PL-37: the consent form", () => {
  it("creates a grant only with an app JWT, the page's handle and this browser's cookie, once", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const owner = new Browser(world);
    const handle = await handleOf(await owner.open(await params(clientId)));
    const approve = { handle, decision: "approve", publisher: "agent" };

    // Access first: no JWT, and the content audience's.
    expect((await owner.post(approve, { jwt: null })).status).toBe(403);
    expect((await owner.post(approve, { jwt: await world.jwt() })).status).toBe(403);
    // Another browser: no cookie, and another transaction's cookie.
    const stranger = new Browser(world);
    expect(await errorPageOf(await stranger.post(approve))).toEqual({
      status: 400,
      heading: "This sign-in can’t continue",
    });
    await handleOf(await stranger.open(await params(clientId)));
    expect((await stranger.post(approve)).status).toBe(400);
    expect(await grantIds()).toEqual([]);

    // The owner's browser, once. A replay keeps the binding cookie the approval cleared, so only the transaction's
    // consumption refuses it.
    const replay = new Browser(world);
    for (const [name, value] of owner.cookies) replay.cookies.set(name, value);
    const allowed = await owner.post(approve);
    expect(allowed.status).toBe(303);
    expect(redirectQuery(allowed)).toMatchObject({ target: REDIRECT, state: "state-1", iss: API });
    expect(await grantIds()).toHaveLength(1);
    const again = await replay.post(approve);
    expect(await errorPageOf(again)).toEqual({ status: 400, heading: "This sign-in can’t continue" });
    expect(again.headers.has("Location")).toBe(false);
    expect(await grantIds()).toHaveLength(1);
  });

  it("keeps a transaction for 10 minutes and refuses it once it is gone", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const browser = new Browser(world);
    const handle = await handleOf(await browser.open(await params(clientId)));
    const [transaction] = await keys("transaction:");
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs((transaction?.expiration ?? 0) - (now + 600))).toBeLessThanOrEqual(5);
    // KV removes the record when its TTL passes; the test removes it at once.
    await oauthKv().delete(transaction?.name ?? "");
    const response = await browser.post({ handle, decision: "approve", publisher: "agent" });
    expect(await errorPageOf(response)).toEqual({ status: 400, heading: "This sign-in can’t continue" });
    expect(await grantIds()).toEqual([]);
  });

  it("redirects Deny to the client with access_denied, state and iss, ends the transaction and creates no grant", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const browser = new Browser(world);
    const handle = await handleOf(await browser.open(await params(clientId)));
    expect(browser.cookies.size).toBe(1);
    const logs = captureLogs();
    // Deny needs no valid publisher name.
    const denied = await browser.post({ handle, decision: "deny", publisher: "NOT VALID" });
    expect(denied.status).toBe(303);
    expect(redirectQuery(denied)).toEqual({ target: REDIRECT, error: "access_denied", state: "state-1", iss: API });
    expect(browser.cookies.size).toBe(0);
    expect(await transactions()).toBe(0);
    expect(await grantIds()).toEqual([]);
    expect(logEvents(logs.lines)).toEqual([{ event: "consent.refused", reason: "denied" }]);
  });

  it("starts a new transaction on every GET and never remembers consent", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const browser = new Browser(world);
    const first = await handleOf(await browser.open(await params(clientId)));
    const second = await handleOf(await browser.open(await params(clientId)));
    expect(first).not.toBe(second);
    expect(browser.cookies.size).toBe(2);
    expect(await transactions()).toBe(2);
    expect(await grantIds()).toEqual([]);
    // Two tabs: each page's handle works with its own cookie.
    expect((await browser.post({ handle: first, decision: "approve", publisher: "agent" })).status).toBe(303);
    // After an approval the next sign-in shows the page again.
    expect((await browser.open(await params(clientId))).status).toBe(200);
  });

  it("answers any method but GET and POST with 405, before Access and storage", async () => {
    const world = new World();
    const helperSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "getOAuthApi");
    for (const method of ["HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await world.fetch(AUTHORIZE, {
        method,
        headers: { "Cf-Access-Jwt-Assertion": await world.jwt({ aud: APP_AUD }) },
        ...(method === "PUT" || method === "PATCH" ? { body: "decision=approve" } : {}),
      });
      expect({ method, status: response.status, allow: response.headers.get("Allow") }).toEqual({
        method,
        status: 405,
        allow: "GET, POST",
      });
      expect(response.headers.has("Set-Cookie")).toBe(false);
    }
    expect(world.keys.calls).toBe(0);
    expect(helperSpy).not.toHaveBeenCalled();
    expect(await transactions()).toBe(0);
  });

  it("refuses a GET without the app audience's JWT before the library", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const helperSpy = vi.spyOn(OAuthAuthorizationServer.prototype, "getOAuthApi");
    for (const jwt of [null, await world.jwt()]) {
      const response = await new Browser(world).open(await params(clientId), { jwt });
      expect(response.status).toBe(403);
      expect(response.headers.has("Set-Cookie")).toBe(false);
    }
    expect(helperSpy).not.toHaveBeenCalled();
    expect(await transactions()).toBe(0);
  });

  it("answers a form that is not the page's with an error page", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const browser = new Browser(world);
    const handle = await handleOf(await browser.open(await params(clientId)));
    const cases: [string, Response][] = [
      ["no decision", await browser.post({ handle, publisher: "agent" })],
      ["another decision", await browser.post({ handle, decision: "maybe", publisher: "agent" })],
      ["two decisions", await browser.post(`handle=${handle}&decision=approve&decision=deny&publisher=agent`)],
      [
        "another type",
        await world.fetch(AUTHORIZE, {
          method: "POST",
          headers: { ...Object.fromEntries(await browser.headers(undefined)), "Content-Type": "text/plain" },
          body: `handle=${handle}&decision=approve&publisher=agent`,
        }),
      ],
    ];
    for (const [name, response] of cases) {
      expect({ name, ...(await errorPageOf(response)) }).toEqual({
        name,
        status: 400,
        heading: "This sign-in can’t continue",
      });
    }
    // RES-1: at the bound of design.md section 7, written out so that a change of the constant fails, the form is read;
    // one byte past it is 413.
    const bound = 4 * 1024;
    const padded = (total: number) => {
      const start = `handle=${handle}&decision=approve&publisher=agent&pad=`;
      return `${start}${"a".repeat(total - start.length)}`;
    };
    expect((await browser.post(padded(bound + 1))).status).toBe(413);
    expect(await grantIds()).toEqual([]);
    expect((await browser.post(padded(bound))).status).toBe(303);
  });
});

// PL-38, ISO-5, OAUTH-2.
describe("PL-38: the page", () => {
  const MARKUP = `"><script>alert(1)</script><img src=x onerror=alert(1)>'&amp;`;

  it("escapes every value the client supplied", async () => {
    const world = new World();
    const redirect = `http://127.0.0.1:33418/cb/"><script>alert(1)</script>`;
    const { clientId } = await register(world, {
      client_name: MARKUP,
      client_uri: `https://example.org/${MARKUP}`,
      redirect_uris: [redirect],
    });
    const response = await new Browser(world).open(await params(clientId, { redirect_uri: redirect, state: MARKUP }));
    expect(response.status).toBe(200);
    const document = await documentOf(response);
    const found = elements(document);
    expect(found.filter((node) => ["script", "iframe", "svg", "object"].includes(node.tag))).toEqual([]);
    expect(found.filter((node) => node.tag === "img").map((node) => node.attributes.get("src"))).toEqual([
      assetPath("icon.svg"),
    ]);
    expect(found.flatMap((node) => [...node.attributes.keys()]).filter((name) => name.startsWith("on"))).toEqual([]);
    expect(textOf(byClass(document, "info-row")[0] ?? document)).toBe(
      `App ${MARKUP}, registered itself; the name is not verified`,
    );
    const publisher = found.find((node) => node.attributes.get("name") === "publisher");
    expect(publisher?.attributes.get("value")).toBe(proposedPublisher(MARKUP));
  });

  it.each([
    ["a loopback redirect URI", REDIRECT, "http://127.0.0.1:33418", true],
    [
      "an https redirect URI",
      "https://client.example.org:8443/oauth/callback",
      "https://client.example.org:8443",
      false,
    ],
  ] as const)(
    "admits the client's origin of %s in form-action, with the page's headers",
    async (_name, redirect, origin, loopback) => {
      const world = new World();
      const { clientId } = await register(world, { redirect_uris: [redirect] });
      const response = await new Browser(world).open(await params(clientId, { redirect_uri: redirect }));
      expect(response.status).toBe(200);
      const directives = (response.headers.get("Content-Security-Policy") ?? "").split(";").map((part) => part.trim());
      expect(directives).toEqual([
        "default-src 'none'",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self'",
        "base-uri 'none'",
        `form-action 'self' ${origin}`,
        "frame-ancestors 'none'",
      ]);
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response.headers.has("ETag")).toBe(false);
      expect(response.headers.has("Vary")).toBe(false);
      // ISO-4: the one cookie is the library's binding of this transaction to this browser.
      const cookies = response.headers.getSetCookie();
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(
        /^__Host-oauth-consent-[0-9a-f]{16}=[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
      );
      const document = await documentOf(response);
      const rows = byClass(document, "info-row").map((row) => textOf(row));
      expect(rows).toEqual([
        "App Test Client, registered itself; the name is not verified",
        `Sends access to ${new URL(redirect).hostname}`,
        `Resource MCP at ${MCP}`,
        "Allows Reading, publishing, making public and deleting every artifact",
      ]);
      expect(byClass(document, "notice").map((notice) => textOf(notice))).toEqual(
        loopback ? ["127.0.0.1 is an app on this computer: allow only if you just started signing in from it."] : [],
      );
    },
  );

  it("names the REST API for a /v1 request", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const document = await documentOf(await new Browser(world).open(await params(clientId, { resource: V1 })));
    expect(byClass(document, "info-row").map((row) => textOf(row))[2]).toBe(`Resource REST API at ${V1}`);
  });

  it("refuses a redirect origin that form-action cannot take as it is, before the page", async () => {
    const world = new World();
    // Both pass the library's checks: https, a registered URI.
    const redirects = ["https://203.0.113.7/callback", "https://a;b.example.org/callback"];
    const { clientId } = await register(world, { redirect_uris: redirects });
    const logs = captureLogs();
    for (const redirect of redirects) {
      const response = await new Browser(world).open(await params(clientId, { redirect_uri: redirect }));
      expect({ redirect, ...(await errorPageOf(response)) }).toEqual({
        redirect,
        status: 400,
        heading: "This sign-in can’t continue",
      });
      expect(response.headers.has("Location")).toBe(false);
      expect(response.headers.has("Set-Cookie")).toBe(false);
    }
    expect(await transactions()).toBe(0);
    expect(logEvents(logs.lines)).toEqual(redirects.map(() => ({ event: "consent.refused", reason: "redirect_form" })));
  });

  it.each([
    ["http://127.0.0.1:33418/callback", "http://127.0.0.1:33418"],
    ["http://127.9.8.7/callback", "http://127.9.8.7"],
    ["http://localhost:8080/oauth/callback?x=1", "http://localhost:8080"],
    ["https://claude.ai/api/mcp/auth_callback", "https://claude.ai"],
    ["https://CLIENT.example.org:443/cb", "https://client.example.org"],
    ["https://client.example.org:8443/cb", "https://client.example.org:8443"],
    ["https://xn--bcher-kva.example/cb", "https://xn--bcher-kva.example"],
    ["https://user:secret@client.example.org/cb", undefined],
    ["http://client.example.org/cb", undefined],
    ["http://[::1]:33418/callback", undefined],
    ["https://203.0.113.7/cb", undefined],
    ["https://a;b.example.org/cb", undefined],
    ['https://a"b.example.org/cb', undefined],
    ["https://a'b.example.org/cb", undefined],
    ["https://a*b.example.org/cb", undefined],
    ["https://client.example.org./cb", undefined],
    ["com.example.app:/callback", undefined],
    ["not a url", undefined],
  ])("takes %s as the form-action origin %s", (redirect, origin) => {
    expect(formActionOrigin(redirect)).toBe(origin);
  });

  it("answers every refusal, error page and redirect no-store and unframeable, without ETag, Vary or another cookie", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const browser = new Browser(world);
    const handle = await handleOf(await browser.open(await params(clientId)));
    // Access's key set cannot be fetched: 503 before the consent code runs.
    const unreachable = new World({ keyTimeoutMs: 50 });
    unreachable.keys.mode = "hang";
    // Access verification itself throws: the outer handler's 500.
    const failing = createWorker({
      now: () => Date.now(),
      newId: newArtifactId,
      sleep: async () => {},
      timeouts: { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 2_000 },
      access: new ThrowingVerifier({ fetch: world.keys.fetch, now: () => Date.now() }),
    });
    captureLogs();
    const answers = [
      await new Browser(world).open(await params("https://artifacts.example.com/client.json")),
      await new Browser(world).open(await params(clientId, { code_challenge: null })),
      await browser.post({ handle, decision: "approve", publisher: "NO" }),
      await browser.post({ handle, decision: "approve", publisher: "agent" }),
      await new Browser(world).open(await params(clientId), { jwt: null }),
      await new Browser(world).post({ handle, decision: "deny" }, { jwt: await world.jwt() }),
      await world.fetch(`${AUTHORIZE}?${(await params(clientId)).toString()}`, { method: "HEAD" }),
      await world.fetch(AUTHORIZE, { method: "PUT", body: "decision=approve" }),
      await world.fetch(AUTHORIZE, { method: "OPTIONS" }),
      await new Browser(unreachable).open(await params(clientId)),
      await failing.fetch(new Request(AUTHORIZE), world.env, createExecutionContext()),
    ];
    expect(answers.map((response) => response.status)).toEqual([400, 302, 400, 303, 403, 403, 405, 405, 405, 503, 500]);
    for (const response of answers) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.has("ETag")).toBe(false);
      expect(response.headers.has("Vary")).toBe(false);
      // Every answer but the page keeps form-action 'none'.
      expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'none'");
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      for (const cookie of response.headers.getSetCookie()) {
        expect(cookie).toMatch(
          /^__Host-oauth-consent-[0-9a-f]{16}=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/,
        );
      }
    }
  });
});

// PL-39, TOK-3.
describe("PL-39: the publisher name", () => {
  it("refuses a name of the wrong form without a grant, keeping the transaction, and takes a corrected one", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const browser = new Browser(world);
    const handle = await handleOf(await browser.open(await params(clientId)));
    const logs = captureLogs();
    const wrong = ["", "a".repeat(33), "Claude", "claude code", "claude_code", "クロード"];
    for (const publisher of wrong) {
      const response = await browser.post({ handle, decision: "approve", publisher });
      expect({ publisher, ...(await errorPageOf(response)) }).toEqual({
        publisher,
        status: 400,
        heading: "The publisher name isn’t valid",
      });
      expect(response.headers.has("Set-Cookie")).toBe(false);
    }
    for (const form of [
      `handle=${handle}&decision=approve`,
      `handle=${handle}&decision=approve&publisher=a&publisher=b`,
    ]) {
      expect((await browser.post(form)).status).toBe(400);
    }
    expect(await grantIds()).toEqual([]);
    expect(await transactions()).toBe(1);
    expect(logEvents(logs.lines)).toEqual(
      Array.from({ length: wrong.length + 2 }, () => ({ event: "consent.refused", reason: "publisher_invalid" })),
    );
    const longest = "a".repeat(32);
    const allowed = await browser.post({ handle, decision: "approve", publisher: longest });
    expect(allowed.status).toBe(303);
    const [grant] = (await helpers(world).listUserGrants(OWNER)).items;
    expect(grant?.metadata).toEqual({ publisher: longest, clientName: "Test Client", redirectHost: "127.0.0.1" });
  });

  it.each([
    ["Claude Code", "claude-code"],
    ["  Gemini   CLI!! ", "-gemini-cli-"],
    ["ÀÉ", "-"],
    ["", "client"],
    ["a".repeat(40), "a".repeat(32)],
  ])("proposes %j as %j", (name, proposed) => {
    expect(proposedPublisher(name)).toBe(proposed);
  });
});

describe("the whole sign-in through the Worker", () => {
  it("registers, authorizes with S256, allows, exchanges the code and refreshes", async () => {
    const world = new World();
    const logs = captureLogs();
    // 1. DCR.
    const client = await register(world, { client_name: "Gemini CLI" });
    // 2. Authorization with PKCE S256: the page, bound to this browser.
    const browser = new Browser(world);
    const page = await browser.open(await params(client.clientId));
    const handle = await handleOf(page);
    // 3. Consent.
    const allowed = await browser.post({ handle, decision: "approve", publisher: "gemini-cli" });
    expect(allowed.status).toBe(303);
    const query = redirectQuery(allowed);
    expect(query).toMatchObject({ target: REDIRECT, state: "state-1", iss: API });
    const code = stringAt(query, "code");
    // 4. The code exchange, with the verifier.
    const tokens = await tokensOf(await exchange(world, client, code));
    expect(tokens).toMatchObject({ resource: MCP });
    const unwrapped = await helpers(world).unwrapToken<{ publisher: string }>(tokens.access_token);
    expect(unwrapped?.grant.props).toEqual({ publisher: "gemini-cli" });
    // 5. Refresh, with rotation.
    const refreshed = await tokensOf(await refresh(world, client.clientId, tokens.refresh_token));
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(refreshed).toMatchObject({ resource: MCP });

    const grantId = grantIdOf(code);
    const { items } = await helpers(world).listUserGrants(OWNER);
    expect(items.map((grant) => ({ id: grant.id, metadata: grant.metadata, resource: grant.resource }))).toEqual([
      {
        id: grantId,
        metadata: { publisher: "gemini-cli", clientName: "Gemini CLI", redirectHost: "127.0.0.1" },
        resource: MCP,
      },
    ]);
    expect(logEvents(logs.lines)).toEqual([
      { event: "grant.created", publisher: "gemini-cli", grant: grantId, resource: "mcp", client: "dcr" },
    ]);
  });

  it("signs in a CIMD client to /v1", async () => {
    const world = new World();
    serveDocuments({ [CIMD_ID]: cimdDocument(CIMD_ID, { client_name: "Claude Code" }) });
    const logs = captureLogs();
    const browser = new Browser(world);
    const handle = await handleOf(await browser.open(await params(CIMD_ID, { resource: V1 })));
    const allowed = await browser.post({ handle, decision: "approve", publisher: "claude-code" });
    const code = stringAt(redirectQuery(allowed), "code");
    const tokens = await tokensOf(await exchange(world, { clientId: CIMD_ID }, code));
    expect(tokens).toMatchObject({ resource: V1 });
    expect(logEvents(logs.lines)).toEqual([
      { event: "grant.created", publisher: "claude-code", grant: grantIdOf(code), resource: "v1", client: "cimd" },
    ]);
  });

  it("stores no client name for a client that gave none", async () => {
    const world = new World();
    const { clientId } = await register(world, { client_name: undefined });
    await signIn(new Browser(world), clientId);
    const [grant] = (await helpers(world).listUserGrants(OWNER)).items;
    expect(grant?.metadata).toEqual({ publisher: "test-agent", clientName: null, redirectHost: "127.0.0.1" });
  });
});

// OAUTH-5: approving replaces the client's grants for the resource through the revocation wrapper.
describe("OAUTH-5: grant replacement on approval", () => {
  it("revokes the client's grant for the same resource, and keeps its other resource and other clients", async () => {
    const world = new World();
    const browser = new Browser(world);
    const first = await register(world);
    const other = await register(world);
    const replacedCode = await signIn(browser, first.clientId);
    const replacedTokens = await tokensOf(await exchange(world, first, replacedCode));
    const keptV1 = grantIdOf(await signIn(browser, first.clientId, { resource: V1 }));
    const keptOther = grantIdOf(await signIn(browser, other.clientId));
    const replaced = grantIdOf(replacedCode);

    const logs = captureLogs();
    const code = await signIn(browser, first.clientId);
    const current = grantIdOf(code);
    expect(await grantIds()).toEqual([keptV1, keptOther, current].toSorted());
    expect(await oauthKv().get(revocationKey(replaced))).not.toBeNull();
    expect(logEvents(logs.lines).map((line) => line.event)).toEqual(["grant.revoked", "grant.created"]);
    // The replaced grant's tokens are refused; the new one works.
    const refused = await refresh(world, first.clientId, replacedTokens.refresh_token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_grant" });
    await tokensOf(await exchange(world, first, code));
  });

  it("replaces a CIMD client's grant only from the same redirect URI, port included", async () => {
    const world = new World();
    const otherPort = "http://127.0.0.1:50001/callback";
    serveDocuments({ [CIMD_ID]: cimdDocument(CIMD_ID) });
    const browser = new Browser(world);
    const atPort = grantIdOf(await signIn(browser, CIMD_ID));
    const elsewhere = grantIdOf(await signIn(browser, CIMD_ID, { redirect_uri: otherPort }));
    expect(await grantIds()).toEqual([atPort, elsewhere].toSorted());
    const again = grantIdOf(await signIn(browser, CIMD_ID));
    expect(await grantIds()).toEqual([elsewhere, again].toSorted());
    expect(await oauthKv().get(revocationKey(atPort))).not.toBeNull();
    expect(await oauthKv().get(revocationKey(elsewhere))).toBeNull();
  });

  it("answers 503 and sends no code when a replaced grant's record cannot be written; a new sign-in replaces it", async () => {
    const world = new World();
    const browser = new Browser(world);
    const client = await register(world);
    const old = grantIdOf(await signIn(browser, client.clientId));
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(oauthKv(), (method, key) =>
        method === "put" && key.startsWith("revoked:") ? "throw" : undefined,
      ),
    };
    const handle = await handleOf(await browser.open(await params(client.clientId)));
    const logs = captureLogs();
    const failed = await browser.post({ handle, decision: "approve", publisher: "agent" });
    expect(await errorPageOf(failed)).toEqual({ status: 503, heading: "Sign-in is unavailable" });
    expect(failed.headers.has("Location")).toBe(false);
    // The transaction is used, so the error page clears its binding as the redirect would have.
    expect(failed.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^__Host-oauth-consent-[0-9a-f]{16}=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/),
    ]);
    expect(browser.cookies.size).toBe(0);
    expect(await grantIds()).toEqual([old]);
    expect(logEvents(logs.lines)).toEqual([{ event: "grant.revoke_failed", grant: old, error: "Error" }]);

    world.env = { ...world.env, OAUTH_KV: oauthKv() };
    const current = grantIdOf(await signIn(browser, client.clientId));
    expect(await grantIds()).toEqual([current]);
    expect(await oauthKv().get(revocationKey(old))).not.toBeNull();
  });

  // RES-2: the listing is a read of our own, under the KV-read timeout.
  it.each(["throw", "hang"] as const)(
    "answers 503 and sends no code when the grant listing fails (%s)",
    async (fault) => {
      const world = new World({ timeouts: { r2Ms: 2_000, d1ReadMs: 2_000, kvReadMs: 50 } });
      const browser = new Browser(world);
      const client = await register(world);
      const old = grantIdOf(await signIn(browser, client.clientId));
      const handle = await handleOf(await browser.open(await params(client.clientId)));
      world.env = { ...world.env, OAUTH_KV: faulty(oauthKv(), (method) => (method === "list" ? fault : undefined)) };
      const logs = captureLogs();
      const failed = await browser.post({ handle, decision: "approve", publisher: "agent" });
      expect(await errorPageOf(failed)).toEqual({ status: 503, heading: "Sign-in is unavailable" });
      expect(failed.headers.has("Location")).toBe(false);
      expect(logEvents(logs.lines)).toEqual([
        { event: "request.failed", error: fault === "throw" ? "Error" : "TimeoutError", host: "app" },
      ]);
      world.env = { ...world.env, OAUTH_KV: oauthKv() };
      expect(await grantIds()).toEqual([old]);
    },
  );

  it("answers 503 when the deletion after the record fails; the record already refuses the grant", async () => {
    const world = new World();
    const browser = new Browser(world);
    const client = await register(world);
    const oldCode = await signIn(browser, client.clientId);
    const oldTokens = await tokensOf(await exchange(world, client, oldCode));
    const old = grantIdOf(oldCode);
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(oauthKv(), (method, key) =>
        method === "delete" && key.startsWith("grant:") ? "throw" : undefined,
      ),
    };
    const handle = await handleOf(await browser.open(await params(client.clientId)));
    captureLogs();
    const failed = await browser.post({ handle, decision: "approve", publisher: "agent" });
    expect(failed.status).toBe(503);
    expect(failed.headers.has("Location")).toBe(false);
    world.env = { ...world.env, OAUTH_KV: oauthKv() };
    expect(await grantIds()).toEqual([old]);
    const refused = await refresh(world, client.clientId, oldTokens.refresh_token);
    expect(await refused.json()).toEqual({ error: "invalid_grant", error_description: "Grant not found" });
  });

  it("refuses the tokens of a refresh that wrote the replaced grant back", async () => {
    const world = new World();
    const browser = new Browser(world);
    const client = await register(world);
    const code = await signIn(browser, client.clientId);
    const tokens = await tokensOf(await exchange(world, client, code));
    const grantKey = `grant:${OWNER}:${grantIdOf(code)}`;
    // The refresh is held at its write of the grant, which follows its read, while an approval replaces the grant.
    const held = gate();
    const reached = Promise.withResolvers<void>();
    const racingWorld = new World();
    racingWorld.env = {
      ...racingWorld.env,
      OAUTH_KV: faulty(oauthKv(), (method, key) => {
        if (method !== "put" || key !== grantKey) return undefined;
        reached.resolve();
        return held.promise;
      }),
    };
    const racing = refresh(racingWorld, client.clientId, tokens.refresh_token);
    await reached.promise;
    await signIn(browser, client.clientId);
    expect(await oauthKv().get(grantKey)).toBeNull();
    held.open();
    const raced = await tokensOf(await racing);
    // The library wrote the grant back after its deletion; only the record still refuses it, and its new access token.
    expect(await oauthKv().get(grantKey)).not.toBeNull();
    expect((await useToken(world, "mcp", raced.access_token)).status).toBe(401);
    const after = await refresh(world, client.clientId, raced.refresh_token);
    expect(after.status).toBe(400);
    expect(await after.json()).toEqual({ error: "invalid_grant", error_description: "Grant not found" });
  });
});

describe("failures of the endpoint", () => {
  it("answers 503 when KV fails while the page begins or the form is answered", async () => {
    const world = new World();
    const { clientId } = await register(world);
    const browser = new Browser(world);
    const handle = await handleOf(await browser.open(await params(clientId)));
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(oauthKv(), (method, key) => (key.startsWith("transaction:") ? "throw" : undefined)),
    };
    const logs = captureLogs();
    const begun = await browser.open(await params(clientId));
    expect(await errorPageOf(begun)).toEqual({ status: 503, heading: "Sign-in is unavailable" });
    expect(begun.headers.has("Set-Cookie")).toBe(false);
    const answered = await browser.post({ handle, decision: "approve", publisher: "agent" });
    expect(await errorPageOf(answered)).toEqual({ status: 503, heading: "Sign-in is unavailable" });
    expect(logEvents(logs.lines)).toEqual([
      { event: "request.failed", error: "Error", host: "app" },
      { event: "request.failed", error: "Error", host: "app" },
    ]);
    world.env = { ...world.env, OAUTH_KV: oauthKv() };
    expect(await grantIds()).toEqual([]);
  });

  it("answers 500 after any other failure", async () => {
    const world = new World();
    const { clientId } = await register(world);
    vi.spyOn(OAuthAuthorizationServer.prototype, "getOAuthApi").mockImplementation(() => {
      throw new TypeError("thrown");
    });
    captureLogs();
    const response = await new Browser(world).open(await params(clientId));
    expect(await errorPageOf(response)).toEqual({ status: 500, heading: "Sign-in failed" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

// DATA-1 on the consent page: no handle, code, client value or error message reaches the logs.
describe("DATA-1: the consent page's logs", () => {
  it("logs closed values only, through every outcome", async () => {
    const world = new World();
    const MARKERS = {
      clientName: "CLIENT-NAME-MARKER",
      clientUri: "CLIENT-URI-MARKER",
      redirect: "REDIRECT-PATH-MARKER",
      state: "STATE-MARKER",
      challenge: "CHALLENGE-MARKER",
      kv: "KV-ERROR-MARKER",
      form: "FORM-MARKER",
    };
    const redirect = `http://127.0.0.1:33418/${MARKERS.redirect}`;
    const client = await register(world, {
      client_name: MARKERS.clientName,
      client_uri: `https://example.org/${MARKERS.clientUri}`,
      redirect_uris: [redirect],
    });
    const logs = captureLogs();
    const secrets: string[] = [];
    const browser = new Browser(world);
    const base = { redirect_uri: redirect, state: MARKERS.state };

    // Refusals before the page.
    await browser.open(
      await params(client.clientId, { ...base, resource: `https://${MARKERS.challenge}.example.org/` }),
    );
    await browser.open(await params(client.clientId, { ...base, code_challenge: null }));
    await browser.open(await params(`https://${APP_HOST}/${MARKERS.clientUri}`, base));
    await browser.open(await params(client.clientId, { redirect_uri: `https://${APP_HOST}/${MARKERS.redirect}` }));
    // A page, a bad publisher, a malformed form, Deny.
    const denyHandle = await handleOf(await browser.open(await params(client.clientId, base)));
    secrets.push(denyHandle);
    await browser.post({ handle: denyHandle, decision: "approve", publisher: MARKERS.form });
    await browser.post({ handle: denyHandle, decision: MARKERS.form });
    await browser.post({ handle: denyHandle, decision: "deny" });
    await browser.post({ handle: denyHandle, decision: "deny" });
    // An approval, and its code.
    const handle = await handleOf(await browser.open(await params(client.clientId, base)));
    secrets.push(handle, ...browser.cookies.values());
    const allowed = await browser.post({ handle, decision: "approve", publisher: "agent" });
    const code = stringAt(redirectQuery(allowed), "code");
    secrets.push(code, code.split(":")[2] ?? "");
    // A replacement that fails, and KV failing with a message.
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(
        oauthKv(),
        (method, key) => (method === "put" && key.startsWith("revoked:") ? "throw" : undefined),
        MARKERS.kv,
      ),
    };
    const failing = await handleOf(await browser.open(await params(client.clientId, base)));
    secrets.push(failing);
    await browser.post({ handle: failing, decision: "approve", publisher: "agent" });
    world.env = {
      ...world.env,
      OAUTH_KV: faulty(oauthKv(), (_method, key) => (key.startsWith("transaction:") ? "throw" : undefined), MARKERS.kv),
    };
    await browser.open(await params(client.clientId, base));
    world.env = { ...world.env, OAUTH_KV: oauthKv() };

    for (const line of logs.lines) {
      for (const marker of Object.values(MARKERS)) expect(line).not.toContain(marker);
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
    const events = logEvents(logs.lines);
    expect(new Set(events.map((event) => event.event))).toEqual(
      new Set(["consent.refused", "grant.created", "grant.revoke_failed", "request.failed"]),
    );
    expect(events.filter((event) => event.event === "consent.refused").map((event) => event.reason)).toEqual([
      "request_redirected",
      // The library refuses a public client's missing challenge before the router.
      "request_redirected",
      "client_on_deployment",
      "redirect_on_deployment",
      "publisher_invalid",
      "form_invalid",
      "denied",
      "transaction_invalid",
    ]);
  });
});
