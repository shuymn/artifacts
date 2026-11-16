/**
 * The owner's OAuth grants (design.md section 8, "Grants"; section 7, "Revocation"): a listing and the revocation of one
 * grant, served on REST where OAuth is on. Both go through the library's helpers over `OAUTH_KV`, which they reach
 * through the recording wrapper, so a revocation writes its record before the grant's deletion (OAUTH-5).
 */
import type { GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import { fail, succeed, type Result } from "./errors.ts";
import { errorName, logEvent } from "./log.ts";
import { authorizationServer } from "./oauth.ts";
import type { OperationDeps } from "./operations.ts";
import { hasRevocationRecord, isGrantId, recordingKv, type RecordingKv } from "./revocation.ts";
import { TimeoutError, withTimeout } from "./timeout.ts";

/** The user ID of every grant: the Access policy is the one place that names the owner. */
export const OWNER = "owner";

/**
 * What the consent page stores in a grant's metadata for this listing. A grant without one of them, such as one made
 * before the consent page, lists it as null.
 */
export type GrantMetadata = {
  readonly publisher: string;
  readonly clientName: string;
  readonly redirectHost: string;
};

export type GrantJson = {
  readonly id: string;
  readonly publisher: string | null;
  readonly client_id: string;
  readonly client_name: string | null;
  readonly redirect_host: string | null;
  readonly resource: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
};

const isoSeconds = (seconds: number) => new Date(seconds * 1000).toISOString();

function textField(metadata: unknown, name: keyof GrantMetadata): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const value: unknown = Reflect.get(metadata, name);
  return typeof value === "string" ? value : null;
}

function grantJson(grant: GrantSummary): GrantJson {
  return {
    id: grant.id,
    publisher: textField(grant.metadata, "publisher"),
    client_id: grant.clientId,
    client_name: textField(grant.metadata, "clientName"),
    redirect_host: textField(grant.metadata, "redirectHost"),
    resource: typeof grant.resource === "string" ? grant.resource : null,
    created_at: isoSeconds(grant.createdAt),
    expires_at: grant.expiresAt === undefined ? null : isoSeconds(grant.expiresAt),
  };
}

function oauthKv(deps: OperationDeps): KVNamespace {
  // The Worker refuses a configuration with OAuth on and without OAUTH_KV, and the routes exist only with OAuth on.
  if (deps.oauthKv === undefined) throw new Error("OAUTH_KV is not bound");
  return deps.oauthKv;
}

function helpers(deps: OperationDeps, recording: RecordingKv): OAuthHelpers {
  return authorizationServer(deps.config).getOAuthApi({ OAUTH_KV: recording.kv });
}

/** Every grant the library's listing holds, a page at a time, each page under the KV-read timeout (RES-2). */
async function libraryGrants(deps: OperationDeps): Promise<GrantSummary[]> {
  const library = helpers(deps, recordingKv(oauthKv(deps), deps.now));
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await withTimeout(
      library.listUserGrants(OWNER, cursor === undefined ? {} : { cursor }),
      deps.timeouts.kvReadMs,
    );
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return grants;
}

/** A failed or timed-out read of OAuth storage is `unavailable` (section 8); the log carries the class only. */
async function readingGrants<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await work();
  } catch (error) {
    logEvent("operation.failed", {
      reason: error instanceof TimeoutError ? "timeout" : "error",
      error: errorName(error),
    });
    return fail({ code: "unavailable" });
  }
}

/**
 * `GET /v1/grants`: every grant, newest first, except those with a revocation record, which a refresh or code exchange
 * in flight can write back after their deletion (section 7).
 */
export function listGrants(deps: OperationDeps): Promise<Result<{ grants: GrantJson[] }>> {
  return readingGrants(async () => {
    const kv = oauthKv(deps);
    const grants = await libraryGrants(deps);
    const revoked = await Promise.all(grants.map((grant) => hasRevocationRecord(kv, grant.id, deps.timeouts.kvReadMs)));
    const live = grants
      .filter((_, index) => revoked[index] === false)
      .toSorted((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    return succeed({ grants: live.map(grantJson) });
  });
}

/**
 * `DELETE /v1/grants/{id}`: revokes a grant the library's listing holds, a revoked one whose deletion failed included,
 * through the library's `revokeGrant` over the recording wrapper. The revocation has no timeout, since a write that
 * timed out could still apply; a failed write answers `unavailable`, and a repeated call completes it.
 */
export async function revokeGrantById(deps: OperationDeps, id: string): Promise<Result<null>> {
  // The library generates every grant ID in this form, so any other names no grant and costs no read.
  const noSuchGrant = fail({ code: "not_found", subject: "grant" });
  if (!isGrantId(id)) return noSuchGrant;
  const listed = await readingGrants(async () => succeed(await libraryGrants(deps)));
  if (!listed.ok) return listed;
  if (!listed.value.some((grant) => grant.id === id)) return noSuchGrant;
  const recording = recordingKv(oauthKv(deps), deps.now);
  try {
    await helpers(deps, recording).revokeGrant(id, OWNER);
    return succeed(null);
  } catch (error) {
    logEvent("grant.revoke_failed", { grant: id, error: errorName(error) });
    return fail({ code: recording.failed() ? "unavailable" : "internal" });
  }
}
