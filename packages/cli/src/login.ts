/**
 * `login` and `logout` (design.md section 9). `login` checks the server's metadata, keeps or registers its client,
 * listens on `127.0.0.1` for one callback, opens the browser at the authorization URL, checks `state` and `iss`,
 * exchanges the code and stores the tokens under the lock. `logout` revokes exactly the stored login's grant with its
 * own access token, then removes the login under the lock, keeping the client ID for the next `login`.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Api, ApiError } from "./api.ts";
import { CliError } from "./errors.ts";
import { authorization, discover, exchange, knowsClient, OAuthRefusal, register, type Server } from "./oauth.ts";
import { LoginRefused, StoredLogin, type SessionContext } from "./session.ts";
import type { Tokens } from "./store.ts";

export type LoginContext = SessionContext & {
  /** How long the listener waits for the callback. */
  readonly callbackMs: number;
  readonly openBrowser: (url: string) => void;
  readonly print: (text: string) => void;
  readonly note: (text: string) => void;
};

/** The system's opener: `open` on macOS, `xdg-open` elsewhere, found on `PATH` and given the URL as one argument. */
export function systemOpener(platform: NodeJS.Platform): (url: string) => void {
  const command = platform === "darwin" ? "open" : "xdg-open";
  return (url) => {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    // Without an opener the printed URL remains.
    child.on("error", () => undefined);
    child.unref();
  };
}

const PAGE = {
  ok: "Signed in to artifacts. Return to the terminal.\n",
  failed: "The sign-in did not complete. Return to the terminal to see why.\n",
};

type Callback = { readonly query: URLSearchParams; readonly answer: (ok: boolean) => void };

/** The page the browser shows: only whether the sign-in completed, and to return to the terminal. */
function answerPage(response: ServerResponse, ok: boolean): void {
  if (response.headersSent) return;
  response.writeHead(ok ? 200 : 400, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(ok ? PAGE.ok : PAGE.failed);
}

/**
 * A listener on `127.0.0.1`, on a port the system picks, for one request to `/callback`. It stops accepting
 * connections at that request, fails after `timeoutMs` without one, and `close` ends it on every exit.
 */
async function listen(timeoutMs: number) {
  let resolve!: (callback: Callback) => void;
  let reject!: (error: Error) => void;
  const received = new Promise<Callback>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let answered: ServerResponse | undefined;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (answered !== undefined || request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found\n");
      return;
    }
    answered = response;
    server.close();
    resolve({ query: url.searchParams, answer: (ok) => answerPage(response, ok) });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new CliError("the sign-in listener has no port");
  const timer = setTimeout(() => {
    reject(new CliError(`no sign-in arrived within ${Math.round(timeoutMs / 1000)} s; run artifacts login again`));
  }, timeoutMs);
  return {
    port: address.port,
    received,
    close: async () => {
      clearTimeout(timer);
      if (answered !== undefined) answerPage(answered, false);
      server.close();
      server.closeAllConnections();
    },
  };
}

/** Drops the stored client ID `clientId` for `origin` with its login: the server no longer knows it. */
async function dropClient(context: LoginContext, clientId: string): Promise<void> {
  await context.store.withLock(async ({ logins, write }) => {
    if (logins.get(context.origin)?.client_id !== clientId) return;
    logins.delete(context.origin);
    await write();
  });
}

/** The stored client ID if the server still knows it; otherwise a new registration. */
async function clientFor(context: LoginContext, server: Server): Promise<string> {
  const kept = (await context.store.read()).get(context.origin)?.client_id;
  if (kept !== undefined) {
    if (await knowsClient(server, kept)) return kept;
    await dropClient(context, kept);
  }
  return register(server);
}

export async function login(context: LoginContext, tokenSet: boolean): Promise<void> {
  const { origin, fetch, requestMs, now, secrets } = context;
  const server = await discover(origin, fetch, requestMs);
  const clientId = await clientFor(context, server);
  const listener = await listen(context.callbackMs);
  let tokens: Tokens;
  try {
    const sent = await authorization(server, clientId, `http://127.0.0.1:${listener.port}/callback`);
    context.note(`artifacts: opening the browser to sign in. If it does not open, visit this URL:\n${sent.url}\n`);
    context.openBrowser(sent.url);
    const callback = await listener.received;
    try {
      tokens = await exchange(server, clientId, sent, callback.query, now);
      secrets.add(tokens.access_token).add(tokens.refresh_token);
    } catch (error) {
      if (error instanceof OAuthRefusal && error.unknownClient) await dropClient(context, clientId);
      throw error;
    }
    await context.store.withLock(async ({ logins, write }) => {
      logins.set(origin, { client_id: clientId, tokens });
      await write();
    });
    callback.answer(true);
  } finally {
    await listener.close();
  }
  context.print(`signed in to ${origin}\n`);
  if (tokenSet) {
    context.note("artifacts: ARTIFACTS_TOKEN is set, so commands use it instead of this login until it is unset\n");
  }
}

/** The ID of the grant a token of the library's form, `<user>:<grant ID>:<secret>`, names. */
function grantOf(token: string): string | undefined {
  const parts = token.split(":");
  return parts.length === 3 && parts[1] !== "" ? parts[1] : undefined;
}

/** Removes the stored login of `grant` for `origin`, keeping the client ID; another login stored meanwhile stays. */
async function forget(context: LoginContext, grant: string): Promise<void> {
  await context.store.withLock(async ({ logins, write }) => {
    const entry = logins.get(context.origin);
    const stored = entry?.tokens ?? null;
    if (entry === undefined || stored === null || grantOf(stored.access_token) !== grant) return;
    logins.set(context.origin, { client_id: entry.client_id, tokens: null });
    await write();
  });
}

export async function logout(context: LoginContext): Promise<void> {
  const { origin, store } = context;
  const tokens = (await store.read()).get(origin)?.tokens ?? null;
  if (tokens === null) {
    context.print(`not signed in to ${origin}\n`);
    return;
  }
  // Keeping the tokens also marks them for redaction.
  const api = new Api(origin, new StoredLogin(context, tokens), context.fetch);
  const grant = grantOf(tokens.access_token);
  if (grant === undefined) throw new CliError("the stored access token does not name its grant");
  try {
    await api.revokeGrant(grant, context.requestMs);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new CliError(
        "the server does not list this login's grant yet; the login is kept, so run artifacts logout again",
      );
    }
    // Refused, even after a refresh: the login has nothing left to revoke.
    const refused = error instanceof LoginRefused || (error instanceof ApiError && error.status === 401);
    if (!refused) throw error;
    await forget(context, grant);
    context.print(`the server no longer accepts the stored login for ${origin}; removed it\n`);
    return;
  }
  await forget(context, grant);
  context.print(`signed out of ${origin}\n`);
}
