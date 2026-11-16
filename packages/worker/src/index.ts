/**
 * The artifacts Worker (docs/design.md). One Worker serves every host: it classifies the request's host first
 * (HOST-1), then authenticates it for the host's class (Access JWT on the app and private content hosts, a bearer token
 * on the API host, none on public hosts) before any storage is read. The API host's OAuth authorization server paths
 * take no credential; only they reach the OAuth library's `fetch`, and only the app host's authorization endpoint, behind
 * Access, reaches its helpers.
 */
import { AccessVerifier, type AccessSettings } from "./access.ts";
import { parseConfig, type Config } from "./config.ts";
import { serveConsent, type ConsentAnswer } from "./consent.ts";
import { serveGallery, withGalleryPolicy } from "./gallery/route.ts";
import { classifyHost } from "./hosts.ts";
import { newArtifactId, type ArtifactId } from "./id.ts";
import { errorName, logEvent, type HostKind } from "./log.ts";
import { handleMcp } from "./mcp.ts";
import { AUTHORIZE_PATH, isApiOAuthPath, LIBRARY_PATHS, serveOAuth } from "./oauth.ts";
import type { OperationDeps } from "./operations.ts";
import { handleRest, jsonResponse, restAllow, transportError } from "./rest.ts";
import { methodAllowed, methodNotAllowed, plainResponse, serveArtifact, type BrowserClass } from "./serve.ts";
import { TIMEOUTS, type Timeouts } from "./timeout.ts";
import { authenticate } from "./tokens.ts";

/** What the Worker takes from its environment besides bindings and variables; tests replace each. */
export type WorkerDeps = {
  readonly now: () => number;
  readonly newId: () => ArtifactId;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timeouts: Timeouts;
  readonly access: AccessVerifier;
};

const operationDeps = (env: Env, config: Config, deps: WorkerDeps): OperationDeps => ({
  db: env.DB,
  bucket: env.FILES,
  config,
  now: deps.now,
  newId: deps.newId,
  sleep: deps.sleep,
  timeouts: deps.timeouts,
  ...(config.oauth && env.OAUTH_KV !== undefined ? { oauthKv: env.OAUTH_KV } : {}),
});

/**
 * ACC-1, ACC-2: verifies the Access JWT for the host's audience, unless every configured host is a `localhost` name.
 * Undefined when the request may go on; otherwise the refusal.
 */
async function refuseWithoutAccess(
  request: Request,
  config: Config,
  deps: WorkerDeps,
  host: HostKind,
): Promise<Response | undefined> {
  if (config.access === null) return undefined;
  const settings: AccessSettings = {
    teamDomain: config.access.teamDomain,
    aud: host === "app" ? config.access.appAud : config.access.contentAud,
  };
  const outcome = await deps.access.verify(request, settings);
  if (outcome.ok) return undefined;
  logEvent(outcome.status === 503 ? "access.unavailable" : "access.refused", { reason: outcome.reason, host });
  return plainResponse("private", outcome.status);
}

const noSuchRoute = () => jsonResponse(404, { error: { code: "not_found", message: "no such route" } });

/** The methods of the route that takes `url` behind a bearer token, for `Allow`; undefined when none does. */
function apiAllow(url: URL, config: Config): string | undefined {
  if (url.pathname === "/mcp") return "POST";
  if (url.pathname.startsWith("/v1/")) return restAllow(url, config);
  return undefined;
}

async function api(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  config: Config,
  deps: WorkerDeps,
): Promise<Response> {
  // OAuth is off in a localhost configuration, so its paths do not exist, whatever the credential.
  if (!config.oauth && isApiOAuthPath(url.pathname)) return noSuchRoute();
  // The authorization server takes no bearer token; `fetch` refused a configuration with OAuth and without OAUTH_KV.
  if (config.oauth && env.OAUTH_KV !== undefined && LIBRARY_PATHS.has(url.pathname)) {
    return serveOAuth(request, url, env.OAUTH_KV, config, {
      now: deps.now,
      kvReadMs: deps.timeouts.kvReadMs,
      ctx,
    });
  }
  // ISO-2: no preflight succeeds. One to a route answers 405 before authentication, one to no route 404.
  if (request.method === "OPTIONS") {
    const allow = apiAllow(url, config);
    return allow === undefined ? noSuchRoute() : transportError("method_not_allowed", { Allow: allow });
  }
  const auth = await authenticate(request, config.tokens);
  if (!auth.ok) {
    logEvent("token.refused", { reason: auth.reason });
    return transportError("unauthorized", { "WWW-Authenticate": "Bearer" });
  }
  if (url.pathname === "/mcp") return handleMcp(request, operationDeps(env, config, deps), auth.name);
  if (url.pathname.startsWith("/v1/")) return handleRest(request, url, operationDeps(env, config, deps), auth.name);
  return noSuchRoute();
}

async function browser(
  request: Request,
  url: URL,
  env: Env,
  config: Config,
  deps: WorkerDeps,
  host: Exclude<HostKind, "api">,
  id: ArtifactId | undefined,
): Promise<Response> {
  const kind: BrowserClass = host === "public" ? "public" : "private";
  if (!methodAllowed(request)) return methodNotAllowed(kind);
  if (host !== "public") {
    const refusal = await refuseWithoutAccess(request, config, deps, host);
    if (refusal !== undefined) return refusal;
  }
  // The gallery (design.md section 10).
  if (id === undefined) return serveGallery(request, url, operationDeps(env, config, deps));
  return serveArtifact(request, url, operationDeps(env, config, deps), id, kind);
}

/**
 * The authorization endpoint on the app host (design.md section 7): the consent page on `GET`, its form on `POST`, any
 * other method 405 (ISO-3), then Access with the app audience (ACC-1), as for the gallery.
 */
async function authorize(
  request: Request,
  url: URL,
  env: Env,
  config: Config,
  deps: WorkerDeps,
): Promise<ConsentAnswer> {
  // OAuth is off in a localhost configuration: the endpoint does not exist, whatever the method. `fetch` refused a
  // configuration with OAuth and without OAUTH_KV.
  if (!config.oauth || env.OAUTH_KV === undefined) return { response: plainResponse("private", 404) };
  // `HEAD` too: a `GET` there writes a transaction.
  if (request.method !== "GET" && request.method !== "POST") {
    return { response: plainResponse("private", 405, { Allow: "GET, POST" }) };
  }
  const refusal = await refuseWithoutAccess(request, config, deps, "app");
  if (refusal !== undefined) return { response: refusal };
  return serveConsent(request, url, env.OAUTH_KV, config, { now: deps.now, kvReadMs: deps.timeouts.kvReadMs });
}

/** The Worker's fetch handler; the execution context goes to the OAuth library only, and `cf` is not used. */
export type Worker = { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };

export function createWorker(deps: WorkerDeps): Worker {
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const parsed = parseConfig(env);
      if (!parsed.ok) {
        logEvent("config.invalid", {
          reason: parsed.code,
          ...(parsed.variable === undefined ? {} : { variable: parsed.variable }),
        });
        // The host class is unknown, so the answer carries the private class's headers.
        return plainResponse("private", 503);
      }
      const { config } = parsed;
      // Section 11: with OAuth on, a Worker without its storage answers as for an invalid variable, so a deployment
      // never runs with OAuth silently off.
      if (config.oauth && env.OAUTH_KV === undefined) {
        logEvent("config.invalid", { reason: "missing", binding: "OAUTH_KV" });
        return plainResponse("private", 503);
      }
      const url = new URL(request.url);
      const route = classifyHost(url.host, config);
      try {
        switch (route.kind) {
          case "unmatched":
            return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
          case "api":
            return await api(request, url, env, ctx, config, deps);
          case "app": {
            if (url.pathname === AUTHORIZE_PATH) {
              const answer = await authorize(request, url, env, config, deps);
              return withGalleryPolicy(answer.response, answer.formAction);
            }
            return withGalleryPolicy(await browser(request, url, env, config, deps, "app", undefined));
          }
          case "content":
            return await browser(request, url, env, config, deps, "content", route.id);
          case "public":
            return await browser(request, url, env, config, deps, "public", route.id);
          default:
            return route satisfies never;
        }
      } catch (error) {
        // DATA-1: the class of the error only, never its message.
        logEvent("request.failed", {
          error: errorName(error),
          ...(route.kind === "unmatched" ? {} : { host: route.kind }),
        });
        if (route.kind === "api") return jsonResponse(500, { error: { code: "internal", message: "internal error" } });
        const failure = plainResponse(route.kind === "public" ? "public" : "private", 500);
        return route.kind === "app" ? withGalleryPolicy(failure) : failure;
      }
    },
  };
}

export default createWorker({
  now: () => Date.now(),
  newId: newArtifactId,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeouts: TIMEOUTS,
  // Module scope: the key set's cache lives as long as the isolate.
  access: new AccessVerifier({ fetch: (input, init) => fetch(input, init), now: () => Date.now() }),
}) satisfies ExportedHandler<Env>;
