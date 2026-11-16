/**
 * Artifact IDs (design.md section 2): 26 characters of lowercase RFC 4648 base32, each from 5 bits of a random byte.
 * 130 bits, a valid DNS label, and not guessable from a public link. Masking a byte to 5 bits is unbiased because 32
 * divides 256.
 */
declare const artifactIdBrand: unique symbol;
export type ArtifactId = string & { readonly [artifactIdBrand]: true };

export const ID_LENGTH = 26;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_PATTERN = /^[a-z2-7]{26}$/;

export function isArtifactId(value: string): value is ArtifactId {
  return ID_PATTERN.test(value);
}

export function newArtifactId(): ArtifactId {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte & 31];
  if (!isArtifactId(id)) throw new Error("generated an invalid artifact ID");
  return id;
}
