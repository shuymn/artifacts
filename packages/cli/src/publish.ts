/**
 * `publish` (design.md section 9). Without an ID it creates an artifact; after a lost answer it lists the artifacts
 * and takes the one it made before creating again. With an ID it reads the latest version, sends only new and changed
 * files, removes the paths the directory lacks, and sends the version it read as `base_version`; a conflict is
 * reported, not retried.
 */
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";

import { ApiError, LostResponse, type Api, type ArtifactJson, type ArtifactVersion } from "./api.ts";
import { CliError } from "./errors.ts";
import { hashFiles, LIMITS, type LocalFile } from "./tree.ts";

/**
 * A REST publish body (design.md section 6, "How bytes travel"), encoded once so its exact size is known and a retry
 * sends the same bytes; `paths` names its `file` parts in order.
 */
export type Encoded = { readonly body: Blob; readonly type: string; readonly paths: readonly string[] };

/**
 * The multipart body: a `meta` part with the JSON input, then one `file` part per `meta.files` entry, in order. The
 * part file name is fixed, since the Worker ignores it but needs one to keep the bytes as they are.
 */
export async function encodePublish(meta: Record<string, unknown>, files: readonly LocalFile[]): Promise<Encoded> {
  const metaText = JSON.stringify(meta);
  const declared = files.reduce((sum, file) => sum + file.size, Buffer.byteLength(metaText, "utf8"));
  if (declared > LIMITS.requestBytes) throw overBound(declared);
  const form = new FormData();
  form.append("meta", metaText);
  for (const file of files) form.append("file", await openAsBlob(file.source), "file");
  const encoded = new Response(form);
  const type = encoded.headers.get("Content-Type");
  if (type === null) throw new CliError("could not encode the request");
  const body = await encoded.blob();
  if (body.size > LIMITS.requestBytes) throw overBound(body.size);
  return { body, type, paths: files.map((file) => file.path) };
}

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

function overBound(bytes: number): CliError {
  return new CliError(
    `the request would be ${mib(bytes)} MiB, over the bound of ${mib(LIMITS.requestBytes)} MiB; ` +
      "a publish is not split into versions, so publish fewer or smaller files",
  );
}

export type CreateOptions = {
  readonly title: string;
  readonly description: string | undefined;
};

export type Published = ArtifactVersion & {
  /** Set when the answer was lost and the artifact was found by listing. */
  readonly recovered?: boolean;
};

/** A create or an update whose answer did not arrive: no answer at all, or a 5xx that may follow a commit. */
function isLost(error: unknown): boolean {
  return error instanceof LostResponse || (error instanceof ApiError && error.status >= 500);
}

export async function create(
  api: Api,
  files: readonly LocalFile[],
  options: CreateOptions,
  pageSize: number,
): Promise<Published> {
  const meta: Record<string, unknown> = {
    title: options.title,
    files: files.map((file) => ({ path: file.path })),
  };
  if (options.description !== undefined) meta.description = options.description;
  const encoded = await encodePublish(meta, files);
  try {
    return await api.create(encoded.body, encoded.type);
  } catch (error) {
    if (!isLost(error)) throw error;
  }
  const found = await findCreated(api, encoded, options, pageSize);
  if (found !== undefined) return { ...found, recovered: true };
  try {
    return await api.create(encoded.body, encoded.type);
  } catch (error) {
    if (!isLost(error)) throw error;
    throw new CliError(
      "the create got no answer twice; it may have applied. Run `artifacts list` before publishing again",
    );
  }
}

/**
 * The SHA-256 of each file by path, read back from the encoded body: the bytes the request carried, whatever the local
 * files hold since.
 */
async function sentHashes(encoded: Encoded): Promise<Map<string, string>> {
  const form = await new Response(encoded.body, { headers: { "Content-Type": encoded.type } }).formData();
  const parts = form.getAll("file");
  const hashes = new Map<string, string>();
  for (const [index, path] of encoded.paths.entries()) {
    const part = parts[index];
    if (!(part instanceof Blob)) throw new CliError("could not read back the request it sent");
    hashes.set(
      path,
      createHash("sha256")
        .update(new Uint8Array(await part.arrayBuffer()))
        .digest("hex"),
    );
  }
  return hashes;
}

/**
 * The artifact a create with a lost answer made, if the listing shows it: the same title and description, version 1
 * and the files the request carried (path and SHA-256). Equal artifacts are interchangeable, so no clock is compared.
 */
async function findCreated(
  api: Api,
  encoded: Encoded,
  options: CreateOptions,
  pageSize: number,
): Promise<ArtifactVersion | undefined> {
  const description = options.description ?? "";
  const hashes = await sentHashes(encoded);
  try {
    const candidates = (await listAll(api, "include", pageSize)).filter(
      (artifact) =>
        artifact.title === options.title && artifact.description === description && artifact.latest_version === 1,
    );
    for (const candidate of candidates) {
      const found = await api.get(candidate.id, 1);
      const same =
        found.version.files.length === hashes.size &&
        found.version.files.every((file) => hashes.get(file.path) === file.sha256);
      if (same) return found;
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(
      `the create got no answer and the artifacts could not be listed (${error.message}); ` +
        "run `artifacts list` before publishing again",
    );
  }
  return undefined;
}

/** Every artifact, page by page; a cursor seen before stops the walk rather than looping. */
export async function listAll(api: Api, archived: string | undefined, pageSize: number): Promise<ArtifactJson[]> {
  const artifacts: ArtifactJson[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await api.list({ archived, limit: pageSize, cursor });
    artifacts.push(...page.artifacts);
    cursor = page.next_cursor;
    if (cursor !== null) {
      if (seen.has(cursor)) throw new CliError("the API repeated a listing cursor");
      seen.add(cursor);
    }
  } while (cursor !== null);
  return artifacts;
}

export type UpdateOptions = {
  readonly id: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
};

export type Updated = ArtifactVersion & {
  readonly sent: number;
  readonly removed: number;
  readonly unchanged: number;
};

export async function update(api: Api, files: readonly LocalFile[], options: UpdateOptions): Promise<Updated> {
  const base = await api.get(options.id);
  const baseVersion = base.version.number;
  const remote = new Map(base.version.files.map((file) => [file.path, file.sha256]));
  const hashes = await hashFiles(files);
  const send = files.filter((file) => remote.get(file.path) !== hashes.get(file.path));
  const local = new Set(files.map((file) => file.path));
  const remove = [...remote.keys()].filter((path) => !local.has(path));
  const meta: Record<string, unknown> = {
    base_version: baseVersion,
    files: send.map((file) => ({ path: file.path })),
    remove,
  };
  if (options.title !== undefined) meta.title = options.title;
  if (options.description !== undefined) meta.description = options.description;
  const encoded = await encodePublish(meta, send);
  let result: ArtifactVersion;
  try {
    result = await api.update(options.id, encoded.body, encoded.type);
  } catch (error) {
    // The REST API answers 409 for version_conflict only (design.md section 8), so a 409 whose body was cut is one.
    if (error instanceof ApiError && (error.code === "version_conflict" || error.status === 409)) {
      const latest = error.latestVersion === undefined ? "a newer version" : `version ${error.latestVersion}`;
      throw new CliError(
        `version_conflict: ${latest} was published after version ${baseVersion}, which this publish ` +
          "read; nothing was published. Check the latest version, then publish again",
      );
    }
    if (isLost(error)) {
      // A rerun reads the latest version again, so it would not notice that this update applied.
      throw new CliError(
        "the update got no answer; it may have applied. Check the latest version with " +
          `\`artifacts get ${options.id}\` before publishing again (this publish read version ${baseVersion})`,
      );
    }
    throw error;
  }
  return { ...result, sent: send.length, removed: remove.length, unchanged: files.length - send.length };
}
