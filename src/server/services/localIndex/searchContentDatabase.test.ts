import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSearchContentDatabasePath,
  openSearchContentDatabase,
  type SearchContentDatabase,
} from './searchContentDatabase.js'
import {
  SEARCH_CONTENT_SCHEMA_VERSION,
  UnsupportedSearchContentSchemaError,
} from './searchContentMigrations.js'

const tempDirs: string[] = []
const originalConfig = process.env.CLAUDE_CONFIG_DIR

function pageMetrics(database: SearchContentDatabase): {
  pageSize: number
  pageCount: number
  maxPageCount: number
} {
  return database.read(reader => ({
    pageSize: reader.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0,
    pageCount: reader.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0,
    maxPageCount: reader.get<{ max_page_count: number }>(
      'PRAGMA max_page_count',
    )?.max_page_count ?? 0,
  }))
}

function databaseFamilyBytes(database: SearchContentDatabase): number {
  const stats = database.getStorageStats()
  return stats.databaseBytes + stats.walBytes
}

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  await Promise.all(tempDirs.splice(0).map(path =>
    rm(path, { recursive: true, force: true }),
  ))
})

describe('search content database', () => {
  it('uses a dedicated managed database and exposes bounded storage operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-database-'))
    tempDirs.push(root)
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')

    expect(getSearchContentDatabasePath()).toBe(
      join(root, 'config', 'cc-haha', 'db', 'search-index-v1.sqlite'),
    )
    const database = openSearchContentDatabase()
    try {
      database.write(writer => writer.run(
        `INSERT INTO search_backfill_state (
          scope, state, generation, discovered, indexed, degraded,
          last_error_code, updated_at_ms
        ) VALUES (?, 'building', 1, 0, 0, 0, NULL, 1)`,
        '/scope',
      ))
      expect(database.getStorageStats().databaseBytes).toBeGreaterThan(0)
      expect(database.getStorageStats().walBytes).toBeGreaterThanOrEqual(0)
      expect(database.checkpointPassive()).toMatchObject({
        busy: expect.any(Number),
        logFrames: expect.any(Number),
        checkpointedFrames: expect.any(Number),
      })
    } finally {
      database.close()
    }
  })

  it('rejects non-positive and non-finite storage limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-database-invalid-cap-'))
    tempDirs.push(root)

    for (const [filename, storageLimitBytes] of [
      ['zero.sqlite', 0],
      ['nan.sqlite', Number.NaN],
    ] as const) {
      expect(() => openSearchContentDatabase({
        path: join(root, filename),
        storageLimitBytes,
      })).toThrow('Search content storage limit must be a positive number')
    }
  })

  it('sets a conservative hard page cap only when a storage limit is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-database-cap-'))
    tempDirs.push(root)
    const defaultDatabase = openSearchContentDatabase({
      path: join(root, 'default.sqlite'),
    })
    try {
      expect(pageMetrics(defaultDatabase).maxPageCount).toBeGreaterThan(1_000_000)
    } finally {
      defaultDatabase.close()
    }

    const cappedDatabase = openSearchContentDatabase({
      path: join(root, 'capped.sqlite'),
      storageLimitBytes: 256 * 1024,
    })
    try {
      const metrics = pageMetrics(cappedDatabase)
      expect(metrics.pageCount).toBeGreaterThan(0)
      expect(metrics.maxPageCount).toBeLessThan(256 * 1024 / metrics.pageSize)
      expect(metrics.maxPageCount).toBeGreaterThanOrEqual(metrics.pageCount)
    } finally {
      cappedDatabase.close()
    }
  })

  it('truncates WAL and keeps the main plus WAL family under the hard cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-database-truncate-'))
    tempDirs.push(root)
    const database = openSearchContentDatabase({
      path: join(root, 'search.sqlite'),
      storageLimitBytes: 256 * 1024,
    })
    try {
      const metrics = pageMetrics(database)
      const hardCapBytes = metrics.pageSize * metrics.maxPageCount
      expect(database.getStorageStats().walBytes).toBeGreaterThan(0)

      expect(database.checkpointTruncate()).toMatchObject({
        busy: 0,
        logFrames: expect.any(Number),
        checkpointedFrames: expect.any(Number),
      })
      expect(database.getStorageStats().walBytes).toBe(0)
      expect(databaseFamilyBytes(database)).toBeLessThanOrEqual(hardCapBytes)
    } finally {
      database.close()
    }
  })

  it('keeps SQLITE_FULL recognizable and atomically rolls back failed transactions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-database-full-'))
    tempDirs.push(root)
    const database = openSearchContentDatabase({
      path: join(root, 'search.sqlite'),
      storageLimitBytes: 128 * 1024,
    })
    try {
      database.write(writer => writer.run(
        `INSERT INTO search_sources (
          path, project_path, owner_session_id, owner_transcript_path,
          modified_at_ms, size_bytes, mtime_ms, file_identity, fingerprint,
          indexed_bytes, indexed_lines, parser_version, state,
          last_error_code, updated_at_ms
        ) VALUES (?, ?, ?, ?, 1, 1, 1, NULL, ?, 0, 0, 1, 'ready', NULL, 1)`,
        '/source',
        '/project',
        'session',
        '/owner',
        'fingerprint',
      ))

      try {
        database.transaction(writer => {
          writer.run(
            `INSERT INTO search_backfill_state (
              scope, state, generation, discovered, indexed, degraded,
              last_error_code, updated_at_ms
            ) VALUES (?, 'building', 1, 1, 0, 0, NULL, 1)`,
            '/scope',
          )
          writer.run(
            `INSERT INTO search_documents (
              source_path, jsonl_line, byte_start, byte_length, segment_index,
              role, message_id, timestamp, body, normalized_body
            ) VALUES (?, 1, 0, ?, 0, 'user', NULL, NULL, ?, ?)`,
            '/source',
            100_000,
            'x'.repeat(100_000),
            'x'.repeat(100_000),
          )
        })
        throw new Error('expected sqlite full')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('SQLITE_FULL')
      }

      expect(database.read(reader => ({
        backfillRows: reader.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM search_backfill_state',
        )?.count ?? 0,
        documentRows: reader.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM search_documents',
        )?.count ?? 0,
      }))).toEqual({ backfillRows: 0, documentRows: 0 })
    } finally {
      database.close()
    }
  })

  it('fails closed when the storage limit cannot hold the migrated schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-database-too-small-'))
    tempDirs.push(root)

    try {
      openSearchContentDatabase({
        path: join(root, 'search.sqlite'),
        storageLimitBytes: 32 * 1024,
      })
      throw new Error('expected storage limit failure')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('SQLITE_FULL')
    }
  })

  it('classifies a partially missing current schema as confirmed corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-database-corrupt-'))
    tempDirs.push(root)
    const path = join(root, 'search-index-v1.sqlite')
    const created = openSearchContentDatabase({ path })
    created.close()
    const damaged = new Database(path)
    damaged.exec('DROP TABLE search_documents_fts')
    damaged.close(true)

    try {
      openSearchContentDatabase({ path })
      throw new Error('expected corruption classification')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('SQLITE_CORRUPT')
    }
  })

  it('does not classify or rebuild a future schema as corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-database-future-'))
    tempDirs.push(root)
    const path = join(root, 'search-index-v1.sqlite')
    const future = new Database(path)
    future.exec(`PRAGMA user_version = ${SEARCH_CONTENT_SCHEMA_VERSION + 1}`)
    future.close(true)

    expect(() => openSearchContentDatabase({ path })).toThrow(
      UnsupportedSearchContentSchemaError,
    )
    const inspected = new Database(path, { readonly: true })
    try {
      expect(inspected.query<{ user_version: number }, []>(
        'PRAGMA user_version',
      ).get()?.user_version).toBe(SEARCH_CONTENT_SCHEMA_VERSION + 1)
    } finally {
      inspected.close(true)
    }
  })
})
