import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SEARCH_CONTENT_SCHEMA_UNSUPPORTED,
  SEARCH_CONTENT_SCHEMA_VERSION,
  UnsupportedSearchContentSchemaError,
  assertSearchContentSchemaSupported,
  migrateSearchContentDatabase,
} from './searchContentMigrations.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path =>
    rm(path, { recursive: true, force: true }),
  ))
})

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-schema-'))
  tempDirs.push(root)
  return join(root, 'search-index-v1.sqlite')
}

describe('search content migrations', () => {
  it('creates the disposable source, document, readiness, and trigram FTS schema', async () => {
    const database = new Database(await databasePath())
    try {
      migrateSearchContentDatabase(database)

      expect(database.query<{ user_version: number }, []>(
        'PRAGMA user_version',
      ).get()?.user_version).toBe(SEARCH_CONTENT_SCHEMA_VERSION)
      const tables = database.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
      ).all().map(row => row.name)
      expect(tables).toContain('search_sources')
      expect(tables).toContain('search_documents')
      expect(tables).toContain('search_documents_fts')
      expect(tables).toContain('search_backfill_state')

      database.exec(`
        INSERT INTO search_sources (
          path, project_path, owner_session_id, owner_transcript_path,
          modified_at_ms, size_bytes, mtime_ms, file_identity, fingerprint,
          indexed_bytes, indexed_lines, parser_version, state,
          last_error_code, updated_at_ms
        ) VALUES (
          '/nested/agent.jsonl', '-project', 'owner', '/project/owner.jsonl',
          10, 20, 10, '1:2', 'fingerprint', 20, 1, 1, 'ready', NULL, 10
        );
        INSERT INTO search_documents (
          source_path, jsonl_line, byte_start, byte_length, segment_index,
          role, message_id, timestamp, body, normalized_body
        ) VALUES (
          '/nested/agent.jsonl', 1, 0, 20, 0,
          'user', 'message-1', NULL, 'Alpha needle Omega', 'alpha needle omega'
        );
      `)

      expect(database.query<{ rowid: number }, [string]>(
        'SELECT rowid FROM search_documents_fts WHERE search_documents_fts MATCH ?',
      ).all('"needle"')).toHaveLength(1)
    } finally {
      database.close(true)
    }
  })

  it('rejects a newer schema without mutating it', async () => {
    const database = new Database(await databasePath())
    try {
      database.exec(`PRAGMA user_version = ${SEARCH_CONTENT_SCHEMA_VERSION + 1}`)

      expect(() => assertSearchContentSchemaSupported(database)).toThrow(
        UnsupportedSearchContentSchemaError,
      )
      try {
        assertSearchContentSchemaSupported(database)
      } catch (error) {
        expect((error as UnsupportedSearchContentSchemaError).code).toBe(
          SEARCH_CONTENT_SCHEMA_UNSUPPORTED,
        )
      }
      expect(database.query<{ user_version: number }, []>(
        'PRAGMA user_version',
      ).get()?.user_version).toBe(SEARCH_CONTENT_SCHEMA_VERSION + 1)
    } finally {
      database.close(true)
    }
  })
})
