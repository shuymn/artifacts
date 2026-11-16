/**
 * The artifacts Worker (docs/design.md). One Worker serves every host: it classifies the request's host first
 * (HOST-1), then authenticates it for the host's class (Access JWT on the app and private content hosts, a bearer token
 * on the API host, none on public hosts) before any storage is read.
 */
import { AccessVerifier, type AccessSettings } from "./access.ts";
import { parseConfig, type Config } from "./config.ts";
import { serveGallery, withGalleryPolicy } from "./gallery/route.ts";
import { classifyHost } from "./hosts.ts";
import { newArtifactId, type ArtifactId } from "./id.ts";
import { errorName, logEvent, type HostKind } from "./log.ts";
import { handleMcp } from "./mcp.ts";
import type { OperationDeps } from "./operations.ts";
import { handleRest, jsonResponse, transportError } from "./rest.ts";
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

async function api(request: Request, url: URL, env: Env, config: Config, deps: WorkerDeps): Promise<Response> {
  const auth = await authenticate(request, config.tokens);
  if (!auth.ok) {
    logEvent("token.refused", { reason: auth.reason });
    return transportError("unauthorized", { "WWW-Authenticate": "Bearer" });
  }
  if (url.pathname === "/mcp") return handleMcp(request, operationDeps(env, config, deps), auth.name);
  if (url.pathname.startsWith("/v1/")) return handleRest(request, url, operationDeps(env, config, deps), auth.name);
  return jsonResponse(404, { error: { code: "not_found", message: "no such route" } });
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

/** The Worker's fetch handler; it uses neither the execution context nor `cf`. */
export type Worker = { fetch(request: Request, env: Env): Promise<Response> };

export function createWorker(deps: WorkerDeps): Worker {
  return {
    async fetch(request, env): Promise<Response> {
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
      const url = new URL(request.url);
      const route = classifyHost(url.host, config);
      try {
        switch (route.kind) {
          case "unmatched":
            return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
          case "api":
            return await api(request, url, env, config, deps);
          case "app":
            return withGalleryPolicy(await browser(request, url, env, config, deps, "app", undefined));
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
