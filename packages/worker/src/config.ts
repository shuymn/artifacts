/**
 * The Worker's configuration (design.md sections 1, 5, 7 and 11). `parseConfig` holds every check once, so the Worker and
 * the deployment script refuse the same values (HOST-2, ACC-2). It uses no Workers-only API.
 */
import { ID_LENGTH } from "./id.ts";
import { parseApiTokens, type ApiToken } from "./tokens.ts";

export const CONFIG_VARIABLES = [
  "APP_HOST",
  "API_HOST",
  "CONTENT_HOST_SUFFIX",
  "PUBLIC_HOST_SUFFIX",
  "ARCHIVE_AFTER_DAYS",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_APP_AUD",
  "ACCESS_CONTENT_AUD",
  "API_TOKENS",
] as const;
export type ConfigVariable = (typeof CONFIG_VARIABLES)[number];

export const CONFIG_ERRORS = [
  // A variable is absent or empty.
  "missing",
  // A variable does not have its form.
  "invalid",
  // HOST-2: the content Access wildcard (`*` + content suffix) would cover public hosts.
  "public_suffix_under_content",
  // HOST-2: the app or API host would be an artifact host of a suffix, under its Access wildcard or route.
  "host_under_suffix",
  // HOST-2: an artifact label (ID + the suffix's first label part) would exceed the 63 characters of a DNS label.
  "label_too_long",
  // HOST-2, ACC-2: some hosts are `localhost` names and others are not.
  "localhost_mixed",
  // The app and API hosts are the same host, so one of them could never be reached.
  "hosts_not_distinct",
  // The app and content Access applications share an audience, so a content JWT would open the gallery.
  "access_aud_shared",
] as const;
export type ConfigErrorCode = (typeof CONFIG_ERRORS)[number];

export type AccessConfig = { readonly teamDomain: string; readonly appAud: string; readonly contentAud: string };

export type Config = {
  readonly appHost: string;
  readonly apiHost: string;
  readonly contentSuffix: string;
  readonly publicSuffix: string;
  /** `http` when every host is a `localhost` name (local development), `https` otherwise. */
  readonly scheme: "http" | "https";
  readonly archiveAfterMs: number;
  /** ACC-2: null only when every configured host is a `localhost` name; Access is then not verified. */
  readonly access: AccessConfig | null;
  /**
   * OAuth (design.md section 7) is off when every configured host is a `localhost` name: the library takes plain `http`
   * only on loopback hosts, not on names under `localhost`.
   */
  readonly oauth: boolean;
  /** Empty when `API_TOKENS` is missing or `{}`: every API token is then refused (TOK-1). */
  readonly tokens: readonly ApiToken[];
};

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly code: ConfigErrorCode; readonly variable?: ConfigVariable };

export type ConfigInput = { readonly [K in ConfigVariable]?: unknown };

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const PORT = "(?::[1-9][0-9]{0,4})?";
/** A lowercase host name with an optional port, as `URL.host` gives it. */
const HOST = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*${PORT}$`);
/** `-label.domain` or `.domain`, lowercase; the label part may not end with a hyphen. */
const SUFFIX = new RegExp(`^(-[a-z0-9-]*[a-z0-9])?\\.${DNS_LABEL}(?:\\.${DNS_LABEL})*${PORT}$`);
/** The longest label part of a suffix: an artifact label is the ID followed by it, at most 63 characters. */
const MAX_SUFFIX_LABEL = 63 - ID_LENGTH;
/** Access AUD tags: printable ASCII without spaces. */
const AUD = /^[\x21-\x7e]{1,256}$/;
/** ARCHIVE_AFTER_DAYS: a canonical positive decimal, at most 100 years. */
const MAX_ARCHIVE_DAYS = 36_500;
const DAY_MS = 86_400_000;

const failure = (code: ConfigErrorCode, variable?: ConfigVariable): ConfigResult =>
  variable === undefined ? { ok: false, code } : { ok: false, code, variable };

/** A string variable's value, or the reason it has none. */
function text(input: ConfigInput, variable: ConfigVariable): string | ConfigResult {
  const value = input[variable];
  if (value === undefined || value === "") return failure("missing", variable);
  if (typeof value !== "string") return failure("invalid", variable);
  return value;
}

function hostnameOf(host: string): string {
  return host.replace(/:[0-9]+$/, "");
}

/** ACC-2: a `localhost` name is `localhost` or a name under it, with any port. */
export function isLocalhostName(host: string): boolean {
  const name = hostnameOf(host);
  return name === "localhost" || name.endsWith(".localhost");
}

function archiveDays(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isInteger(value) && value >= 1 && value <= MAX_ARCHIVE_DAYS ? value : undefined;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) return undefined;
  const days = Number(value);
  return days <= MAX_ARCHIVE_DAYS ? days : undefined;
}

/** Accepts `team.cloudflareaccess.com` or `https://team.cloudflareaccess.com/`, as a host name. */
function teamDomain(value: string): string | undefined {
  const host = value.replace(/^https:\/\//, "").replace(/\/+$/, "");
  return HOST.test(host) && hostnameOf(host) === host ? host : undefined;
}

export function parseConfig(input: ConfigInput): ConfigResult {
  const appHost = text(input, "APP_HOST");
  if (typeof appHost !== "string") return appHost;
  if (!HOST.test(appHost)) return failure("invalid", "APP_HOST");
  const apiHost = text(input, "API_HOST");
  if (typeof apiHost !== "string") return apiHost;
  if (!HOST.test(apiHost)) return failure("invalid", "API_HOST");
  const contentSuffix = text(input, "CONTENT_HOST_SUFFIX");
  if (typeof contentSuffix !== "string") return contentSuffix;
  if (!SUFFIX.test(contentSuffix)) return failure("invalid", "CONTENT_HOST_SUFFIX");
  const publicSuffix = text(input, "PUBLIC_HOST_SUFFIX");
  if (typeof publicSuffix !== "string") return publicSuffix;
  if (!SUFFIX.test(publicSuffix)) return failure("invalid", "PUBLIC_HOST_SUFFIX");

  if (appHost === apiHost) return failure("hosts_not_distinct", "API_HOST");
  for (const [suffix, variable] of [
    [contentSuffix, "CONTENT_HOST_SUFFIX"],
    [publicSuffix, "PUBLIC_HOST_SUFFIX"],
  ] as const) {
    if (suffix.indexOf(".") > MAX_SUFFIX_LABEL) return failure("label_too_long", variable);
    if (appHost.endsWith(suffix)) return failure("host_under_suffix", "APP_HOST");
    if (apiHost.endsWith(suffix)) return failure("host_under_suffix", "API_HOST");
  }
  if (publicSuffix.endsWith(contentSuffix)) return failure("public_suffix_under_content", "PUBLIC_HOST_SUFFIX");

  const local = [appHost, apiHost, `x${contentSuffix}`, `x${publicSuffix}`].map(isLocalhostName);
  if (local.some(Boolean) && !local.every(Boolean)) return failure("localhost_mixed");
  const isLocal = local.every(Boolean);

  if (input.ARCHIVE_AFTER_DAYS === undefined || input.ARCHIVE_AFTER_DAYS === "") {
    return failure("missing", "ARCHIVE_AFTER_DAYS");
  }
  const days = archiveDays(input.ARCHIVE_AFTER_DAYS);
  if (days === undefined) return failure("invalid", "ARCHIVE_AFTER_DAYS");

  let access: AccessConfig | null = null;
  if (!isLocal) {
    const team = text(input, "ACCESS_TEAM_DOMAIN");
    if (typeof team !== "string") return team;
    const host = teamDomain(team);
    if (host === undefined) return failure("invalid", "ACCESS_TEAM_DOMAIN");
    const appAud = text(input, "ACCESS_APP_AUD");
    if (typeof appAud !== "string") return appAud;
    if (!AUD.test(appAud)) return failure("invalid", "ACCESS_APP_AUD");
    const contentAud = text(input, "ACCESS_CONTENT_AUD");
    if (typeof contentAud !== "string") return contentAud;
    if (!AUD.test(contentAud)) return failure("invalid", "ACCESS_CONTENT_AUD");
    if (appAud === contentAud) return failure("access_aud_shared", "ACCESS_CONTENT_AUD");
    access = { teamDomain: host, appAud, contentAud };
  }

  // Optional (design.md section 7): a deployment turns API tokens off by deleting the secret or putting `{}`. Any other
  // value that is not a valid object, an empty one included, is refused, so a typo fails loudly.
  let tokens: readonly ApiToken[] = [];
  if (input.API_TOKENS !== undefined) {
    const parsedTokens = typeof input.API_TOKENS === "string" ? parseApiTokens(input.API_TOKENS) : undefined;
    if (parsedTokens === undefined) return failure("invalid", "API_TOKENS");
    tokens = parsedTokens;
  }

  return {
    ok: true,
    config: {
      appHost,
      apiHost,
      contentSuffix,
      publicSuffix,
      scheme: isLocal ? "http" : "https",
      archiveAfterMs: days * DAY_MS,
      access,
      oauth: !isLocal,
      tokens,
    },
  };
}
