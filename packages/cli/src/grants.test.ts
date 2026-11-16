// `grants` and `revoke <grant>` (design.md section 9): with ARTIFACTS_TOKEN against stubbed answers, and with the
// stored login against the local stand-in for the API host (login-test-support.ts). The CLI against the Worker itself
// is login-e2e.test.ts.
import { chmod, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { Fetch } from "./api.ts";
import { helpText } from "./cli.ts";
import { Credentials, StandIn } from "./login-test-support.ts";
import { cli, TOKEN } from "./test-support.ts";

const API = "https://artifacts-api.example.com";
const ENV = { ARTIFACTS_API_URL: API, ARTIFACTS_TOKEN: TOKEN };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The newer of two grants, with every field. Its ID sorts after the older one's, so only the server's order holds. */
const NEWER = {
  id: "zNewerGrant-0001",
  publisher: "example-agent",
  client_id: "https://agent.example.com/oauth/client.json",
  client_name: "Example Agent",
  redirect_host: "localhost",
  resource: `${API}/mcp`,
  created_at: "2026-11-17T09:00:00.000Z",
  expires_at: "2026-12-17T09:00:00.000Z",
};

/** A grant made before the consent page stored its metadata, whose code is not exchanged yet. */
const OLDER = {
  id: "aOlderGrant_0002",
  publisher: null,
  client_id: "c1i3nt",
  client_name: null,
  redirect_host: null,
  resource: null,
  created_at: "2026-11-16T09:00:00.000Z",
  expires_at: null,
};

/** A fetch answering `answer` to every request and recording `METHOD url authorization`. */
function answering(answer: () => Promise<Response>): { fetch: Fetch; seen: string[] } {
  const seen: string[] = [];
  const fetch: Fetch = (input, init) => {
    seen.push(`${init.method ?? "GET"} ${input} ${new Headers(init.headers).get("Authorization")}`);
    return answer();
  };
  return { fetch, seen };
}

const live: Fetch = (input, init) => globalThis.fetch(input, init);

/** A stand-in with a stored login of one grant, and another grant of another client. */
async function signedIn() {
  const standIn = await StandIn.start();
  const credentials = await Credentials.create();
  const current = standIn.issue();
  const other = standIn.issue();
  await credentials.put(standIn.origin, { client: current.client, tokens: current.tokens });
  return { standIn, credentials, current, other, env: credentials.env(standIn) };
}

describe("grants", () => {
  it("lists each grant's fields in the server's order, newest first, and --json prints the API's JSON", async () => {
    const { fetch, seen } = answering(async () => json(200, { grants: [NEWER, OLDER] }));
    expect(await cli(["grants"], { env: ENV, fetch })).toEqual({
      status: 0,
      stdout: [
        "zNewerGrant-0001  publisher: example-agent",
        "  client: Example Agent (https://agent.example.com/oauth/client.json)",
        `  redirect host: localhost  resource: ${API}/mcp`,
        "  created: 2026-11-17T09:00:00.000Z  expires: 2026-12-17T09:00:00.000Z",
        "aOlderGrant_0002  publisher: -",
        "  client: c1i3nt",
        "  redirect host: -  resource: -",
        "  created: 2026-11-16T09:00:00.000Z  expires: -",
        "",
      ].join("\n"),
      stderr: "",
    });
    const asJson = await cli(["grants", "--json"], { env: ENV, fetch });
    expect(asJson).toEqual({
      status: 0,
      stdout: `${JSON.stringify({ grants: [NEWER, OLDER] }, null, 2)}\n`,
      stderr: "",
    });
    expect(seen).toEqual([`GET ${API}/v1/grants Bearer ${TOKEN}`, `GET ${API}/v1/grants Bearer ${TOKEN}`]);
  });

  it("escapes control characters and line separators a client names itself with, keeping each field one line", async () => {
    const named = { ...OLDER, client_name: "Agent\u001b[2K\nHidden " };
    const { fetch } = answering(async () => json(200, { grants: [named] }));
    const ran = await cli(["grants"], { env: ENV, fetch });
    expect(ran.status).toBe(0);
    expect(ran.stdout.split("\n")[1]).toBe("  client: Agent\\u001b[2K\\u000aHidden\\u2028 (c1i3nt)");
    expect(ran.stdout.split("\n")).toHaveLength(5);
  });

  it("prints nothing for an empty listing, and an empty list with --json", async () => {
    const { fetch } = answering(async () => json(200, { grants: [] }));
    expect(await cli(["grants"], { env: ENV, fetch })).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(await cli(["grants", "--json"], { env: ENV, fetch })).toEqual({
      status: 0,
      stdout: `${JSON.stringify({ grants: [] }, null, 2)}\n`,
      stderr: "",
    });
  });

  it.each([
    ["IDs alone", { grants: [NEWER.id] }],
    ["a grant without expires_at", { grants: [{ ...NEWER, expires_at: undefined }] }],
    ["no grants", {}],
  ])("refuses a listing of %s as a shape it does not know", async (_name, body) => {
    const { fetch } = answering(async () => json(200, body));
    expect(await cli(["grants"], { env: ENV, fetch })).toEqual({
      status: 1,
      stdout: "",
      stderr: "artifacts: the API answered in a shape this CLI does not know\n",
    });
  });
});

describe("revoke", () => {
  it("revokes the grant with DELETE /v1/grants/{id} and says so", async () => {
    const { fetch, seen } = answering(async () => new Response(null, { status: 204 }));
    expect(await cli(["revoke", NEWER.id], { env: ENV, fetch })).toEqual({
      status: 0,
      stdout: `revoked ${NEWER.id}\n`,
      stderr: "",
    });
    expect(seen).toEqual([`DELETE ${API}/v1/grants/${NEWER.id} Bearer ${TOKEN}`]);
  });

  it.each<[string, () => Promise<Response>, string]>([
    [
      "a 404: no such grant, or one too new to be listed",
      async () => json(404, { error: { code: "not_found", message: "no such grant" } }),
      `not_found: no grant ${NEWER.id} is listed; artifacts grants lists the grants, and one made moments ago may ` +
        "not be listed yet",
    ],
    [
      "a 503: run it again",
      async () => json(503, { error: { code: "unavailable", message: "the service is unavailable; try again" } }),
      `unavailable: the revocation may not have completed; run artifacts revoke ${NEWER.id} again`,
    ],
    [
      "a 503 from something in between: run it again",
      async () => new Response("<html>bad gateway</html>", { status: 503 }),
      `http_503: the revocation may not have completed; run artifacts revoke ${NEWER.id} again`,
    ],
    [
      "a 500",
      async () => json(500, { error: { code: "internal", message: "something failed" } }),
      "internal: something failed",
    ],
    [
      "a 200, which does not confirm it",
      async () => json(200, {}),
      "the API answered 200 instead of 204, so the revocation is not confirmed",
    ],
    [
      "no answer",
      async () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })),
      "no answer from the API (ECONNRESET)",
    ],
  ])("fails after %s", async (_name, answer, message) => {
    const { fetch } = answering(answer);
    expect(await cli(["revoke", NEWER.id], { env: ENV, fetch })).toEqual({
      status: 1,
      stdout: "",
      stderr: `artifacts: ${message}\n`,
    });
  });
});

describe("the command line", () => {
  it.each([
    [["grants", "extra"], "wrong number of arguments; usage: artifacts grants"],
    [["grants", "--archived", "only"], "grants does not take --archived"],
    [["revoke"], "wrong number of arguments; usage: artifacts revoke <grant>"],
    [["revoke", NEWER.id, "--json"], "revoke does not take --json"],
    [["revoke", "short"], "a grant ID is 16 characters of A-Z, a-z, 0-9, - and _"],
    [["revoke", "../v1/artifacts/"], "a grant ID is 16 characters of A-Z, a-z, 0-9, - and _"],
    // An ID that starts with "-" reads as options unless it follows "--".
    [["revoke", "-jHGD70yQ2ze0Ad6"], "after '--'"],
  ])("%j is a usage error, and nothing is sent", async (argv, message) => {
    const { fetch, seen } = answering(async () => new Response(null, { status: 204 }));
    const ran = await cli(argv, { env: ENV, fetch });
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain(message);
    expect(seen).toEqual([]);
  });

  it("takes a grant ID that starts with - after --", async () => {
    const { fetch, seen } = answering(async () => new Response(null, { status: 204 }));
    expect(await cli(["revoke", "--", "-jHGD70yQ2ze0Ad6"], { env: ENV, fetch })).toEqual({
      status: 0,
      stdout: "revoked -jHGD70yQ2ze0Ad6\n",
      stderr: "",
    });
    expect(seen).toEqual([`DELETE ${API}/v1/grants/-jHGD70yQ2ze0Ad6 Bearer ${TOKEN}`]);
  });

  it("offers grants and revoke on every platform, Windows included", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const help = helpText(platform);
      expect(help).toContain("\n  grants  ");
      expect(help).toContain("\n  revoke <grant>  ");
    }
    expect(helpText("win32")).not.toContain("\n  login  ");
  });
});

describe("the credential", () => {
  it.each(["linux", "win32"] as const)(
    "on %s is ARTIFACTS_TOKEN when it is set; the stored login is not read, even for its own grant",
    async (platform) => {
      const { credentials, current, env } = await signedIn();
      // A file the CLI would refuse if it read it.
      await chmod(credentials.file, 0o644);
      const tokenEnv = { ...env, ARTIFACTS_API_URL: API, ARTIFACTS_TOKEN: TOKEN };
      const { fetch, seen } = answering(async () =>
        seen.at(-1)?.startsWith("GET") === true ? json(200, { grants: [] }) : new Response(null, { status: 204 }),
      );
      expect(await cli(["grants"], { env: tokenEnv, fetch, platform })).toMatchObject({ status: 0, stderr: "" });
      expect(await cli(["revoke", "--", current.grant], { env: tokenEnv, fetch, platform })).toEqual({
        status: 0,
        stdout: `revoked ${current.grant}\n`,
        stderr: "",
      });
      expect(seen).toEqual([
        `GET ${API}/v1/grants Bearer ${TOKEN}`,
        `DELETE ${API}/v1/grants/${current.grant} Bearer ${TOKEN}`,
      ]);
    },
  );

  it("on Windows without ARTIFACTS_TOKEN names only it, for both commands", async () => {
    const { current, env } = await signedIn();
    for (const argv of [["grants"], ["revoke", "--", current.grant]]) {
      expect(await cli(argv, { env, fetch: live, platform: "win32" })).toEqual({
        status: 1,
        stdout: "",
        stderr: "artifacts: set ARTIFACTS_TOKEN to an API token\n",
      });
    }
  });

  it("is the stored login otherwise: it lists, and revokes another grant without changing the file", async () => {
    const { standIn, credentials, current, other, env } = await signedIn();
    const before = await readFile(credentials.file, "utf8");
    const authorizations: (string | null)[] = [];
    const recording: Fetch = (input, init) => {
      authorizations.push(new Headers(init.headers).get("Authorization"));
      return live(input, init);
    };
    const listed = await cli(["grants"], { env, fetch: recording });
    expect(listed.status).toBe(0);
    // The other grant is the newer one.
    expect(listed.stdout.split("\n").filter((line) => !line.startsWith(" "))).toEqual([
      `${other.grant}  publisher: -`,
      `${current.grant}  publisher: -`,
      "",
    ]);
    expect(await cli(["revoke", "--", other.grant], { env, fetch: recording })).toEqual({
      status: 0,
      stdout: `revoked ${other.grant}\n`,
      stderr: "",
    });
    expect(standIn.requests).toEqual(["GET /v1/grants", `DELETE /v1/grants/${other.grant}`]);
    expect(authorizations).toEqual([`Bearer ${current.tokens.access_token}`, `Bearer ${current.tokens.access_token}`]);
    expect([...standIn.grants.keys()]).toEqual([current.grant]);
    expect(await readFile(credentials.file, "utf8")).toBe(before);
  });

  it("says so when it revokes the stored login's own grant; the file stays, and the next command names login", async () => {
    const { standIn, credentials, current, env } = await signedIn();
    const before = await readFile(credentials.file, "utf8");
    expect(await cli(["revoke", "--", current.grant], { env, fetch: live })).toEqual({
      status: 0,
      stdout: `revoked ${current.grant}\n`,
      stderr: "artifacts: that was the stored login's grant, which has ended; sign in again with artifacts login\n",
    });
    expect(await readFile(credentials.file, "utf8")).toBe(before);
    expect(await cli(["list"], { env, fetch: live })).toEqual({
      status: 1,
      stdout: "",
      stderr: "artifacts: the server no longer accepts the stored login; sign in with artifacts login\n",
    });
    expect(standIn.requests).toEqual([
      `DELETE /v1/grants/${current.grant}`,
      "GET /v1/artifacts",
      "GET /.well-known/oauth-authorization-server",
      "POST /oauth/token refresh_token",
    ]);
    // logout then removes the login the server refuses.
    expect((await cli(["logout"], { env, fetch: live })).stdout).toBe(
      `the server no longer accepts the stored login for ${standIn.origin}; removed it\n`,
    );
    expect((await credentials.read())[standIn.origin]?.tokens).toBeNull();
  });
});

/** Every failure the server or the network can answer, each carrying `echo`. */
const failures = (echo: string): (() => Promise<Response>)[] => [
  async () => json(401, { error: { code: "unauthorized", message: echo } }),
  async () => json(404, { error: { code: "not_found", message: echo } }),
  async () => json(503, { error: { code: "unavailable", message: echo } }),
  async () => json(500, { error: { code: "internal", message: echo } }),
  async () => new Response(echo, { status: 502 }),
  async () => Promise.reject(new TypeError(`fetch failed ${echo}`, { cause: { code: "ECONNRESET", message: echo } })),
];

describe("no output carries a token", () => {
  it("with ARTIFACTS_TOKEN, whatever the server echoes", async () => {
    let outputs = "";
    for (const failure of failures(TOKEN)) {
      for (const argv of [["grants"], ["grants", "--json"], ["revoke", NEWER.id]]) {
        const ran = await cli(argv, { env: ENV, fetch: answering(failure).fetch });
        expect(ran.status).toBe(1);
        outputs += ran.stdout + ran.stderr;
      }
    }
    expect(outputs).not.toContain(TOKEN);
    expect(outputs).toContain("[token]");
  });

  it("with the stored login, whatever the server echoes", async () => {
    const { standIn, credentials, current, env } = await signedIn();
    const stored = await credentials.storedTokens();
    let outputs = "";
    for (const [status, code] of [
      [404, "not_found"],
      [503, "unavailable"],
      [500, "internal"],
    ] as const) {
      standIn.override = ({ path }) =>
        path.startsWith("/v1/grants") ? { status, body: { error: { code, message: stored.join(" ") } } } : undefined;
      for (const argv of [["grants"], ["revoke", "--", current.grant]]) {
        const ran = await cli(argv, { env, fetch: live });
        expect(ran.status).toBe(1);
        outputs += ran.stdout + ran.stderr;
      }
    }
    standIn.override = () => undefined;
    for (const argv of [["grants"], ["grants", "--json"], ["revoke", "--", current.grant]]) {
      const ran = await cli(argv, { env, fetch: live });
      expect(ran.status).toBe(0);
      outputs += ran.stdout + ran.stderr;
    }
    expect(stored).toHaveLength(2);
    for (const token of stored) expect(outputs).not.toContain(token);
    expect(outputs).toContain("[token]");
  });
});
