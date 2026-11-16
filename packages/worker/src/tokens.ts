/**
 * API tokens (design.md section 7; TOK-1 to TOK-3). The optional secret `API_TOKENS` is a JSON object that maps each
 * token name to the hex SHA-256 of its token; without it, or with `{}`, every token is refused. A request presents
 * `Authorization: Bearer <token>`; its SHA-256 is compared with every entry in constant time, and the matching name
 * stands for the caller from then on. The token itself is never stored, returned or logged.
 */
declare const tokenNameBrand: unique symbol;
/** A name from `API_TOKENS`: `[a-z0-9-]{1,32}`. Only `parseApiTokens` makes one. */
export type TokenName = string & { readonly [tokenNameBrand]: true };

export type ApiToken = { readonly name: TokenName; readonly hash: Uint8Array };

const NAME = /^[a-z0-9-]{1,32}$/;
const HASH = /^[0-9a-f]{64}$/;
/** Longer credentials are refused without hashing; a token is `art_` and 32 characters. */
const MAX_TOKEN_LENGTH = 512;

function isTokenName(value: string): value is TokenName {
  return NAME.test(value);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** The entries of `API_TOKENS`, or undefined when it is not such an object or two entries share a hash. */
export function parseApiTokens(text: string): readonly ApiToken[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const tokens: ApiToken[] = [];
  const hashes = new Set<string>();
  for (const [name, hash] of Object.entries(value)) {
    if (!isTokenName(name) || typeof hash !== "string" || !HASH.test(hash) || hashes.has(hash)) return undefined;
    hashes.add(hash);
    tokens.push({ name, hash: hexToBytes(hash) });
  }
  return tokens;
}

export const TOKEN_REFUSALS = ["missing", "scheme", "unknown"] as const;
export type TokenRefusal = (typeof TOKEN_REFUSALS)[number];

export type TokenResult =
  | { readonly ok: true; readonly name: TokenName }
  | { readonly ok: false; readonly reason: TokenRefusal };

/** TOK-1: the token name of the request's bearer token, before any storage is read. */
export async function authenticate(request: Request, tokens: readonly ApiToken[]): Promise<TokenResult> {
  const header = request.headers.get("Authorization");
  if (header === null || header === "") return { ok: false, reason: "missing" };
  const match = /^Bearer +([^\s]+) *$/i.exec(header);
  const token = match?.[1];
  if (token === undefined) return { ok: false, reason: "scheme" };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "unknown" };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  let name: TokenName | undefined;
  // Every entry is compared, so the time taken does not depend on which entry matches.
  for (const entry of tokens) {
    if (crypto.subtle.timingSafeEqual(digest, entry.hash) && name === undefined) name = entry.name;
  }
  return name === undefined ? { ok: false, reason: "unknown" } : { ok: true, name };
}
