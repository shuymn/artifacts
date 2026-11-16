// The deployment script (design.md section 11): the checks and merge of the deployment values (HOST-2, ACC-2, DATA-2,
// PL-2) and the order of its wrangler commands with wrangler stubbed. runner.test.ts covers the runner.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDeployValues, isRecord, parseJsonc, type Json } from "./deploy-config.ts";
import { deploy, type DeployIo } from "./deploy-run.ts";
import type { RunResult, TerminationSignal } from "./runner.ts";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJsonc(file: string): Json {
  const parsed = parseJsonc(readFileSync(join(WORKER, file), "utf8"));
  if (!parsed.ok || !isRecord(parsed.value)) throw new Error(`${file} is not a JSONC object`);
  return parsed.value;
}

const BASE = readJsonc("wrangler.jsonc");
const EXAMPLE = readJsonc("wrangler.deploy.example.jsonc");

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE_ID = "fedcba9876543210fedcba9876543210";
const DATABASE_ID = "00000000-0000-4000-8000-000000000000";

function setIn(target: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  if (Array.isArray(target)) {
    const copy: unknown[] = [...target];
    if (rest.length === 0 && value === undefined) copy.splice(Number(key), 1);
    else copy[Number(key)] = setIn(copy[Number(key)], rest, value);
    return copy;
  }
  const copy: Record<string, unknown> = isRecord(target) ? { ...target } : {};
  if (rest.length === 0 && value === undefined) delete copy[String(key)];
  else copy[String(key)] = setIn(copy[String(key)], rest, value);
  return copy;
}

/** A copy of `values` with the value at `path` replaced, or removed when `value` is undefined. */
function set(values: Json, path: readonly (string | number)[], value: unknown): Json {
  const copy = setIn(values, path, value);
  if (!isRecord(copy)) throw new Error("not an object");
  return copy;
}

/** The example's routes: Custom Domains for the app and API hosts, then the content and public routes. */
function exampleRoutes(): unknown[] {
  const routes = EXAMPLE["routes"];
  if (!Array.isArray(routes)) throw new Error("the example has no routes");
  return [...routes];
}

/** The committed example with its empty values filled: a complete deployment in the shared-domain layout. */
function filled(): Json {
  let values = set(EXAMPLE, ["account_id"], ACCOUNT);
  values = set(values, ["d1_databases", 0, "database_name"], "artifacts");
  values = set(values, ["d1_databases", 0, "database_id"], DATABASE_ID);
  values = set(values, ["r2_buckets", 0, "bucket_name"], "artifacts-files");
  values = set(values, ["vars", "ACCESS_TEAM_DOMAIN"], "team.cloudflareaccess.com");
  values = set(values, ["vars", "ACCESS_APP_AUD"], "a".repeat(64));
  return set(values, ["vars", "ACCESS_CONTENT_AUD"], "b".repeat(64));
}

/** The dedicated-domain layout of the example's comments. */
function dedicated(): Json {
  let values = set(filled(), ["vars", "CONTENT_HOST_SUFFIX"], "-p.example-content.net");
  values = set(values, ["vars", "PUBLIC_HOST_SUFFIX"], "-s.example-content.net");
  return set(
    values,
    ["routes"],
    [
      { pattern: "artifacts.example.com", custom_domain: true },
      { pattern: "artifacts-api.example.com", custom_domain: true },
      { pattern: "*.example-content.net/*", zone_name: "example-content.net" },
    ],
  );
}

/** Routes that replace route `index` of the example and are refused for their zone, with the problem. */
const ZONE_CASES = [
  [
    "a zone_name the host is not in",
    2,
    { pattern: "*-art.example.com/*", zone_name: "wrong.example.org" },
    "routes[2] (*-art.example.com) is not in the zone wrong.example.org",
  ],
  [
    "a zone_name that ends the host inside a label",
    2,
    { pattern: "*-art.example.com/*", zone_name: "art.example.com" },
    "routes[2] (*-art.example.com) is not in the zone art.example.com",
  ],
  [
    "a Custom Domain outside its zone_name",
    0,
    { pattern: "artifacts.example.com", custom_domain: true, zone_name: "example.org" },
    "routes[0] (artifacts.example.com) is not in the zone example.org",
  ],
  [
    "a zone_name of one label",
    2,
    { pattern: "*-art.example.com/*", zone_name: "com" },
    "routes[2].zone_name is not a domain name, such as example.com",
  ],
  [
    "a blank zone_id",
    2,
    { pattern: "*-art.example.com/*", zone_id: " " },
    "routes[2].zone_id is not a zone ID (32 lowercase hexadecimal characters)",
  ],
  [
    "a zone_id in uppercase",
    2,
    { pattern: "*-art.example.com/*", zone_id: ZONE_ID.toUpperCase() },
    "routes[2].zone_id is not a zone ID (32 lowercase hexadecimal characters)",
  ],
  [
    "both a zone_name and a zone_id",
    2,
    { pattern: "*-art.example.com/*", zone_name: "example.com", zone_id: ZONE_ID },
    "routes[2] sets both zone_name and zone_id; wrangler takes one of them",
  ],
] as const;

function problems(values: unknown): readonly string[] {
  const check = checkDeployValues(BASE, values);
  return check.ok ? [] : check.problems;
}

describe("checkDeployValues", () => {
  it("merges the deployment values into wrangler.jsonc", () => {
    const { $schema: _schema, ...base } = BASE;
    const values = filled();
    const check = checkDeployValues(BASE, values);
    expect(check.ok && check.merged).toEqual({
      ...base,
      account_id: ACCOUNT,
      routes: values["routes"],
      vars: values["vars"],
      d1_databases: [
        { binding: "DB", migrations_dir: "migrations", database_name: "artifacts", database_id: DATABASE_ID },
      ],
      r2_buckets: [{ binding: "FILES", bucket_name: "artifacts-files" }],
    });
  });

  it("accepts the dedicated-domain layout, string routes and no account_id", () => {
    expect(problems(dedicated())).toEqual([]);
    const values = set(set(filled(), ["account_id"], undefined), ["routes", 2], "*-art.example.com/*");
    const check = checkDeployValues(BASE, values);
    expect(check.ok && check.merged).not.toHaveProperty("account_id");
    expect(check.ok && check.merged["routes"]).toContain("*-art.example.com/*");
  });

  // The committed example holds placeholders only; deploying it unchanged is refused, naming each value to fill.
  it("refuses the committed example, naming each empty value", () => {
    expect(problems(EXAMPLE)).toEqual([
      "account_id is empty; set it or leave the key out",
      "vars.ACCESS_TEAM_DOMAIN is empty",
      "vars.ACCESS_APP_AUD is empty",
      "vars.ACCESS_CONTENT_AUD is empty",
      "d1_databases[0].database_name is empty",
      "d1_databases[0].database_id is empty",
      "r2_buckets[0].bucket_name is empty",
    ]);
  });

  // ACC-2: Access is skipped only when every host is a localhost name, so a deployment has none, and no port.
  it.each([
    ["APP_HOST", "app.localhost"],
    ["API_HOST", "localhost"],
    ["CONTENT_HOST_SUFFIX", "-art.localhost"],
    ["PUBLIC_HOST_SUFFIX", ".localhost"],
  ])("ACC-2: refuses a localhost name in %s", (variable, value) => {
    expect(problems(set(filled(), ["vars", variable], value))).toEqual([
      `vars.${variable} is a localhost name, which is for local development only`,
    ]);
  });

  it.each([
    ["APP_HOST", "artifacts.example.com:8443"],
    ["API_HOST", "artifacts-api.example.com:443"],
    ["CONTENT_HOST_SUFFIX", "-art.example.com:8443"],
    ["PUBLIC_HOST_SUFFIX", "-pub.example.com:8443"],
  ])("ACC-2: refuses a port in %s", (variable, value) => {
    expect(problems(set(filled(), ["vars", variable], value))).toEqual([
      `vars.${variable} has a port; a deployment serves HTTPS on 443`,
    ]);
  });

  it("ACC-2: refuses the local development values, naming each host", () => {
    let values = filled();
    for (const [variable, value] of [
      ["APP_HOST", "app.localhost:8787"],
      ["API_HOST", "api.localhost:8787"],
      ["CONTENT_HOST_SUFFIX", "-art.localhost:8787"],
      ["PUBLIC_HOST_SUFFIX", "-pub.localhost:8787"],
    ] as const) {
      values = set(values, ["vars", variable], value);
    }
    expect(problems(values)).toHaveLength(4);
    expect(
      problems(values).every((problem) => problem.endsWith("is a localhost name, which is for local development only")),
    ).toBe(true);
  });

  // HOST-2, PL-2: the Worker's own parser refuses what would weaken a boundary.
  it.each([
    [
      "a public suffix under the content suffix",
      ["PUBLIC_HOST_SUFFIX", "-x-art.example.com"],
      "vars.PUBLIC_HOST_SUFFIX ends with CONTENT_HOST_SUFFIX",
    ],
    ["the app host under a suffix", ["APP_HOST", `${"a".repeat(26)}-art.example.com`], "vars.APP_HOST is a host under"],
    ["the API host under a suffix", ["API_HOST", `${"a".repeat(26)}-pub.example.com`], "vars.API_HOST is a host under"],
    [
      "an artifact label over 63 characters",
      ["CONTENT_HOST_SUFFIX", `-${"a".repeat(37)}.example.com`],
      "longer than 63 characters",
    ],
    ["the same app and API host", ["API_HOST", "artifacts.example.com"], "vars.API_HOST is the same host as APP_HOST"],
    ["a shared Access AUD", ["ACCESS_CONTENT_AUD", "a".repeat(64)], "vars.ACCESS_CONTENT_AUD is the AUD of the app"],
    ["an uppercase host", ["APP_HOST", "Artifacts.example.com"], "vars.APP_HOST is not a lowercase host name"],
    [
      "a suffix without a domain",
      ["CONTENT_HOST_SUFFIX", "-art"],
      "vars.CONTENT_HOST_SUFFIX is not a lowercase suffix",
    ],
    ["a non-numeric archive age", ["ARCHIVE_AFTER_DAYS", "thirty"], "vars.ARCHIVE_AFTER_DAYS is not a whole number"],
    [
      "a team domain with a path",
      ["ACCESS_TEAM_DOMAIN", "https://team.cloudflareaccess.com/x"],
      "vars.ACCESS_TEAM_DOMAIN is not the Access team domain",
    ],
  ] as const)("HOST-2: refuses %s", (_name, [variable, value], message) => {
    const found = problems(set(filled(), ["vars", variable], value));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(message);
  });

  it.each([
    ["no vars", ["vars"], undefined, "vars is missing"],
    ["vars that are not an object", ["vars"], ["APP_HOST"], "vars is not an object"],
    ["a missing variable", ["vars", "ARCHIVE_AFTER_DAYS"], undefined, "vars.ARCHIVE_AFTER_DAYS is missing"],
    ["an empty variable", ["vars", "API_HOST"], "", "vars.API_HOST is empty"],
    ["a variable that is not a string", ["vars", "APP_HOST"], 1, "vars.APP_HOST is not a string"],
    // DATA-2: the token hashes are a secret, put with wrangler, never a plain variable.
    ["API_TOKENS as a variable", ["vars", "API_TOKENS"], "{}", "vars.API_TOKENS is a secret"],
    ["a variable the Worker does not read", ["vars", "DEBUG"], "1", "vars.DEBUG is not a variable of the Worker"],
    ["a key that belongs in wrangler.jsonc", ["workers_dev"], true, "workers_dev is not a deployment value"],
    ["a malformed account_id", ["account_id"], "<ACCOUNT_ID>", "account_id is not an account ID"],
    ["no D1 database", ["d1_databases"], undefined, "d1_databases is missing"],
    ["D1 databases that are not a list", ["d1_databases"], {}, "d1_databases is not a list"],
    ["a D1 entry that is not an object", ["d1_databases", 0], "DB", "d1_databases[0] is not an object"],
    [
      "a D1 database for another binding",
      ["d1_databases", 0, "binding"],
      "OTHER",
      "d1_databases[0].binding is not a binding",
    ],
    [
      "a D1 setting from wrangler.jsonc",
      ["d1_databases", 0, "migrations_dir"],
      "x",
      "d1_databases[0].migrations_dir belongs in wrangler.jsonc",
    ],
    [
      "a malformed database_id",
      ["d1_databases", 0, "database_id"],
      "not-a-uuid",
      "d1_databases[0].database_id is not a database_id",
    ],
    [
      "a missing database_name",
      ["d1_databases", 0, "database_name"],
      undefined,
      "d1_databases[0].database_name is missing",
    ],
    ["no R2 bucket for FILES", ["r2_buckets"], [], "r2_buckets has no entry for FILES"],
    [
      "a bucket name R2 refuses",
      ["r2_buckets", 0, "bucket_name"],
      "Files_Bucket",
      "r2_buckets[0].bucket_name is not a bucket_name",
    ],
  ] as const)("refuses %s", (_name, path, value, message) => {
    expect(problems(set(filled(), path, value))).toContainEqual(expect.stringContaining(message));
  });

  it("refuses a binding named twice", () => {
    const entry = { binding: "FILES", bucket_name: "artifacts-files" };
    expect(problems(set(filled(), ["r2_buckets"], [entry, entry]))).toEqual([
      "r2_buckets[1] names FILES a second time",
    ]);
  });

  it.each([null, [], "{}", 1])("refuses deployment values that are not an object: %j", (values) => {
    expect(problems(values)).toEqual(["the deployment values are not a JSON object"]);
  });

  // A route sends every host it matches to the Worker; on a shared domain, a broader one takes over the owner's other
  // services.
  it.each([
    ["no routes", undefined, "routes is missing"],
    ["an empty list", [], "routes is not a non-empty list"],
    ["routes that are not a list", "*-art.example.com/*", "routes is not a non-empty list"],
  ] as const)("refuses %s", (_name, routes, message) => {
    expect(problems(set(filled(), ["routes"], routes))).toEqual([message]);
  });

  // Each case adds one route to the example's.
  it.each([
    ["a route that is a number", 1, "routes[4] is not a pattern or an object"],
    [
      "an unknown route setting",
      { pattern: "artifacts.example.com/*", script: "x" },
      "routes[4].script is not a route setting",
    ],
    ["an empty zone_name", { pattern: "artifacts.example.com/*", zone_name: "" }, "routes[4].zone_name is empty"],
    ["a route twice", "*-pub.example.com/*", "routes[4] repeats routes[3] (*-pub.example.com/*)"],
    [
      "a custom_domain that is not a boolean",
      { pattern: "artifacts.example.com", custom_domain: "yes" },
      "routes[4].custom_domain is not true or false",
    ],
    ["an empty pattern", { pattern: "", zone_name: "example.com" }, "routes[4].pattern is empty"],
    [
      "a Custom Domain on another host",
      { pattern: "www.example.com", custom_domain: true },
      "is a Custom Domain other than APP_HOST and API_HOST",
    ],
    [
      "a Custom Domain on an artifact host",
      { pattern: `${"a".repeat(26)}-art.example.com`, custom_domain: true },
      "is a Custom Domain other than",
    ],
    ["a route on part of a host's paths", "*-art.example.com/v1/*", "is not of the form <host>/*"],
    ["a wildcard over the whole shared domain", "*.example.com/*", "also covers APP_HOST or API_HOST"],
    ["a wildcard without the suffix's hyphen", "*art.example.com/*", "matches hosts that are not this deployment's"],
    ["a wildcard on another domain", "*.example.org/*", "matches hosts that are not this deployment's"],
    ["a route for every host", "*/*", "matches hosts that are not this deployment's"],
  ] as const)("refuses %s", (_name, route, message) => {
    const routes = [...exampleRoutes(), route];
    const found = problems(set(filled(), ["routes"], routes));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(message);
  });

  it("accepts a zone_id, and a zone_name that is the host itself", () => {
    let values = set(filled(), ["routes", 2], { pattern: "*-art.example.com/*", zone_id: ZONE_ID });
    values = set(values, ["routes", 0, "zone_name"], "artifacts.example.com");
    expect(problems(values)).toEqual([]);
  });

  it("compares a zone_name without regard to case", () => {
    const values = set(filled(), ["routes", 2], { pattern: "*-art.example.com/*", zone_name: "Example.COM" });
    expect(problems(values)).toEqual([]);
  });

  // Cloudflare matches a route to its zone only at `wrangler deploy`, after the migrations have been applied.
  it.each(ZONE_CASES)("refuses %s", (_name, index, route, message) => {
    expect(problems(set(filled(), ["routes", index], route))).toEqual([message]);
  });

  it.each([
    [0, "routes: nothing routes APP_HOST"],
    [1, "routes: nothing routes API_HOST"],
    [2, "routes: nothing routes the content hosts (CONTENT_HOST_SUFFIX)"],
    [3, "routes: nothing routes the public hosts (PUBLIC_HOST_SUFFIX)"],
  ])("refuses routes without the host class of route %i", (index, message) => {
    const routes = exampleRoutes().filter((_, at) => at !== index);
    expect(problems(set(filled(), ["routes"], routes))).toEqual([message]);
  });
});

describe("parseJsonc", () => {
  it("reads comments, trailing commas and comment characters inside strings", () => {
    expect(parseJsonc('// head\n{ "a": "x // y", /* z */ "b": [1, 2,], }')).toEqual({
      ok: true,
      value: { a: "x // y", b: [1, 2] },
    });
  });

  it.each([["{ 'a': 1 }"], ['{ "a": 1 "b": 2 }'], ["{} {}"], [""], ["// only"]])(
    "refuses %j without quoting it",
    (text) => {
      const parsed = parseJsonc(text);
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.problem).toMatch(/^is not valid JSONC: (\w+ at offset \d+|it holds no value)$/);
    },
  );

  // DATA-2: a `__proto__` key is data. Taken as a prototype, a route list could inherit a valid route and be written out
  // empty.
  it("reads __proto__ as an ordinary key", () => {
    const parsed = parseJsonc('{ "__proto__": { "pattern": "artifacts.example.com" } }');
    expect(parsed.ok && isRecord(parsed.value) && Object.keys(parsed.value)).toEqual(["__proto__"]);
  });
});

function expectedCalls(config: string): string[][] {
  return [
    ["r2", "bucket", "info", "artifacts-files", "--config", config],
    ["d1", "migrations", "apply", "DB", "--remote", "--config", config],
    ["deploy", "--config", config],
  ];
}
type Call = { readonly args: readonly string[]; readonly config: unknown };

describe("deploy", () => {
  let dir: string;
  let lines: string[];
  let listeners: ((signal: TerminationSignal) => void)[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deploy-test-"));
    copyFileSync(join(WORKER, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
    lines = [];
    listeners = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the script with wrangler stubbed: each call records its arguments and the configuration it was given. */
  async function run(
    options: {
      env?: Record<string, string>;
      args?: string[];
      answer?: (call: Call, signal: AbortSignal) => Promise<RunResult>;
    } = {},
  ): Promise<{ status: number; calls: Call[] }> {
    const calls: Call[] = [];
    const io: DeployIo = {
      workerDir: dir,
      env: options.env ?? {},
      args: options.args ?? [],
      run: async (args, signal) => {
        const config = args[args.indexOf("--config") + 1] ?? "";
        const call = { args, config: JSON.parse(readFileSync(join(dir, config), "utf8")) as unknown };
        calls.push(call);
        return options.answer === undefined ? { ok: true } : options.answer(call, signal);
      },
      log: (line) => lines.push(line),
      onSignal: (listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    };
    return { status: await deploy(io), calls };
  }

  function writeValues(values: Json): void {
    writeFileSync(join(dir, "wrangler.deploy.jsonc"), JSON.stringify(values));
  }

  const files = () => readdirSync(dir).toSorted();

  it("checks the bucket, applies migrations, then deploys with the merged configuration, and removes it", async () => {
    writeValues(filled());
    const { status, calls } = await run();
    const config = calls[0]?.args.at(-1) ?? "";
    expect(config).toMatch(/^\.wrangler-deploy-[0-9a-f]{16}\.json$/);
    expect(calls.map((call) => call.args)).toEqual(expectedCalls(config));
    const check = checkDeployValues(BASE, filled());
    for (const call of calls) expect(call.config).toEqual(check.ok && check.merged);
    expect(status).toBe(0);
    expect(files()).toEqual(["wrangler.deploy.jsonc", "wrangler.jsonc"]);
    expect(listeners).toEqual([]);
  });

  it("reads the build variable when there is no file", async () => {
    const { status, calls } = await run({ env: { ARTIFACTS_DEPLOY_JSONC: JSON.stringify(dedicated()) } });
    expect(calls.map((call) => call.args[0])).toEqual(["r2", "d1", "deploy"]);
    expect(calls[2]?.config).toMatchObject({ vars: { CONTENT_HOST_SUFFIX: "-p.example-content.net" } });
    expect(status).toBe(0);
    expect(files()).toEqual(["wrangler.jsonc"]);
  });

  it.each([
    [
      "both sources",
      true,
      { ARTIFACTS_DEPLOY_JSONC: "{}" },
      "both ARTIFACTS_DEPLOY_JSONC and wrangler.deploy.jsonc are set",
    ],
    ["neither source", false, {}, "wrangler.deploy.jsonc is missing and ARTIFACTS_DEPLOY_JSONC is not set"],
    ["an empty build variable", false, { ARTIFACTS_DEPLOY_JSONC: "" }, "ARTIFACTS_DEPLOY_JSONC is not valid JSONC"],
  ])("refuses %s and runs nothing", async (_name, file, env, message) => {
    if (file) writeValues(filled());
    const { status, calls } = await run({ env });
    expect(status).toBe(1);
    expect(calls).toEqual([]);
    expect(lines).toContainEqual(expect.stringContaining(message));
  });

  it("names each problem of invalid values, runs nothing and writes no configuration", async () => {
    writeFileSync(join(dir, "wrangler.deploy.jsonc"), readFileSync(join(WORKER, "wrangler.deploy.example.jsonc")));
    const { status, calls } = await run();
    expect(status).toBe(1);
    expect(calls).toEqual([]);
    expect(lines[0]).toBe("deploy: refused; nothing was run");
    expect(lines.slice(1)).toEqual(problems(EXAMPLE).map((problem) => `  - wrangler.deploy.jsonc: ${problem}`));
    expect(files()).toEqual(["wrangler.deploy.jsonc", "wrangler.jsonc"]);
  });

  it.each(ZONE_CASES)("refuses %s before any wrangler command", async (_name, index, route, message) => {
    writeValues(set(filled(), ["routes", index], route));
    const { status, calls } = await run();
    expect([status, calls]).toEqual([1, []]);
    expect(lines).toEqual(["deploy: refused; nothing was run", `  - wrangler.deploy.jsonc: ${message}`]);
  });

  it("refuses arguments", async () => {
    writeValues(filled());
    const { status, calls } = await run({ args: ["--dry-run"] });
    expect([status, calls]).toEqual([1, []]);
  });

  it.each([
    ["the bucket check", "r2", ["r2"]],
    ["the migrations", "d1", ["r2", "d1"]],
    ["the deploy", "deploy", ["r2", "d1", "deploy"]],
  ])("stops when %s fails and removes the configuration", async (_name, failing, ran) => {
    writeValues(filled());
    const { status, calls } = await run({
      answer: async (call) => (call.args[0] === failing ? { ok: false, reason: "exited with code 1" } : { ok: true }),
    });
    expect(status).toBe(1);
    expect(calls.map((call) => call.args[0])).toEqual(ran);
    expect(files()).toEqual(["wrangler.deploy.jsonc", "wrangler.jsonc"]);
  });

  it("stops the running command on a signal, starts no other, and removes the configuration", async () => {
    writeValues(filled());
    let stopped = false;
    const { status, calls } = await run({
      answer: (call, signal) => {
        if (call.args[0] !== "d1") return Promise.resolve({ ok: true });
        // The migrations are running when the signal arrives; the runner stops them.
        queueMicrotask(() => listeners[0]?.("SIGTERM"));
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => {
            stopped = true;
            resolve({ ok: false, reason: "was stopped" });
          }),
        );
      },
    });
    expect(stopped).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(["r2", "d1"]);
    expect(status).toBe(143);
    expect(files()).toEqual(["wrangler.deploy.jsonc", "wrangler.jsonc"]);
    expect(listeners).toEqual([]);
  });

  it("removes the configuration when the runner throws", async () => {
    writeValues(filled());
    await expect(run({ answer: () => Promise.reject(new Error("boom")) })).rejects.toThrow("boom");
    expect(files()).toEqual(["wrangler.deploy.jsonc", "wrangler.jsonc"]);
    expect(listeners).toEqual([]);
  });
});
