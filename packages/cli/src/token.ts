/**
 * API tokens (design.md section 7): `art_` and 32 characters of lowercase RFC 4648 base32, each from 5 bits of a random
 * byte (160 bits; masking to 5 bits is unbiased because 32 divides 256). The `API_TOKENS` entry maps the token's name to
 * the hex SHA-256 of the token.
 */
import { createHash } from "node:crypto";

import { UsageError } from "./errors.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_CHARACTERS = 32;
/** One name per agent; it becomes a version's `published_by`. */
const NAME = /^[a-z0-9-]{1,32}$/;

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_CHARACTERS));
  let token = "art_";
  for (const byte of bytes) token += ALPHABET[byte & 31];
  return token;
}

export type TokenEntry = { readonly name: string; readonly token: string; readonly sha256: string };

/** A new token for `name` and the hash its `API_TOKENS` entry holds. */
export function generateToken(name: string): TokenEntry {
  if (!NAME.test(name)) throw new UsageError("a token name is 1 to 32 characters of a-z, 0-9 and -");
  const token = newToken();
  return { name, token, sha256: createHash("sha256").update(token).digest("hex") };
}
