import type { Database } from 'bun:sqlite'

export const SEARCH_CONTENT_SCHEMA_VERSION = 1
export const SEARCH_CONTENT_SCHEMA_UNSUPPORTED =
  'SEARCH_CONTENT_SCHEMA_UNSUPPORTED' as const
export const SEARCH_CONTENT_SCHEMA_CORRUPT = 'SQLITE_CORRUPT' as const

const REQUIRED_SCHEMA_OBJECTS = [
  ['table', 'search_sources'],
  ['table', 'search_documents'],
  ['table', 'search_documents_fts'],
  ['table', 'search_backfill_state'],
  ['trigger', 'search_documents_after_insert'],
  ['trigger', 'search_documents_after_delete'],
  ['trigger', 'search_documents_after_update'],
] as const

const RELATIONAL_SCHEMA_PROBES = [
  `SELECT
    path, project_path, owner_session_id, owner_transcript_path,
    modified_at_ms, size_bytes, mtime_ms, file_identity, fingerprint,
    indexed_bytes, indexed_lines, parser_version, state,
    last_error_code, updated_at_ms
   FROM search_sources LIMIT 1`,
  `SELECT
    id, source_path, jsonl_line, byte_start, byte_length, segment_index,
    role, message_id, timestamp, body, normalized_body
   FROM search_documents LIMIT 1`,
  `SELECT
    scope, state, generation, discovered, indexed, degraded,
    last_error_code, updated_at_ms
   FROM search_backfill_state LIMIT 1`,
] as const

const SCHEMA_V1 = `
CREATE TABLE search_sources (
  path TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  owner_transcript_path TEXT NOT NULL,
  modified_at_ms REAL NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  file_identity TEXT,
  fingerprint TEXT NOT NULL,
  indexed_bytes INTEGER NOT NULL DEFAULT 0,
  indexed_lines INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'pending', 'degraded')),
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX search_sources_owner_idx
  ON search_sources(owner_transcript_path, path);
CREATE INDEX search_sources_project_modified_idx
  ON search_sources(project_path, modified_at_ms DESC, owner_transcript_path, path);

CREATE TABLE search_documents (
  id INTEGER PRIMARY KEY,
  source_path TEXT NOT NULL REFERENCES search_sources(path) ON DELETE CASCADE,
  jsonl_line INTEGER NOT NULL CHECK (jsonl_line > 0),
  byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  message_id TEXT,
  timestamp TEXT,
  body TEXT NOT NULL,
  normalized_body TEXT NOT NULL,
  UNIQUE (source_path, jsonl_line, segment_index)
);

CREATE INDEX search_documents_source_line_idx
  ON search_documents(source_path, jsonl_line, segment_index);

CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  normalized_body,
  content='search_documents',
  content_rowid='id',
  tokenize='trigram case_sensitive 0'
);

CREATE TRIGGER search_documents_after_insert AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_documents_fts(rowid, normalized_body)
  VALUES (new.id, new.normalized_body);
END;

CREATE TRIGGER search_documents_after_delete AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts, rowid, normalized_body)
  VALUES ('delete', old.id, old.normalized_body);
END;

CREATE TRIGGER search_documents_after_update AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts, rowid, normalized_body)
  VALUES ('delete', old.id, old.normalized_body);
  INSERT INTO search_documents_fts(rowid, normalized_body)
  VALUES (new.id, new.normalized_body);
END;

CREATE TABLE search_backfill_state (
  scope TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'degraded')),
  generation INTEGER NOT NULL DEFAULT 0,
  discovered INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL
);
`

export class UnsupportedSearchContentSchemaError extends Error {
  readonly code = SEARCH_CONTENT_SCHEMA_UNSUPPORTED

  constructor() {
    super('Unsupported search content database schema')
    this.name = 'UnsupportedSearchContentSchemaError'
  }
}

export class CorruptSearchContentSchemaError extends Error {
  readonly code = SEARCH_CONTENT_SCHEMA_CORRUPT

  constructor() {
    super('Search content database schema is incomplete or corrupt')
    this.name = 'CorruptSearchContentSchemaError'
  }
}

function getUserVersion(database: Database): number {
  const statement = database.prepare<{ user_version: number }, []>(
    'PRAGMA user_version',
  )
  try {
    return statement.get()?.user_version ?? 0
  } finally {
    statement.finalize()
  }
}

export function assertSearchContentSchemaSupported(database: Database): void {
  if (getUserVersion(database) > SEARCH_CONTENT_SCHEMA_VERSION) {
    throw new UnsupportedSearchContentSchemaError()
  }
}

export function migrateSearchContentDatabase(database: Database): void {
  const currentVersion = getUserVersion(database)
  if (currentVersion > SEARCH_CONTENT_SCHEMA_VERSION) {
    throw new UnsupportedSearchContentSchemaError()
  }
  if (currentVersion === SEARCH_CONTENT_SCHEMA_VERSION) return

  database.transaction(() => {
    database.exec(SCHEMA_V1)
    database.exec(`PRAGMA user_version = ${SEARCH_CONTENT_SCHEMA_VERSION}`)
  })()
}

function isStructuralFailure(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  if (
    typeof code === 'string' &&
    (code.toUpperCase().startsWith('SQLITE_CORRUPT') ||
      code.toUpperCase() === 'SQLITE_NOTADB')
  ) return true
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return message.includes('no such table') ||
    message.includes('no such column') ||
    message.includes('no such module') ||
    message.includes('malformed database schema') ||
    message.includes('database disk image is malformed')
}

/** Fast startup probe for a disposable current-version search projection. */
export function assertSearchContentSchemaHealthy(database: Database): void {
  try {
    const statement = database.prepare<{
      type: string
      name: string
    }, []>(`
      SELECT type, name
      FROM sqlite_master
      WHERE name LIKE 'search_%'
    `)
    let rows: Array<{ type: string; name: string }>
    try {
      rows = statement.all()
    } finally {
      statement.finalize()
    }
    const objects = new Set(rows.map(row => `${row.type}:${row.name}`))
    if (REQUIRED_SCHEMA_OBJECTS.some(([type, name]) =>
      !objects.has(`${type}:${name}`))) {
      throw new CorruptSearchContentSchemaError()
    }

    for (const sql of RELATIONAL_SCHEMA_PROBES) {
      const relationalProbe = database.prepare<unknown, []>(sql)
      try {
        relationalProbe.get()
      } finally {
        relationalProbe.finalize()
      }
    }

    const ftsProbe = database.prepare<{ rowid: number }, [string]>(`
      SELECT rowid
      FROM search_documents_fts
      WHERE search_documents_fts MATCH ?
      LIMIT 1
    `)
    try {
      ftsProbe.get('"cc-haha-search-health-probe"')
    } finally {
      ftsProbe.finalize()
    }
  } catch (error) {
    if (error instanceof CorruptSearchContentSchemaError) throw error
    if (isStructuralFailure(error)) throw new CorruptSearchContentSchemaError()
    throw error
  }
}
