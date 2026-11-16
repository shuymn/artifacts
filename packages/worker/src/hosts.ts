/**
 * HOST-1: a request's host class, by exact comparison with the configuration. The host is `URL.host` as the runtime
 * parsed it (lowercase, with a port when one was given). Anything that is not the app host, the API host, or a valid ID
 * followed by exactly one suffix is `unmatched` and answers 404 without touching storage.
 */
import type { Config } from "./config.ts";
import { ID_LENGTH, isArtifactId, type ArtifactId } from "./id.ts";

export type HostRoute =
  | { readonly kind: "app" }
  | { readonly kind: "api" }
  | { readonly kind: "content"; readonly id: ArtifactId }
  | { readonly kind: "public"; readonly id: ArtifactId }
  | { readonly kind: "unmatched" };

function artifactOf(host: string, suffix: string): ArtifactId | undefined {
  if (host.length !== ID_LENGTH + suffix.length || !host.endsWith(suffix)) return undefined;
  const id = host.slice(0, ID_LENGTH);
  return isArtifactId(id) ? id : undefined;
}

export function classifyHost(host: string, config: Config): HostRoute {
  if (host === config.appHost) return { kind: "app" };
  if (host === config.apiHost) return { kind: "api" };
  const content = artifactOf(host, config.contentSuffix);
  if (content !== undefined) return { kind: "content", id: content };
  const shared = artifactOf(host, config.publicSuffix);
  if (shared !== undefined) return { kind: "public", id: shared };
  return { kind: "unmatched" };
}

export function contentOrigin(config: Config, id: ArtifactId): string {
  return `${config.scheme}://${id}${config.contentSuffix}`;
}

export function publicOrigin(config: Config, id: ArtifactId): string {
  return `${config.scheme}://${id}${config.publicSuffix}`;
}

export function appOrigin(config: Config): string {
  return `${config.scheme}://${config.appHost}`;
}
