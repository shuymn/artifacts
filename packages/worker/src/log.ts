/**
 * The Worker's only path to `console` (DATA-1). Workers Logs keep console output for 7 days, so a log line is an event
 * name and fields whose values come from closed sets, token names and artifact IDs: never a token, an `Authorization`
 * header, an Access JWT or cookie, file bytes, a title, a description, a path or an error's message. The source check
 * in source.test.ts refuses `console` in every other file.
 */
import type { AccessReason } from "./access.ts";
import type { ConfigErrorCode, ConfigVariable } from "./config.ts";
import type { ArtifactId } from "./id.ts";
import type { OAuthErrorCategory, OAuthErrorCode } from "./oauth.ts";
import type { GrantId } from "./revocation.ts";
import type { ArchiveSetting } from "./schemas.ts";
import type { TokenName, TokenRefusal } from "./tokens.ts";

export const LOG_EVENTS = [
  "config.invalid",
  "access.refused",
  "access.unavailable",
  "token.refused",
  "artifact.created",
  "artifact.updated",
  "artifact.changed",
  "artifact.deleted",
  "cleanup.failed",
  "operation.failed",
  "request.failed",
  "oauth.refused",
  "grant.revoked",
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

/** Failures go to `console.error`, changes to `console.log`. */
const LEVEL: Record<LogEvent, "log" | "error"> = {
  "config.invalid": "error",
  "access.refused": "log",
  "access.unavailable": "error",
  "token.refused": "log",
  "artifact.created": "log",
  "artifact.updated": "log",
  "artifact.changed": "log",
  "artifact.deleted": "log",
  "cleanup.failed": "error",
  "operation.failed": "error",
  "request.failed": "error",
  "oauth.refused": "log",
  "grant.revoked": "log",
};

/** Error classes logged by name. Any other value, a custom error class included, is logged as `other`. */
export const ERROR_NAMES = ["Error", "TypeError", "RangeError", "SyntaxError", "TimeoutError", "other"] as const;
export type ErrorName = (typeof ERROR_NAMES)[number];

/** Why a storage step failed: a timeout, R2's rate limit after the retries, or any other error. */
export const STORAGE_FAILURES = ["timeout", "rate_limited", "error", "object_missing"] as const;
export type StorageFailure = (typeof STORAGE_FAILURES)[number];

export const HOST_KINDS = ["app", "api", "content", "public"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

/** Every field a log line can carry, each typed by a closed set, a validated name or a number. */
export type LogFields = {
  /** `revoked`: the token endpoint refused a grant with a revocation record. */
  readonly reason?: ConfigErrorCode | AccessReason | TokenRefusal | StorageFailure | "revoked";
  readonly variable?: ConfigVariable;
  /** A binding the configuration needs and the Worker lacks. */
  readonly binding?: "OAUTH_KV";
  readonly host?: HostKind;
  readonly error?: ErrorName;
  readonly token?: TokenName;
  readonly artifact?: ArtifactId;
  readonly version?: number;
  readonly public?: boolean;
  readonly archive?: ArchiveSetting | null;
  readonly count?: number;
  readonly grant?: GrantId;
  /** An OAuth error code and the library's category for it, each from a closed set. */
  readonly code?: OAuthErrorCode;
  readonly category?: OAuthErrorCategory;
};

export function logEvent(event: LogEvent, fields: LogFields = {}): void {
  console[LEVEL[event]](JSON.stringify({ event, ...fields }));
}

/** The class of a thrown value, without its message. */
export function errorName(error: unknown): ErrorName {
  if (!(error instanceof Error)) return "other";
  const name = error.name;
  return ERROR_NAMES.find((known) => known === name) ?? "other";
}
