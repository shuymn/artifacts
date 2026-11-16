/**
 * Configuration (design.md section 9): the API origin in `ARTIFACTS_API_URL`, and a credential: `ARTIFACTS_TOKEN` when
 * it is set, otherwise the login stored for that origin, which is never read while the token is set and never on
 * Windows. The token is checked for its form without being echoed, so no message can carry it.
 */
import { CliError } from "./errors.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

/** Where the credential of an API command comes from. */
export type CredentialSource = { readonly kind: "token"; readonly token: string } | { readonly kind: "login" };

export type Config = { readonly apiOrigin: string; readonly credential: CredentialSource };

/** `localhost`, a name under it, or a loopback address: the only hosts the token may travel to without TLS. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(hostname)
  );
}

/** Printable ASCII without spaces: what a bearer token can be; `art_` and 32 characters when generated. */
export const TOKEN_FORM = /^[\x21-\x7e]{1,512}$/;

/** Whether this platform keeps a stored login: not Windows, which has no file modes to check (decisions.md). */
export const storesLogin = (platform: NodeJS.Platform): boolean => platform !== "win32";

const SET_TOKEN = "set ARTIFACTS_TOKEN to an API token";
/** What to do without a credential where a login can be stored. */
export const SET_TOKEN_OR_SIGN_IN = `${SET_TOKEN}, or sign in with artifacts login`;

/** What to do without a credential, in the words of this platform. */
export const missingCredential = (platform: NodeJS.Platform): string =>
  storesLogin(platform) ? SET_TOKEN_OR_SIGN_IN : SET_TOKEN;

/** The API origin of `ARTIFACTS_API_URL`. */
export function readOrigin(env: Environment): string {
  const rawUrl = env.ARTIFACTS_API_URL;
  if (rawUrl === undefined || rawUrl === "") {
    throw new CliError("set ARTIFACTS_API_URL to the API origin, such as https://artifacts-api.example.com");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliError("ARTIFACTS_API_URL is not a URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new CliError("ARTIFACTS_API_URL must use https (http only for localhost), since the token travels with it");
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new CliError(
      "ARTIFACTS_API_URL must be the API origin without a path, such as https://artifacts-api.example.com",
    );
  }
  return url.origin;
}

export function readConfig(env: Environment, platform: NodeJS.Platform): Config {
  const apiOrigin = readOrigin(env);
  const token = env.ARTIFACTS_TOKEN;
  if (token !== undefined && token !== "") {
    if (!TOKEN_FORM.test(token)) throw new CliError("ARTIFACTS_TOKEN has characters a token cannot have");
    return { apiOrigin, credential: { kind: "token", token } };
  }
  if (!storesLogin(platform)) throw new CliError(missingCredential(platform));
  return { apiOrigin, credential: { kind: "login" } };
}
