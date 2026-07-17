import type { Database } from 'bun:sqlite'

export const SCHEDULED_RUN_INDEX_SCHEMA_VERSION = 2
export const SCHEDULED_RUN_INDEX_SCHEMA_UNSUPPORTED =
  'SCHEDULED_RUN_INDEX_SCHEMA_UNSUPPORTED' as const

const SCHEMA_V2 = `
CREATE TABLE scheduled_run_source (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  source_path TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime_ms REAL NOT NULL,
  source_fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'degraded')),
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE scheduled_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  started_at_ms REAL NOT NULL,
  completed_at TEXT,
  completed_at_ms REAL,
  status TEXT NOT NULL,
  has_output INTEGER NOT NULL CHECK (has_output IN (0, 1)),
  has_error INTEGER NOT NULL CHECK (has_error IN (0, 1)),
  exit_code REAL,
  duration_ms REAL,
  session_id TEXT,
  source_ordinal INTEGER NOT NULL,
  revision INTEGER NOT NULL
);

CREATE INDEX scheduled_runs_order_idx
  ON scheduled_runs(started_at_ms DESC, source_ordinal ASC, run_id ASC);
CREATE INDEX scheduled_runs_task_order_idx
  ON scheduled_runs(task_id, started_at_ms DESC, source_ordinal ASC, run_id ASC);
CREATE INDEX scheduled_runs_terminal_completion_idx
  ON scheduled_runs(status, completed_at_ms, started_at_ms DESC, source_ordinal ASC, run_id ASC);
`

export class UnsupportedScheduledRunIndexSchemaError extends Error {
  readonly code = SCHEDULED_RUN_INDEX_SCHEMA_UNSUPPORTED

  constructor() {
    super('Unsupported scheduled-run index database schema')
    this.name = 'UnsupportedScheduledRunIndexSchemaError'
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

export function assertScheduledRunIndexSchemaSupported(database: Database): void {
  if (getUserVersion(database) > SCHEDULED_RUN_INDEX_SCHEMA_VERSION) {
    throw new UnsupportedScheduledRunIndexSchemaError()
  }
}

export function migrateScheduledRunIndexDatabase(database: Database): void {
  const currentVersion = getUserVersion(database)
  if (currentVersion > SCHEDULED_RUN_INDEX_SCHEMA_VERSION) {
    throw new UnsupportedScheduledRunIndexSchemaError()
  }
  if (currentVersion === SCHEDULED_RUN_INDEX_SCHEMA_VERSION) return

  if (currentVersion === 0) {
    database.transaction(() => {
      database.exec(SCHEMA_V2)
      database.exec(`PRAGMA user_version = ${SCHEDULED_RUN_INDEX_SCHEMA_VERSION}`)
    })()
    return
  }

  // v1 persisted prompt-derived names, body previews, and full run JSON. This
  // projection is disposable, so rebuild it under secure_delete and VACUUM
  // instead of copying sensitive columns into the metadata-only schema.
  database.exec('PRAGMA secure_delete = ON')
  database.transaction(() => {
    database.exec('DROP TABLE scheduled_runs')
    database.exec('DROP TABLE scheduled_run_source')
    database.exec(SCHEMA_V2)
    database.exec(`PRAGMA user_version = ${SCHEDULED_RUN_INDEX_SCHEMA_VERSION}`)
  })()
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  database.exec('VACUUM')
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
}
