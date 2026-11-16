/**
 * Metadata in D1 (design.md section 3). Every value is bound, and no statement has more than 100 bound parameters
 * (D1's limit). Reads run under a timeout (RES-2); a write batch does not, since a write that timed out could still
 * apply. A batch is one transaction that a failing statement rolls back (VER-2).
 */
import type { ArtifactId } from "./id.ts";
import { StorageError } from "./objects.ts";
import { TimeoutError, withTimeout, type Timeouts } from "./timeout.ts";

export type Database = { readonly db: D1Database; readonly timeouts: Timeouts };

/** A column's type as D1 returns it: TEXT as a string, INTEGER as a number, NULL as null. */
type ColumnType = "text" | "integer" | "nullable_text";
type Shape = Readonly<Record<string, ColumnType>>;
export type Row<S extends Shape> = {
  readonly [K in keyof S]: S[K] extends "text" ? string : S[K] extends "integer" ? number : string | null;
};

const ADVANCED_SHAPE = {
  id: "text",
  created_at: "integer",
  updated_at: "integer",
  latest_version: "integer",
  public: "integer",
  archive: "nullable_text",
} as const satisfies Shape;
export const ARTIFACT_ROW = { ...ADVANCED_SHAPE, title: "text", description: "text" } as const satisfies Shape;
export const VERSION_ROW = {
  number: "integer",
  created_at: "integer",
  published_by: "text",
  title: "text",
  description: "text",
  file_count: "integer",
  total_bytes: "integer",
} as const satisfies Shape;
export const FILE_ROW = {
  path: "text",
  sha256: "text",
  size: "integer",
  content_type: "text",
} as const satisfies Shape;
/** The artifact columns a commit returns; the title and description come from the version it wrote. */
export const ADVANCED_ROW = ADVANCED_SHAPE;
export const STATE_ROW = { latest_version: "integer", deleted: "integer" } as const satisfies Shape;
/** A listed artifact with its latest version's publisher, which the gallery shows. */
export const LISTED_ROW = { ...ARTIFACT_ROW, published_by: "text" } as const satisfies Shape;
export const COUNTS_ROW = { active: "integer", archived: "integer" } as const satisfies Shape;
/** A live artifact a request may see (`selectVisibleArtifact`). */
export const VISIBLE_ROW = { visible: "integer" } as const satisfies Shape;

export type ArtifactRow = Row<typeof ARTIFACT_ROW>;
export type VersionRow = Row<typeof VERSION_ROW>;
export type FileRow = Row<typeof FILE_ROW>;
export type AdvancedRow = Row<typeof ADVANCED_ROW>;
export type StateRow = Row<typeof STATE_ROW>;

function isRow<S extends Shape>(value: unknown, shape: S): value is Row<S> {
  if (typeof value !== "object" || value === null) return false;
  for (const [column, type] of Object.entries(shape)) {
    const field: unknown = Reflect.get(value, column);
    const fits =
      type === "integer"
        ? typeof field === "number"
        : type === "text"
          ? typeof field === "string"
          : field === null || typeof field === "string";
    if (!fits) return false;
  }
  return true;
}

/** The rows of a result, each checked against the columns the query selects. */
export function rows<S extends Shape>(result: D1Result | undefined, shape: S): Row<S>[] {
  const checked: Row<S>[] = [];
  for (const value of result?.results ?? []) {
    if (!isRow(value, shape)) throw new Error("D1 returned a row of another shape");
    checked.push(value);
  }
  return checked;
}

/** One D1 read batch (a consistent snapshot) under the read timeout. */
export async function read(database: Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await withTimeout(database.db.batch(statements), database.timeouts.d1ReadMs);
  } catch (error) {
    throw new StorageError(error instanceof TimeoutError ? "timeout" : "error");
  }
}

/** One D1 write batch, without a timeout. */
export function write(database: Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  return database.db.batch(statements);
}

const ARTIFACT_COLUMNS =
  "a.id, a.created_at, a.updated_at, a.latest_version, a.public, a.archive, v.title, v.description";
const ADVANCED_COLUMNS = "id, created_at, updated_at, latest_version, public, archive";
const VERSION_COLUMNS = "v.number, v.created_at, v.published_by, v.title, v.description, v.file_count, v.total_bytes";

/** A live artifact with its latest version's title and description. */
export function selectArtifact(db: D1Database, id: ArtifactId): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts a
       JOIN versions v ON v.artifact_id = a.id AND v.number = a.latest_version
       WHERE a.id = ?1 AND a.deleted_at IS NULL`,
    )
    .bind(id);
}

/** Version `number` of a live artifact, or its latest when `number` is null. */
export function selectVersion(db: D1Database, id: ArtifactId, number: number | null): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${VERSION_COLUMNS} FROM versions v
       JOIN artifacts a ON a.id = v.artifact_id AND a.deleted_at IS NULL
       WHERE v.artifact_id = ?1 AND v.number = COALESCE(?2, a.latest_version)`,
    )
    .bind(id, number);
}

/** The files of version `number` of a live artifact (its latest when null), by path. */
export function selectFiles(db: D1Database, id: ArtifactId, number: number | null): D1PreparedStatement {
  return db
    .prepare(
      `SELECT f.path, f.sha256, f.size, f.content_type FROM version_files f
       JOIN artifacts a ON a.id = f.artifact_id AND a.deleted_at IS NULL
       WHERE f.artifact_id = ?1 AND f.number = COALESCE(?2, a.latest_version)
       ORDER BY f.path`,
    )
    .bind(id, number);
}

/**
 * The files named `paths` (up to two: a file and a directory's index) in version `number` of a live artifact (its
 * latest when null); with `publicOnly`, only while the artifact is public (PUB-1).
 */
export function selectServedFiles(
  db: D1Database,
  id: ArtifactId,
  number: number | null,
  publicOnly: boolean,
  paths: readonly [string | null, string | null],
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT f.path, f.sha256, f.size, f.content_type FROM artifacts a
       JOIN version_files f ON f.artifact_id = a.id AND f.number = COALESCE(?2, a.latest_version)
       WHERE a.id = ?1 AND a.deleted_at IS NULL AND (?3 = 0 OR a.public = 1) AND f.path IN (?4, ?5)`,
    )
    .bind(id, number, publicOnly ? 1 : 0, paths[0], paths[1]);
}

/**
 * One row when artifact `id` is live and, with `publicOnly`, public (PUB-1): whether a browser host may serve it at
 * all, whatever the path. Read in the same batch as `selectServedFiles`, both see the same state.
 */
export function selectVisibleArtifact(db: D1Database, id: ArtifactId, publicOnly: boolean): D1PreparedStatement {
  return db
    .prepare(
      `SELECT 1 AS visible FROM artifacts a WHERE a.id = ?1 AND a.deleted_at IS NULL AND (?2 = 0 OR a.public = 1)`,
    )
    .bind(id, publicOnly ? 1 : 0);
}

export type ArtifactCursor = { readonly updatedAt: number; readonly id: string };

/**
 * Whether artifact `a` is archived (design.md section 5), with `param` the placeholder bound to the time before which an
 * unset setting means archived.
 */
const archivedSql = (param: string) => `(a.archive IS 'archived' OR (a.archive IS NULL AND a.updated_at < ${param}))`;

/**
 * A page of live artifacts in `(updated_at DESC, id DESC)` order after `cursor`, filtered by the archive state
 * (design.md section 5) before the page is cut, each with its latest version's publisher (LISTED_ROW). `archivedBefore`
 * is the time before which an unset setting means archived.
 */
export function selectArtifactPage(
  db: D1Database,
  filter: "exclude" | "only" | "include",
  archivedBefore: number,
  cursor: ArtifactCursor | null,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${ARTIFACT_COLUMNS}, v.published_by FROM artifacts a
       JOIN versions v ON v.artifact_id = a.id AND v.number = a.latest_version
       WHERE a.deleted_at IS NULL
         AND (?1 = 'include' OR (?1 = 'only') = ${archivedSql("?2")})
         AND (?3 IS NULL OR a.updated_at < ?3 OR (a.updated_at = ?3 AND a.id < ?4))
       ORDER BY a.updated_at DESC, a.id DESC
       LIMIT ?5`,
    )
    .bind(filter, archivedBefore, cursor?.updatedAt ?? null, cursor?.id ?? null, limit);
}

/** How many live artifacts are out of the archive and in it (COUNTS_ROW), by selectArtifactPage's rule. */
export function selectArchiveCounts(db: D1Database, archivedBefore: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COALESCE(SUM(NOT archived), 0) AS active, COALESCE(SUM(archived), 0) AS archived
       FROM (SELECT ${archivedSql("?1")} AS archived FROM artifacts a WHERE a.deleted_at IS NULL)`,
    )
    .bind(archivedBefore);
}

/** A page of an artifact's versions in `number DESC` order below `before`. */
export function selectVersionPage(
  db: D1Database,
  id: ArtifactId,
  before: number | null,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${VERSION_COLUMNS} FROM versions v
       WHERE v.artifact_id = ?1 AND (?2 IS NULL OR v.number < ?2)
       ORDER BY v.number DESC
       LIMIT ?3`,
    )
    .bind(id, before, limit);
}

export type NewVersion = {
  readonly id: ArtifactId;
  readonly number: number;
  readonly createdAt: number;
  readonly publishedBy: string;
  readonly title: string;
  readonly description: string;
  readonly files: readonly FileRow[];
  readonly totalBytes: number;
};

/** Rows of `version_files` per statement: 4 bound values each plus 2 for the condition, 98 in all. */
const FILE_ROWS_PER_STATEMENT = 24;

/**
 * The statements after the artifact row of a publish commit (design.md section 3, step 4): the version row and every
 * `version_files` row, each conditioned on the artifact being live at the new version. When the first statement did
 * not advance the row they insert nothing; when another commit advanced it to the same number, the version's primary
 * key fails and the batch rolls back.
 */
function versionStatements(db: D1Database, version: NewVersion): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(
        `INSERT INTO versions (artifact_id, number, created_at, published_by, title, description, file_count, total_bytes)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM artifacts
         WHERE id = ?1 AND latest_version = ?2 AND deleted_at IS NULL`,
      )
      .bind(
        version.id,
        version.number,
        version.createdAt,
        version.publishedBy,
        version.title,
        version.description,
        version.files.length,
        version.totalBytes,
      ),
  ];
  for (let start = 0; start < version.files.length; start += FILE_ROWS_PER_STATEMENT) {
    const chunk = version.files.slice(start, start + FILE_ROWS_PER_STATEMENT);
    const values = chunk.map(() => "(?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO version_files (artifact_id, number, path, sha256, size, content_type)
           SELECT a.id, a.latest_version, f.column1, f.column2, f.column3, f.column4
           FROM (VALUES ${values}) AS f
           JOIN artifacts a ON a.id = ? AND a.latest_version = ? AND a.deleted_at IS NULL`,
        )
        .bind(
          ...chunk.flatMap((file) => [file.path, file.sha256, file.size, file.content_type]),
          version.id,
          version.number,
        ),
    );
  }
  return statements;
}

/** A create's commit: the artifact row (its primary key refuses an ID that ever existed, ISO-1), then the version. */
export function createStatements(db: D1Database, version: NewVersion): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO artifacts (id, created_at, updated_at, latest_version, public, archive, deleted_at)
         VALUES (?1, ?2, ?2, 1, 0, NULL, NULL)
         RETURNING ${ADVANCED_COLUMNS}`,
      )
      .bind(version.id, version.createdAt),
    ...versionStatements(db, version),
  ];
}

/**
 * An update's commit: the artifact row advanced from `base` while live, `updated_at` never decreasing, then the version;
 * last, the artifact's state, which tells a conflict from a deletion when nothing advanced.
 */
export function updateStatements(db: D1Database, base: number, version: NewVersion): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE artifacts SET latest_version = ?3, updated_at = MAX(?4, updated_at)
         WHERE id = ?1 AND latest_version = ?2 AND deleted_at IS NULL
         RETURNING ${ADVANCED_COLUMNS}`,
      )
      .bind(version.id, base, version.number, version.createdAt),
    ...versionStatements(db, version),
    selectState(db, version.id),
  ];
}

/** Whether an ID exists, is deleted, and its latest version. */
export function selectState(db: D1Database, id: ArtifactId): D1PreparedStatement {
  return db.prepare("SELECT latest_version, deleted_at IS NOT NULL AS deleted FROM artifacts WHERE id = ?1").bind(id);
}

/** VER-4: the tombstone and the removal of every version row in one batch; first, whether the ID ever existed. */
export function deleteStatements(db: D1Database, id: ArtifactId, now: number): D1PreparedStatement[] {
  return [
    selectState(db, id),
    db.prepare("UPDATE artifacts SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL").bind(id, now),
    db.prepare("DELETE FROM version_files WHERE artifact_id = ?1").bind(id),
    db.prepare("DELETE FROM versions WHERE artifact_id = ?1").bind(id),
  ];
}

/** The public flag and archive setting of a live artifact, each when given; then the artifact. */
export function settingsStatements(
  db: D1Database,
  id: ArtifactId,
  settings: { readonly public?: boolean | undefined; readonly archive?: string | null | undefined },
): D1PreparedStatement[] {
  const publicValue = settings.public === undefined ? null : settings.public ? 1 : 0;
  const archiveGiven = settings.archive === undefined ? 0 : 1;
  return [
    db
      .prepare(
        `UPDATE artifacts SET public = COALESCE(?2, public), archive = CASE WHEN ?3 = 1 THEN ?4 ELSE archive END
         WHERE id = ?1 AND deleted_at IS NULL`,
      )
      .bind(id, publicValue, archiveGiven, settings.archive ?? null),
    selectArtifact(db, id),
  ];
}
