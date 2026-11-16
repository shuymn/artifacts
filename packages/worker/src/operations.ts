/**
 * The shared operation layer (design.md section 8; P5). Each operation takes input the adapter validated with the
 * schemas of schemas.ts, the caller's token name where it changes something, and its dependencies; it returns a result
 * or an operation error from errors.ts's closed set. REST (rest.ts) and MCP decode, call and encode only, so both give
 * the same results and errors for the same input.
 */
import type { Config } from "./config.ts";
import { contentTypeFor } from "./content-type.ts";
import {
  ADVANCED_ROW,
  ARTIFACT_ROW,
  COUNTS_ROW,
  createStatements,
  deleteStatements,
  FILE_ROW,
  LISTED_ROW,
  read,
  rows,
  selectArchiveCounts,
  selectArtifact,
  selectArtifactPage,
  selectFiles,
  selectServedFiles,
  selectVisibleArtifact,
  selectState,
  selectVersion,
  selectVersionPage,
  settingsStatements,
  STATE_ROW,
  updateStatements,
  VERSION_ROW,
  VISIBLE_ROW,
  write,
  type AdvancedRow,
  type ArtifactCursor,
  type ArtifactRow,
  type Database,
  type FileRow,
  type NewVersion,
  type StateRow,
  type VersionRow,
} from "./db.ts";
import { fail, invalid, succeed, type Issue, type Result } from "./errors.ts";
import { appOrigin, contentOrigin, publicOrigin } from "./hosts.ts";
import { isArtifactId, type ArtifactId } from "./id.ts";
import { errorName, logEvent } from "./log.ts";
import {
  deletePrefix,
  getObject,
  readBody,
  sha256Hex,
  StorageError,
  uploadObjects,
  type ObjectStore,
} from "./objects.ts";
import { ENTRY_FILE, parseVersionNumber, type ResolvedPath } from "./paths.ts";
import { LIMITS, type ArchivedFilter, type ArchiveSetting } from "./schemas.ts";
import type { Timeouts } from "./timeout.ts";
import type { TokenName } from "./tokens.ts";

export type OperationDeps = {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly config: Config;
  readonly now: () => number;
  readonly newId: () => ArtifactId;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timeouts: Timeouts;
  /** `OAUTH_KV`, where OAuth is on: the grants API's storage. */
  readonly oauthKv?: KVNamespace;
};

/** A file of a publish: a path in its stored form (filePathSchema), an optional given type, and its bytes. */
export type FileInput = { readonly path: string; readonly contentType?: string | undefined; readonly body: Blob };

export type CreateInput = {
  readonly title: string;
  readonly description?: string | undefined;
  readonly files: readonly FileInput[];
};

export type UpdateInput = {
  readonly id: string;
  readonly baseVersion: number;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly files?: readonly FileInput[] | undefined;
  readonly remove?: readonly string[] | undefined;
};

export type ArtifactJson = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly public: boolean;
  readonly archived: boolean;
  readonly archive: ArchiveSetting | null;
  readonly latest_version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly url: string;
  readonly public_url: string | null;
  readonly gallery_url: string;
};

export type FileJson = {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly content_type: string;
};

export type VersionJson = {
  readonly number: number;
  readonly created_at: string;
  readonly published_by: string;
  readonly title: string;
  readonly description: string;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly url: string;
  readonly files?: readonly FileJson[];
};

export type PublishResult = { readonly artifact: ArtifactJson; readonly version: VersionJson };
export type ArtifactPage = { readonly artifacts: readonly ArtifactJson[]; readonly next_cursor: string | null };
export type VersionPage = { readonly versions: readonly VersionJson[]; readonly next_cursor: string | null };

const NOT_FOUND = fail({ code: "not_found" });

const database = (deps: OperationDeps): Database => ({ db: deps.db, timeouts: deps.timeouts });
const objectStore = (deps: OperationDeps): ObjectStore => ({
  bucket: deps.bucket,
  timeouts: deps.timeouts,
  sleep: deps.sleep,
});

const isoTime = (ms: number) => new Date(ms).toISOString();

function archiveSetting(value: string | null): ArchiveSetting | null {
  return value === "archived" || value === "kept" ? value : null;
}

/** Design.md section 5: before this time, an unset setting means archived (the latest version is older). */
const archivedBefore = (deps: OperationDeps, now: number) => now - deps.config.archiveAfterMs;

/** An artifact as the API shows it; `now` is read once per operation, so a listing and its filter agree. */
function artifactJson(deps: OperationDeps, row: ArtifactRow, now: number): ArtifactJson {
  const id = row.id;
  if (!isArtifactId(id)) throw new Error("D1 returned an invalid artifact ID");
  const archive = archiveSetting(row.archive);
  const isPublic = row.public === 1;
  return {
    id,
    title: row.title,
    description: row.description,
    public: isPublic,
    archived: archive === "archived" || (archive === null && row.updated_at < archivedBefore(deps, now)),
    archive,
    latest_version: row.latest_version,
    created_at: isoTime(row.created_at),
    updated_at: isoTime(row.updated_at),
    url: `${contentOrigin(deps.config, id)}/`,
    public_url: isPublic ? `${publicOrigin(deps.config, id)}/` : null,
    gallery_url: `${appOrigin(deps.config)}/a/${id}`,
  };
}

const fileJson = (row: FileRow): FileJson => ({
  path: row.path,
  size: row.size,
  sha256: row.sha256,
  content_type: row.content_type,
});

function versionJson(deps: OperationDeps, id: ArtifactId, row: VersionRow, files?: readonly FileRow[]): VersionJson {
  const json: VersionJson = {
    number: row.number,
    created_at: isoTime(row.created_at),
    published_by: row.published_by,
    title: row.title,
    description: row.description,
    file_count: row.file_count,
    total_bytes: row.total_bytes,
    url: `${contentOrigin(deps.config, id)}/_v/${row.number}/`,
  };
  return files === undefined ? json : { ...json, files: files.map(fileJson) };
}

/** Storage failures: a timeout is `unavailable` (RES-2), anything else `internal`; the log carries the class only. */
async function guarded<T>(artifact: ArtifactId | undefined, work: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await work();
  } catch (error) {
    const reason = error instanceof StorageError ? error.failure : "error";
    logEvent("operation.failed", { reason, error: errorName(error), ...(artifact === undefined ? {} : { artifact }) });
    return fail({ code: reason === "timeout" ? "unavailable" : "internal" });
  }
}

/** Issues for paths given twice in one list (after NFC, which the schema applied). */
function duplicateIssues(paths: readonly string[], field: (index: number) => string): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  paths.forEach((path, index) => {
    if (seen.has(path)) issues.push({ field: field(index), reason: "duplicate_path" });
    seen.add(path);
  });
  return issues;
}

const fileField = (index: number) => `files[${index}].path`;
const removeField = (index: number) => `remove[${index}]`;

/** Hashes each provided file; equal bytes become one object. */
async function hashFiles(files: readonly FileInput[]): Promise<{ rows: FileRow[]; objects: Map<string, Blob> }> {
  const fileRows: FileRow[] = [];
  const objects = new Map<string, Blob>();
  for (const file of files) {
    const sha256 = await sha256Hex(file.body);
    objects.set(sha256, file.body);
    fileRows.push({
      path: file.path,
      sha256,
      size: file.body.size,
      content_type: file.contentType ?? contentTypeFor(file.path),
    });
  }
  return { rows: fileRows, objects };
}

const totalBytes = (files: readonly FileRow[]) => files.reduce((sum, file) => sum + file.size, 0);
const byPath = (a: FileRow, b: FileRow) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function publishResult(deps: OperationDeps, advanced: AdvancedRow, version: NewVersion): PublishResult {
  const id = version.id;
  const artifact = artifactJson(
    deps,
    { ...advanced, title: version.title, description: version.description },
    version.createdAt,
  );
  const row: VersionRow = {
    number: version.number,
    created_at: version.createdAt,
    published_by: version.publishedBy,
    title: version.title,
    description: version.description,
    file_count: version.files.length,
    total_bytes: version.totalBytes,
  };
  return { artifact, version: versionJson(deps, id, row, version.files.toSorted(byPath)) };
}

/** Create (design.md sections 3 and 4): version 1 of a new artifact, private and with the archive setting unset. */
export async function createArtifact(
  deps: OperationDeps,
  token: TokenName,
  input: CreateInput,
): Promise<Result<PublishResult>> {
  const paths = input.files.map((file) => file.path);
  const issues = duplicateIssues(paths, fileField);
  if (!paths.includes(ENTRY_FILE)) issues.push({ field: "files", reason: "missing_index" });
  if (issues.length > 0) return invalid(issues);

  const id = deps.newId();
  return guarded(id, async () => {
    const { rows: files, objects } = await hashFiles(input.files);
    await uploadObjects(objectStore(deps), id, objects, new Set());
    const version: NewVersion = {
      id,
      number: 1,
      createdAt: deps.now(),
      publishedBy: token,
      title: input.title,
      description: input.description ?? "",
      files,
      totalBytes: totalBytes(files),
    };
    // A failing batch rolls back (the ID existed, ISO-1, or D1 failed) and answers `internal`; uploaded objects stay,
    // referenced by nothing.
    const results = await write(database(deps), createStatements(deps.db, version));
    const advanced = rows(results[0], ADVANCED_ROW)[0];
    if (advanced === undefined) return fail({ code: "internal" });
    logEvent("artifact.created", { token, artifact: id, version: 1 });
    return succeed(publishResult(deps, advanced, version));
  });
}

/** Why an update that committed nothing failed, from the artifact's state. */
function updateRefusal(state: StateRow | undefined, base: number): Result<never> {
  if (state === undefined || state.deleted === 1) return NOT_FOUND;
  if (state.latest_version !== base) return fail({ code: "version_conflict", latestVersion: state.latest_version });
  return fail({ code: "internal" });
}

/**
 * Update (design.md section 4): version `base + 1` from the base's files, minus `remove`, plus `files`; title and
 * description default to the base's. Commits only while `base_version` is the latest and the artifact is live (VER-3).
 */
export async function updateArtifact(
  deps: OperationDeps,
  token: TokenName,
  input: UpdateInput,
): Promise<Result<PublishResult>> {
  const id = input.id;
  if (!isArtifactId(id)) return NOT_FOUND;
  const provided = input.files ?? [];
  const removed = input.remove ?? [];
  const providedPaths = new Set(provided.map((file) => file.path));
  const inputIssues = [
    ...duplicateIssues(
      provided.map((file) => file.path),
      fileField,
    ),
    ...duplicateIssues(removed, removeField),
  ];
  removed.forEach((path, index) => {
    if (providedPaths.has(path)) inputIssues.push({ field: removeField(index), reason: "provided_and_removed" });
  });
  if (inputIssues.length > 0) return invalid(inputIssues);

  return guarded(id, async () => {
    const db = database(deps);
    const [artifactResult, filesResult] = await read(db, [
      selectArtifact(deps.db, id),
      selectFiles(deps.db, id, input.baseVersion),
    ]);
    const artifact = rows(artifactResult, ARTIFACT_ROW)[0];
    if (artifact === undefined) return NOT_FOUND;
    if (artifact.latest_version !== input.baseVersion) {
      return fail({ code: "version_conflict", latestVersion: artifact.latest_version });
    }

    const baseFiles = new Map(rows(filesResult, FILE_ROW).map((file) => [file.path, file]));
    const mergeIssues: Issue[] = [];
    removed.forEach((path, index) => {
      if (!baseFiles.has(path)) mergeIssues.push({ field: removeField(index), reason: "not_in_base" });
    });
    const merged = new Map(baseFiles);
    for (const path of removed) merged.delete(path);
    for (const path of providedPaths) merged.delete(path);
    const mergedCount = merged.size + provided.length;
    if (mergedCount > LIMITS.files) mergeIssues.push({ field: "files", reason: "too_many" });
    if (!merged.has(ENTRY_FILE) && !providedPaths.has(ENTRY_FILE)) {
      mergeIssues.push({ field: "files", reason: "missing_index" });
    }
    if (mergeIssues.length > 0) return invalid(mergeIssues);

    const { rows: newFiles, objects } = await hashFiles(provided);
    const present = new Set([...baseFiles.values()].map((file) => file.sha256));
    await uploadObjects(objectStore(deps), id, objects, present);

    const files = [...merged.values(), ...newFiles];
    const version: NewVersion = {
      id,
      number: input.baseVersion + 1,
      createdAt: deps.now(),
      publishedBy: token,
      title: input.title ?? artifact.title,
      description: input.description ?? artifact.description,
      files,
      totalBytes: totalBytes(files),
    };
    let results: D1Result[];
    try {
      results = await write(db, updateStatements(deps.db, input.baseVersion, version));
    } catch {
      // The batch rolled back: another commit took the number, the artifact went away, or D1 failed. Reading the state
      // tells which; the read has a timeout, the commit did not.
      const [state] = await read(db, [selectState(deps.db, id)]);
      return updateRefusal(rows(state, STATE_ROW)[0], input.baseVersion);
    }
    const advanced = rows(results[0], ADVANCED_ROW)[0];
    if (advanced === undefined) return updateRefusal(rows(results.at(-1), STATE_ROW)[0], input.baseVersion);
    logEvent("artifact.updated", { token, artifact: id, version: version.number });
    return succeed(publishResult(deps, advanced, version));
  });
}

export type GetInput = { readonly id: string; readonly version?: number | undefined };

/** Get: a live artifact and one version (its latest by default) with its files. */
export async function getArtifact(deps: OperationDeps, input: GetInput): Promise<Result<PublishResult>> {
  const id = input.id;
  if (!isArtifactId(id)) return NOT_FOUND;
  const number = input.version ?? null;
  return guarded(id, async () => {
    const [artifactResult, versionResult, filesResult] = await read(database(deps), [
      selectArtifact(deps.db, id),
      selectVersion(deps.db, id, number),
      selectFiles(deps.db, id, number),
    ]);
    const artifact = rows(artifactResult, ARTIFACT_ROW)[0];
    const version = rows(versionResult, VERSION_ROW)[0];
    if (artifact === undefined || version === undefined) return NOT_FOUND;
    return succeed({
      artifact: artifactJson(deps, artifact, deps.now()),
      version: versionJson(deps, id, version, rows(filesResult, FILE_ROW)),
    });
  });
}

export type ListInput = {
  readonly archived?: ArchivedFilter | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
};

const ARTIFACT_CURSOR = /^(0|[1-9][0-9]{0,15})\.([a-z2-7]{26})$/;
const INVALID_CURSOR = invalid([{ field: "cursor", reason: "invalid_cursor" }]);

/** A listing's cursor: null for the first page, undefined when `parse` refuses it. */
const cursorOf = <C>(raw: string | undefined, parse: (raw: string) => C | undefined): C | null | undefined =>
  raw === undefined ? null : parse(raw);

/** A page read with `limit + 1` rows, cut to `limit`, and the cursor naming its last row when more follow. */
function cutPage<R>(found: readonly R[], limit: number, key: (row: R) => string): { shown: R[]; next: string | null } {
  const shown = found.slice(0, limit);
  const last = shown.at(-1);
  return { shown, next: found.length > limit && last !== undefined ? key(last) : null };
}

const artifactKey = (row: ArtifactRow) => `${row.updated_at}.${row.id}`;
const versionKey = (row: VersionRow) => String(row.number);

function parseArtifactCursor(cursor: string): ArtifactCursor | undefined {
  const match = ARTIFACT_CURSOR.exec(cursor);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const updatedAt = Number(match[1]);
  return Number.isSafeInteger(updatedAt) ? { updatedAt, id: match[2] } : undefined;
}

/**
 * List (design.md section 8, "Pagination"): live artifacts in `(updated_at DESC, id DESC)` order, filtered by archive
 * state before the page is cut. The cursor names the last item's key; traversal is live, and since `updated_at` never
 * decreases, no artifact appears twice.
 */
export async function listArtifacts(deps: OperationDeps, input: ListInput): Promise<Result<ArtifactPage>> {
  const limit = input.limit ?? LIMITS.pageDefault;
  const cursor = cursorOf(input.cursor, parseArtifactCursor);
  if (cursor === undefined) return INVALID_CURSOR;
  return guarded(undefined, async () => {
    const now = deps.now();
    const [page] = await read(database(deps), [
      selectArtifactPage(deps.db, input.archived ?? "exclude", archivedBefore(deps, now), cursor, limit + 1),
    ]);
    const { shown, next } = cutPage(rows(page, ARTIFACT_ROW), limit, artifactKey);
    return succeed({ artifacts: shown.map((row) => artifactJson(deps, row, now)), next_cursor: next });
  });
}

export type ListVersionsInput = {
  readonly id: string;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
};

/** List versions: newest first, without files; the cursor names the last version's number. */
export async function listVersions(deps: OperationDeps, input: ListVersionsInput): Promise<Result<VersionPage>> {
  const id = input.id;
  if (!isArtifactId(id)) return NOT_FOUND;
  const limit = input.limit ?? LIMITS.pageDefault;
  const before = cursorOf(input.cursor, parseVersionNumber);
  if (before === undefined) return INVALID_CURSOR;
  return guarded(id, async () => {
    const [artifactResult, page] = await read(database(deps), [
      selectArtifact(deps.db, id),
      selectVersionPage(deps.db, id, before, limit + 1),
    ]);
    if (rows(artifactResult, ARTIFACT_ROW)[0] === undefined) return NOT_FOUND;
    const { shown, next } = cutPage(rows(page, VERSION_ROW), limit, versionKey);
    return succeed({ versions: shown.map((row) => versionJson(deps, id, row)), next_cursor: next });
  });
}

export type FileLookup =
  | { readonly kind: "file"; readonly id: ArtifactId; readonly file: FileJson }
  | { readonly kind: "directory" };

export type LookupInput = {
  readonly id: ArtifactId;
  readonly path: ResolvedPath;
  /** PUB-1: only while the artifact is public. */
  readonly publicOnly: boolean;
};

/**
 * The file a resolved path selects in one version of a live artifact (SRV-2), or `directory` when only its
 * `index.html` exists (a 308 to the path with `/`). Serving, the REST file route and MCP's `read_file` share it.
 */
export async function lookupFile(deps: OperationDeps, input: LookupInput): Promise<Result<FileLookup>> {
  const { id, path } = input;
  return guarded(id, async (): Promise<Result<FileLookup>> => {
    const [result] = await read(database(deps), [servedFiles(deps, input)]);
    const found = matchFile(id, path, rows(result, FILE_ROW));
    return found === undefined ? NOT_FOUND : succeed(found);
  });
}

/** `lookupFile`'s answer, or `absent`: the artifact is live and visible to the request, but the path selects nothing. */
export type ServedLookup = FileLookup | { readonly kind: "absent" };

/**
 * `lookupFile` for a path a browser host answers with a fallback when the artifact lacks it (design.md section 6):
 * `absent` only when the artifact is live and, with `publicOnly`, public, read in the same batch as its files, so a
 * private, deleted or unknown artifact stays `not_found`.
 */
export async function lookupServedFile(deps: OperationDeps, input: LookupInput): Promise<Result<ServedLookup>> {
  const { id, path } = input;
  return guarded(id, async (): Promise<Result<ServedLookup>> => {
    const [files, visible] = await read(database(deps), [
      servedFiles(deps, input),
      selectVisibleArtifact(deps.db, id, input.publicOnly),
    ]);
    const found = matchFile(id, path, rows(files, FILE_ROW));
    if (found !== undefined) return succeed(found);
    return rows(visible, VISIBLE_ROW).length > 0 ? succeed({ kind: "absent" }) : NOT_FOUND;
  });
}

const servedFiles = (deps: OperationDeps, input: LookupInput): D1PreparedStatement =>
  selectServedFiles(deps.db, input.id, input.path.version, input.publicOnly, [input.path.file, input.path.directory]);

/** The file the path names, else `directory` when only its `index.html` exists, among the rows found for both. */
function matchFile(id: ArtifactId, path: ResolvedPath, found: readonly FileRow[]): FileLookup | undefined {
  const file = found.find((row) => row.path === path.file);
  if (file !== undefined) return { kind: "file", id, file: fileJson(file) };
  if (path.directory !== null && found.some((row) => row.path === path.directory)) return { kind: "directory" };
  return undefined;
}

/** A looked-up file's bytes, under the R2 timeout. */
export async function openFile(deps: OperationDeps, id: ArtifactId, file: FileJson): Promise<Result<R2ObjectBody>> {
  return guarded(id, async () => succeed(await getObject(objectStore(deps), id, file.sha256)));
}

/** A looked-up file's bytes, fetched and read whole under the R2 timeout (MCP's `read_file`, after its size bound). */
export async function readFile(deps: OperationDeps, id: ArtifactId, file: FileJson): Promise<Result<Uint8Array>> {
  return guarded(id, async () => {
    const store = objectStore(deps);
    return succeed(await readBody(store, await getObject(store, id, file.sha256), file.size));
  });
}

export type SettingsInput = {
  readonly id: string;
  readonly public?: boolean | undefined;
  readonly archive?: ArchiveSetting | null | undefined;
};

/**
 * Public and archive (design.md sections 5 and 7): sets the flag and the setting given; creates no version and moves
 * nothing in storage (PUB-2).
 */
export async function updateSettings(
  deps: OperationDeps,
  token: TokenName,
  input: SettingsInput,
): Promise<Result<{ readonly artifact: ArtifactJson }>> {
  if (input.public === undefined && input.archive === undefined) {
    return invalid([{ field: "body", reason: "required" }]);
  }
  const id = input.id;
  if (!isArtifactId(id)) return NOT_FOUND;
  return guarded(id, async () => {
    const results = await write(database(deps), settingsStatements(deps.db, id, input));
    const artifact = rows(results[1], ARTIFACT_ROW)[0];
    if ((results[0]?.meta.changes ?? 0) === 0 || artifact === undefined) return NOT_FOUND;
    logEvent("artifact.changed", {
      token,
      artifact: id,
      ...(input.public === undefined ? {} : { public: input.public }),
      ...(input.archive === undefined ? {} : { archive: input.archive }),
    });
    return succeed({ artifact: artifactJson(deps, artifact, deps.now()) });
  });
}

/**
 * Delete (VER-4): one batch writes the tombstone and removes the rows, so every URL answers 404 at once; then the
 * prefix's objects are deleted, best effort. Repeating it for a tombstoned ID retries the cleanup and succeeds; an ID
 * that never existed is `not_found`.
 */
export async function deleteArtifact(
  deps: OperationDeps,
  token: TokenName,
  input: { readonly id: string },
): Promise<Result<{ readonly deleted: ArtifactId }>> {
  const id = input.id;
  if (!isArtifactId(id)) return NOT_FOUND;
  return guarded(id, async () => {
    const results = await write(database(deps), deleteStatements(deps.db, id, deps.now()));
    if (rows(results[0], STATE_ROW)[0] === undefined) return NOT_FOUND;
    logEvent("artifact.deleted", { token, artifact: id });
    try {
      await deletePrefix(objectStore(deps), id);
    } catch (error) {
      logEvent("cleanup.failed", {
        artifact: id,
        reason: error instanceof StorageError ? error.failure : "error",
        error: errorName(error),
      });
    }
    return succeed({ deleted: id });
  });
}

export type ArchiveCounts = { readonly active: number; readonly archived: number };
/** An artifact as the gallery lists it: with its latest version's publisher. */
export type ListedArtifact = ArtifactJson & { readonly published_by: string };
export type GalleryList = {
  readonly artifacts: readonly ListedArtifact[];
  readonly next_cursor: string | null;
  readonly counts: ArchiveCounts;
};

export type GalleryListInput = {
  readonly archived: "exclude" | "only";
  readonly limit: number;
  readonly cursor?: string | undefined;
};

const countsOf = (result: D1Result | undefined): ArchiveCounts => {
  const row = rows(result, COUNTS_ROW)[0];
  return { active: row?.active ?? 0, archived: row?.archived ?? 0 };
};

/**
 * The gallery's lists (design.md section 10): a page as `listArtifacts` gives it, each artifact with its latest
 * version's publisher, and how many live artifacts are out of the archive and in it, all from one snapshot.
 */
export async function listForGallery(deps: OperationDeps, input: GalleryListInput): Promise<Result<GalleryList>> {
  const cursor = cursorOf(input.cursor, parseArtifactCursor);
  if (cursor === undefined) return INVALID_CURSOR;
  return guarded(undefined, async () => {
    const now = deps.now();
    const before = archivedBefore(deps, now);
    const [page, counts] = await read(database(deps), [
      selectArtifactPage(deps.db, input.archived, before, cursor, input.limit + 1),
      selectArchiveCounts(deps.db, before),
    ]);
    const { shown, next } = cutPage(rows(page, LISTED_ROW), input.limit, artifactKey);
    return succeed({
      artifacts: shown.map((row) => ({ ...artifactJson(deps, row, now), published_by: row.published_by })),
      next_cursor: next,
      counts: countsOf(counts),
    });
  });
}

export type GalleryArtifact = {
  readonly artifact: ArtifactJson;
  /** The latest version, with its files. */
  readonly latest: VersionJson;
  /** Version 1, whose publisher created the artifact. */
  readonly first: VersionJson;
  /** A page of the version history, newest first, without files. */
  readonly versions: VersionPage;
  readonly counts: ArchiveCounts;
};

export type GalleryArtifactInput = {
  readonly id: string;
  readonly limit: number;
  /** The version history's cursor, as `listVersions` takes it. */
  readonly cursor?: string | undefined;
};

/**
 * The gallery's artifact page (design.md section 10): a live artifact, its latest version with its files, version 1, a
 * page of its version history, and the archive counts, all from one snapshot.
 */
export async function getForGallery(
  deps: OperationDeps,
  input: GalleryArtifactInput,
): Promise<Result<GalleryArtifact>> {
  const id = input.id;
  if (!isArtifactId(id)) return NOT_FOUND;
  const before = cursorOf(input.cursor, parseVersionNumber);
  if (before === undefined) return INVALID_CURSOR;
  return guarded(id, async () => {
    const now = deps.now();
    const [artifactResult, latestResult, filesResult, firstResult, page, counts] = await read(database(deps), [
      selectArtifact(deps.db, id),
      selectVersion(deps.db, id, null),
      selectFiles(deps.db, id, null),
      selectVersion(deps.db, id, 1),
      selectVersionPage(deps.db, id, before, input.limit + 1),
      selectArchiveCounts(deps.db, archivedBefore(deps, now)),
    ]);
    const artifact = rows(artifactResult, ARTIFACT_ROW)[0];
    const latest = rows(latestResult, VERSION_ROW)[0];
    const first = rows(firstResult, VERSION_ROW)[0];
    if (artifact === undefined || latest === undefined || first === undefined) return NOT_FOUND;
    const { shown, next } = cutPage(rows(page, VERSION_ROW), input.limit, versionKey);
    return succeed({
      artifact: artifactJson(deps, artifact, now),
      latest: versionJson(deps, id, latest, rows(filesResult, FILE_ROW)),
      first: versionJson(deps, id, first),
      versions: { versions: shown.map((row) => versionJson(deps, id, row)), next_cursor: next },
      counts: countsOf(counts),
    });
  });
}
