import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSearchContentDatabasePath,
  openSearchContentDatabase,
} from './searchContentDatabase.js'
import {
  SEARCH_CONTENT_SCHEMA_VERSION,
  UnsupportedSearchContentSchemaError,
} from './searchContentMigrations.js'

const tempDirs: string[] = []
const originalConfig = process.env.CLAUDE_CONFIG_DIR

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
