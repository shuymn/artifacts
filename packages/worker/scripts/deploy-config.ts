/**
 * The checks and the merge of scripts/deploy.ts, without I/O, so that deploy.test.ts can test them (design.md section
 * 11). The deployment values may set only what wrangler.jsonc leaves out (DATA-2); their variables pass the Worker's
 * own parser (`parseConfig`, HOST-2), and no host may be a `localhost` name or carry a port (ACC-2).
 */
import { getNodeValue, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";

import {
  CONFIG_VARIABLES,
  isLocalhostName,
  parseConfig,
  type Config,
  type ConfigErrorCode,
  type ConfigVariable,
} from "../src/config.ts";

/** The build variable that holds the deployment values on Workers Builds, in the form of wrangler.deploy.jsonc. */
export const DEPLOY_VALUES_VARIABLE = "ARTIFACTS_DEPLOY_JSONC";
/** The gitignored file that holds the deployment values on the owner's machine. */
export const DEPLOY_VALUES_FILE = "wrangler.deploy.jsonc";

export type Json = { readonly [key: string]: unknown };

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSONC as wrangler reads it: JSON with comments and trailing commas. Undefined for anything else; `problem` then says
 * why, with the error's kind and offset only, never the text. Objects are built by `getNodeValue`, so a `__proto__` key
 * is an ordinary key, as with JSON.parse, never a prototype to inherit from.
 */
export function parseJsonc(text: string): { ok: true; value: unknown } | { ok: false; problem: string } {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  const [error] = errors;
  if (error !== undefined) {
    return { ok: false, problem: `is not valid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}` };
  }
  if (root === undefined) return { ok: false, problem: "is not valid JSONC: it holds no value" };
  return { ok: true, value: getNodeValue(root) };
}

/** The keys the deployment values may set; everything else comes from wrangler.jsonc. `account_id` is optional. */
const DEPLOY_KEYS: ReadonlySet<string> = new Set(["account_id", "routes", "d1_databases", "r2_buckets", "vars"]);

/** The variables the deployment values set: every configuration variable except `API_TOKENS`, a secret. */
export const DEPLOY_VARIABLES = CONFIG_VARIABLES.filter((variable) => variable !== "API_TOKENS");

const HOST_VARIABLES = ["APP_HOST", "API_HOST", "CONTENT_HOST_SUFFIX", "PUBLIC_HOST_SUFFIX"] as const;

/** What each variable holds, for the message when the parser finds it `invalid`. */
const FORMS: Record<ConfigVariable, string> = {
  APP_HOST: "a lowercase host name, such as artifacts.example.com",
  API_HOST: "a lowercase host name, such as artifacts-api.example.com",
  CONTENT_HOST_SUFFIX: "a lowercase suffix of the form -label.domain or .domain",
  PUBLIC_HOST_SUFFIX: "a lowercase suffix of the form -label.domain or .domain",
  ARCHIVE_AFTER_DAYS: "a whole number of days from 1 to 36500",
  ACCESS_TEAM_DOMAIN: "the Access team domain, such as team.cloudflareaccess.com",
  ACCESS_APP_AUD: "the app Access application's AUD tag",
  ACCESS_CONTENT_AUD: "the content Access application's AUD tag",
  API_TOKENS: "a JSON object of token names and hashes",
};

/** The parser's refusals in words; the variable it names leads the message. */
const REFUSALS: Record<Exclude<ConfigErrorCode, "invalid">, string> = {
  missing: "is empty",
  public_suffix_under_content:
    "ends with CONTENT_HOST_SUFFIX, so the content Access application would cover public hosts (HOST-2)",
  host_under_suffix: "is a host under CONTENT_HOST_SUFFIX or PUBLIC_HOST_SUFFIX (HOST-2)",
  label_too_long: "makes an artifact host's first label longer than 63 characters (HOST-2)",
  localhost_mixed: "mix localhost names with other hosts (HOST-2)",
  hosts_not_distinct: "is the same host as APP_HOST",
  access_aud_shared: "is the AUD of the app Access application; the content application needs its own",
};

function configProblem(code: ConfigErrorCode, variable: ConfigVariable | undefined): string {
  const subject = variable === undefined ? "vars" : `vars.${variable}`;
  if (code === "invalid") return `${subject} is not ${variable === undefined ? "valid" : FORMS[variable]}`;
  return `${subject} ${REFUSALS[code]}`;
}

/** Each variable's own problems; the Worker's parser runs only when there are none. */
function variableProblems(vars: Json): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(vars)) {
    if (key === "API_TOKENS") {
      problems.push("vars.API_TOKENS is a secret: put it with `wrangler secret put API_TOKENS`, never in these values");
    } else if (!DEPLOY_VARIABLES.some((variable) => variable === key)) {
      problems.push(`vars.${key} is not a variable of the Worker`);
    }
  }
  for (const variable of DEPLOY_VARIABLES) {
    const value = vars[variable];
    if (value === undefined) problems.push(`vars.${variable} is missing`);
    else if (value === "") problems.push(`vars.${variable} is empty`);
    else if (typeof value !== "string" && !(variable === "ARCHIVE_AFTER_DAYS" && typeof value === "number")) {
      problems.push(`vars.${variable} is not a string`);
    }
  }
  for (const variable of HOST_VARIABLES) {
    const value = vars[variable];
    if (typeof value !== "string" || value === "") continue;
    // ACC-2: Access is verified unless every host is a localhost name, so a deployment has none.
    const host = variable.endsWith("_SUFFIX") ? `x${value}` : value;
    if (isLocalhostName(host))
      problems.push(`vars.${variable} is a localhost name, which is for local development only`);
    else if (value.includes(":")) problems.push(`vars.${variable} has a port; a deployment serves HTTPS on 443`);
  }
  return problems;
}

/** A binding's entry from the deployment values, merged into the matching entry of wrangler.jsonc. */
type BindingSpec = {
  readonly key: "d1_databases" | "r2_buckets";
  readonly fields: Readonly<Record<string, RegExp>>;
};

const D1: BindingSpec = {
  key: "d1_databases",
  fields: {
    // The name D1 shows and Time Travel takes; the ID is what the Worker binds.
    database_name: /^\S+$/,
    database_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  },
};
const R2: BindingSpec = {
  key: "r2_buckets",
  fields: { bucket_name: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/ },
};

function bindingNames(base: Json, key: string): string[] {
  const entries = base[key];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry["binding"] === "string" ? [entry["binding"]] : [],
  );
}

/** The fields `spec` names for each binding, by binding name; problems are added to `problems`. */
function bindingValues(base: Json, values: Json, spec: BindingSpec, problems: string[]): Map<string, Json> {
  const found = new Map<string, Json>();
  const bindings = bindingNames(base, spec.key);
  const entries = values[spec.key];
  if (entries === undefined) {
    problems.push(`${spec.key} is missing; it names the resource of ${bindings.join(", ")}`);
    return found;
  }
  if (!Array.isArray(entries)) {
    problems.push(`${spec.key} is not a list`);
    return found;
  }
  entries.forEach((entry: unknown, index) => {
    const at = `${spec.key}[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const binding = entry["binding"];
    if (typeof binding !== "string" || !bindings.includes(binding)) {
      problems.push(`${at}.binding is not a binding of wrangler.jsonc (${bindings.join(", ")})`);
      return;
    }
    if (found.has(binding)) {
      problems.push(`${at} names ${binding} a second time`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "binding" && !(key in spec.fields)) problems.push(`${at}.${key} belongs in wrangler.jsonc`);
    }
    for (const [field, form] of Object.entries(spec.fields)) {
      const value = entry[field];
      if (value === undefined) problems.push(`${at}.${field} is missing`);
      else if (value === "") problems.push(`${at}.${field} is empty`);
      else if (typeof value !== "string" || !form.test(value)) problems.push(`${at}.${field} is not a ${field}`);
    }
    found.set(binding, Object.fromEntries(Object.keys(spec.fields).map((field) => [field, entry[field]])));
  });
  for (const binding of bindings) {
    if (!found.has(binding)) problems.push(`${spec.key} has no entry for ${binding}`);
  }
  return found;
}

const TARGETS = ["app", "api", "content", "public"] as const;
type Target = (typeof TARGETS)[number];

const TARGET_NAMES: Record<Target, string> = {
  app: "APP_HOST",
  api: "API_HOST",
  content: "the content hosts (CONTENT_HOST_SUFFIX)",
  public: "the public hosts (PUBLIC_HOST_SUFFIX)",
};

const ROUTE_KEYS: ReadonlySet<string> = new Set(["pattern", "custom_domain", "zone_name", "zone_id"]);

/**
 * The host classes a route serves, or the problem with it. A Custom Domain is the app or API host itself. A route is
 * `<host>/*`: the app or API host, `*` and a suffix, or `*.<domain>` on a domain that holds a suffix and neither the app
 * nor the API host. Any other pattern would send hosts that are not this deployment's to the Worker, and on a domain the
 * owner shares with other services, take them over.
 */
function routeTargets(pattern: string, customDomain: boolean, config: Config): readonly Target[] | string {
  if (customDomain) {
    if (pattern === config.appHost) return ["app"];
    if (pattern === config.apiHost) return ["api"];
    return "is a Custom Domain other than APP_HOST and API_HOST";
  }
  const match = /^([^/]+)\/\*$/.exec(pattern);
  const host = match?.[1];
  if (host === undefined) return "is not of the form <host>/*";
  if (host === config.appHost) return ["app"];
  if (host === config.apiHost) return ["api"];
  if (host === `*${config.contentSuffix}`) return ["content"];
  if (host === `*${config.publicSuffix}`) return ["public"];
  if (host.startsWith("*.")) {
    const domain = host.slice(1);
    const targets = (["content", "public"] as const).filter((target) =>
      (target === "content" ? config.contentSuffix : config.publicSuffix).endsWith(domain),
    );
    if (config.appHost.endsWith(domain) || config.apiHost.endsWith(domain)) {
      return "also covers APP_HOST or API_HOST, so it would take every host of that domain";
    }
    if (targets.length > 0) return targets;
  }
  return "matches hosts that are not this deployment's";
}

function routeProblems(values: Json, config: Config | undefined): string[] {
  const routes = values["routes"];
  if (routes === undefined) return ["routes is missing"];
  if (!Array.isArray(routes) || routes.length === 0) return ["routes is not a non-empty list"];
  const problems: string[] = [];
  const covered = new Set<Target>();
  routes.forEach((route: unknown, index) => {
    const at = `routes[${index}]`;
    const entry: Json | undefined =
      typeof route === "string" ? { pattern: route } : isRecord(route) ? route : undefined;
    if (entry === undefined) {
      problems.push(`${at} is not a pattern or an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ROUTE_KEYS.has(key)) problems.push(`${at}.${key} is not a route setting`);
    }
    for (const key of ["zone_name", "zone_id"]) {
      if (key in entry && (typeof entry[key] !== "string" || entry[key] === "")) problems.push(`${at}.${key} is empty`);
    }
    const pattern = entry["pattern"];
    const customDomain = entry["custom_domain"];
    if (customDomain !== undefined && typeof customDomain !== "boolean") {
      problems.push(`${at}.custom_domain is not true or false`);
      return;
    }
    if (typeof pattern !== "string" || pattern === "") {
      problems.push(`${at}.pattern is empty`);
      return;
    }
    if (config === undefined) return;
    const targets = routeTargets(pattern, customDomain === true, config);
    if (typeof targets === "string") problems.push(`${at} (${pattern}) ${targets}`);
    else for (const target of targets) covered.add(target);
  });
  if (config !== undefined && problems.length === 0) {
    for (const target of TARGETS) {
      if (!covered.has(target)) problems.push(`routes: nothing routes ${TARGET_NAMES[target]}`);
    }
  }
  return problems;
}

export type DeployCheck =
  | { readonly ok: true; readonly merged: Json }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Checks the deployment values against wrangler.jsonc (`base`) and returns `base` with them merged in, or every problem
 * found. The variables are checked by `parseConfig` once each has a value; `API_TOKENS` is a secret that the values
 * never hold, so the parser sees an empty token list in its place.
 */
export function checkDeployValues(base: Json, values: unknown): DeployCheck {
  if (!isRecord(values)) return { ok: false, problems: ["the deployment values are not a JSON object"] };
  const problems: string[] = [];
  for (const key of Object.keys(values)) {
    if (!DEPLOY_KEYS.has(key)) problems.push(`${key} is not a deployment value; it belongs in wrangler.jsonc`);
  }
  const accountId = values["account_id"];
  if (accountId === "") problems.push("account_id is empty; set it or leave the key out");
  else if (accountId !== undefined && (typeof accountId !== "string" || !/^[0-9a-f]{32}$/.test(accountId))) {
    problems.push("account_id is not an account ID (32 hexadecimal characters)");
  }

  let config: Config | undefined;
  const vars = values["vars"];
  if (!isRecord(vars)) {
    problems.push(vars === undefined ? "vars is missing" : "vars is not an object");
  } else {
    const own = variableProblems(vars);
    problems.push(...own);
    if (own.length === 0) {
      const parsed = parseConfig({ ...vars, API_TOKENS: "{}" });
      if (parsed.ok) config = parsed.config;
      else problems.push(configProblem(parsed.code, parsed.variable));
    }
  }

  const databases = bindingValues(base, values, D1, problems);
  const buckets = bindingValues(base, values, R2, problems);
  problems.push(...routeProblems(values, config));
  if (problems.length > 0 || config === undefined || !isRecord(vars)) return { ok: false, problems };

  const { $schema: _schema, ...rest } = base;
  const merge = (key: string, found: Map<string, Json>) =>
    (Array.isArray(base[key]) ? (base[key] as unknown[]) : []).map((entry) =>
      isRecord(entry) ? { ...entry, ...found.get(String(entry["binding"])) } : entry,
    );
  return {
    ok: true,
    merged: {
      ...rest,
      ...(accountId === undefined ? {} : { account_id: accountId }),
      routes: values["routes"],
      vars,
      d1_databases: merge(D1.key, databases),
      r2_buckets: merge(R2.key, buckets),
    },
  };
}
