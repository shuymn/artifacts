-- The data model of docs/design.md section 3. Times are milliseconds since the Unix epoch.

-- One row per artifact ID ever created. A deleted artifact keeps its row as a tombstone (deleted_at set), so the
-- primary key refuses the ID again (ISO-1).
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  latest_version INTEGER NOT NULL CHECK (latest_version >= 1),
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  archive TEXT CHECK (archive IN ('archived', 'kept')),
  deleted_at INTEGER
) STRICT;

-- The listing order of design.md section 8: (updated_at DESC, id DESC) over live artifacts.
CREATE INDEX artifacts_by_update ON artifacts (updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id),
  number INTEGER NOT NULL CHECK (number >= 1),
  created_at INTEGER NOT NULL,
  published_by TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, number)
) STRICT, WITHOUT ROWID;

CREATE TABLE version_files (
  artifact_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  PRIMARY KEY (artifact_id, number, path),
  FOREIGN KEY (artifact_id, number) REFERENCES versions (artifact_id, number)
) STRICT, WITHOUT ROWID;
