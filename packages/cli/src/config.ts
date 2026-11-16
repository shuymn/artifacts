/**
 * Configuration (design.md section 9): the API origin in `ARTIFACTS_API_URL` and the token in `ARTIFACTS_TOKEN`. The
 * token is checked for its form without being echoed, so no message can carry it.
 */
import { CliError } from "./errors.ts";

export type Config = { readonly apiOrigin: string; readonly token: string };

export type Environment = Readonly<Record<string, string | undefined>>;

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
const TOKEN_FORM = /^[\x21-\x7e]{1,512}$/;

export function readConfig(env: Environment): Config {
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
  const token = env.ARTIFACTS_TOKEN;
  if (token === undefined || token === "") throw new CliError("set ARTIFACTS_TOKEN to an API token");
  if (!TOKEN_FORM.test(token)) throw new CliError("ARTIFACTS_TOKEN has characters a token cannot have");
  return { apiOrigin: url.origin, token };
}
