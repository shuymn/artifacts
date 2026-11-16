/**
 * The credential an API command sends (design.md section 9): `ARTIFACTS_TOKEN` as it is, or the stored login, which
 * is refreshed before a request when its access token expires within a minute, and once after a 401. A refresh happens
 * under the lock: it reads the file again, uses tokens another process stored meanwhile instead of refreshing, stops if
 * `logout` removed the login, and otherwise sends the one refresh request and writes the entry it read.
 */
import type { Fetch } from "./api.ts";
import { SET_TOKEN_OR_SIGN_IN } from "./config.ts";
import { CliError } from "./errors.ts";
import { authorizationServer, OAuthRefusal, refresh, type Server } from "./oauth.ts";
import type { Store, Tokens } from "./store.ts";

/** What `Api` asks of a credential. */
export interface Credential {
  /** The bearer token for the next request. */
  token(): Promise<string>;
  /** After a 401 to `rejected`: the token to send the request once more with, or undefined to fail with the 401. */
  renew(rejected: string): Promise<string | undefined>;
}

export class StaticCredential implements Credential {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async token(): Promise<string> {
    return this.#token;
  }

  async renew(): Promise<undefined> {
    return undefined;
  }
}

/** The server refuses the stored login: there is nothing left to use or revoke. */
export class LoginRefused extends CliError {
  override readonly name: string = "LoginRefused";
}

export type SessionBarriers = {
  /** A refresh has read the tokens it replaces and is about to take the lock. */
  readonly beforeRefreshLock?: () => Promise<void>;
};

export type SessionContext = {
  readonly origin: string;
  readonly store: Store;
  readonly fetch: Fetch;
  readonly requestMs: number;
  readonly now: () => number;
  /** Every token read or received, so that no message prints one. */
  readonly secrets: Set<string>;
  readonly barriers: SessionBarriers;
};

/** An access token this close to its expiry is refreshed before the request. */
const REFRESH_AHEAD_MS = 60_000;

export class StoredLogin implements Credential {
  readonly #context: SessionContext;
  #tokens: Tokens | undefined;
  #server: Server | undefined;

  constructor(context: SessionContext, tokens?: Tokens) {
    this.#context = context;
    if (tokens !== undefined) this.#keep(tokens);
  }

  #keep(tokens: Tokens): Tokens {
    this.#context.secrets.add(tokens.access_token).add(tokens.refresh_token);
    this.#tokens = tokens;
    return tokens;
  }

  async #current(): Promise<Tokens> {
    if (this.#tokens !== undefined) return this.#tokens;
    const { store, origin } = this.#context;
    const tokens = (await store.read()).get(origin)?.tokens;
    if (tokens === undefined || tokens === null) {
      throw new CliError(`${SET_TOKEN_OR_SIGN_IN} (no stored login for ${origin})`);
    }
    return this.#keep(tokens);
  }

  async token(): Promise<string> {
    const tokens = await this.#current();
    if (Date.parse(tokens.expires_at) - this.#context.now() > REFRESH_AHEAD_MS) return tokens.access_token;
    return (await this.refresh(tokens.access_token)).access_token;
  }

  async renew(rejected: string): Promise<string> {
    return (await this.refresh(rejected)).access_token;
  }

  /** Replaces the login whose access token is `seen`, unless another process did so first. */
  async refresh(seen: string): Promise<Tokens> {
    const { store, origin, fetch, requestMs, now, barriers } = this.#context;
    // The metadata is read before the lock: under it, the refresh is the one request.
    this.#server ??= await authorizationServer(origin, fetch, requestMs);
    const server = this.#server;
    await barriers.beforeRefreshLock?.();
    const tokens = await store.withLock(async ({ logins, write }) => {
      const entry = logins.get(origin);
      if (entry === undefined || entry.tokens === null) {
        throw new LoginRefused(`the stored login for ${origin} was removed; sign in with artifacts login`);
      }
      if (entry.tokens.access_token !== seen) return entry.tokens;
      let next: Tokens;
      try {
        next = await refresh(server, entry.client_id, entry.tokens, now);
      } catch (error) {
        if (!(error instanceof OAuthRefusal)) throw error;
        if (error.unknownClient) {
          // The server no longer knows the client: drop it, so the next login registers again.
          logins.delete(origin);
          await write();
          throw new LoginRefused(`the server no longer knows this CLI's client; sign in with artifacts login`);
        }
        if (error.refusedGrant) {
          throw new LoginRefused(`the server no longer accepts the stored login; sign in with artifacts login`);
        }
        throw error;
      }
      logins.set(origin, { client_id: entry.client_id, tokens: next });
      await write();
      return next;
    });
    return this.#keep(tokens);
  }
}
