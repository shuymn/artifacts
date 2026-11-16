/**
 * ACC-1: the gallery and private content are served only with a verified Cloudflare Access JWT. The Worker reads
 * `Cf-Access-Jwt-Assertion` (never the `CF_Authorization` cookie) and verifies it with jose: RS256 only, the team
 * domain's issuer, the audience of the host's class, `exp` required, 60 s clock tolerance, a key set reused for at
 * most 7 days. An invalid JWT is refused (403); a key set that cannot be fetched is `unavailable` (503). Only a reason
 * code leaves this module: jose's messages can carry claim values.
 */
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

import { TIMEOUTS } from "./timeout.ts";

/**
 * Access rotates its signing keys every six weeks, publishes the next key in advance, and keeps a rotated-out key valid
 * for 7 days, so a fetched set is used for at most 7 days. A token with an unknown `kid` fetches the set again, at
 * most once per cooldown (jose's remote set does both).
 */
const KEY_SET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KEY_SET_COOLDOWN_MS = 30 * 1000;
const CLOCK_TOLERANCE_S = 60;

export const ACCESS_REASONS = [
  "missing",
  "malformed",
  "algorithm",
  "signature",
  "expired",
  "claims",
  "unknown_key",
  "keys_unavailable",
] as const;
export type AccessReason = (typeof ACCESS_REASONS)[number];

export type AccessOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403 | 503; readonly reason: AccessReason };

export type AccessSettings = { readonly teamDomain: string; readonly aud: string };

export type AccessVerifierOptions = {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly keyTimeoutMs?: number;
  readonly cooldownMs?: number;
  readonly maxAgeMs?: number;
};

/** A key set failure that is not about the token: the endpoint failed, timed out or sent a malformed set. */
class KeySetUnavailable extends Error {}

const JOSE_REASONS: Record<string, AccessReason> = {
  [errors.JOSEAlgNotAllowed.code]: "algorithm",
  [errors.JWSSignatureVerificationFailed.code]: "signature",
  [errors.JWTExpired.code]: "expired",
  [errors.JWTClaimValidationFailed.code]: "claims",
  [errors.JWKSNoMatchingKey.code]: "unknown_key",
  [errors.JWKSMultipleMatchingKeys.code]: "unknown_key",
};

export class AccessVerifier {
  readonly #options: AccessVerifierOptions;
  /** Per isolate, keyed by team host: the remote set keeps its cache between requests. */
  readonly #keySets = new Map<string, JWTVerifyGetKey>();

  constructor(options: AccessVerifierOptions) {
    this.#options = options;
  }

  #keySet(teamDomain: string): JWTVerifyGetKey {
    let getKey = this.#keySets.get(teamDomain);
    if (getKey === undefined) {
      const remote = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), {
        cacheMaxAge: this.#options.maxAgeMs ?? KEY_SET_MAX_AGE_MS,
        cooldownDuration: this.#options.cooldownMs ?? KEY_SET_COOLDOWN_MS,
        timeoutDuration: this.#options.keyTimeoutMs ?? TIMEOUTS.accessKeysMs,
        [customFetch]: (url, init) => this.#options.fetch(url, init),
      });
      getKey = async (header, token) => {
        try {
          return await remote(header, token);
        } catch (error) {
          // Selecting a key from a set that was fetched fails only for the token's `kid`; everything else is the
          // fetch (network, timeout, status, JSON) or a malformed set.
          if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys)
            throw error;
          throw new KeySetUnavailable();
        }
      };
      this.#keySets.set(teamDomain, getKey);
    }
    return getKey;
  }

  async verify(request: Request, settings: AccessSettings): Promise<AccessOutcome> {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (token === null || token === "") return { ok: false, status: 403, reason: "missing" };
    try {
      await jwtVerify(token, this.#keySet(settings.teamDomain), {
        algorithms: ["RS256"],
        issuer: `https://${settings.teamDomain}`,
        audience: settings.aud,
        requiredClaims: ["exp"],
        clockTolerance: CLOCK_TOLERANCE_S,
        currentDate: new Date(this.#options.now()),
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof KeySetUnavailable) return { ok: false, status: 503, reason: "keys_unavailable" };
      const reason = error instanceof errors.JOSEError ? JOSE_REASONS[error.code] : undefined;
      return { ok: false, status: 403, reason: reason ?? "malformed" };
    }
  }
}
