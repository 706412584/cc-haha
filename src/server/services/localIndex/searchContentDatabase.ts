import { statSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { getCcHahaDir, getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import {
  LOCAL_INDEX_BUSY_TIMEOUT_MS,
  prepareManagedDatabasePath,
  restrictManagedDatabasePermissions,
} from './managedDatabasePath.js'
import {
  assertSearchContentSchemaHealthy,
  assertSearchContentSchemaSupported,
  migrateSearchContentDatabase,
} from './searchContentMigrations.js'

export type SearchContentBinding =
  | bigint
  | boolean
  | number
  | string
  | null
  | Uint8Array

export type SearchContentRunResult = {
  changes: number
  lastInsertRowid: bigint | number
}

export type SearchContentReadOperation = {
  get<T>(sql: string, ...bindings: SearchContentBinding[]): T | null
  all<T>(sql: string, ...bindings: SearchContentBinding[]): T[]
}

export type SearchContentWriteOperation = SearchContentReadOperation & {
  run(sql: string, ...bindings: SearchContentBinding[]): SearchContentRunResult
  exec(sql: string): void
}

export type SearchContentCheckpointResult = {
  busy: number
  logFrames: number
  checkpointedFrames: number
}

export type SearchContentStorageStats = {
  databaseBytes: number
  walBytes: number
}

export type SearchContentDatabase = {
  read<T>(operation: (database: SearchContentReadOperation) => T): T
  write<T>(operation: (database: SearchContentWriteOperation) => T): T
  transaction<T>(operation: (database: SearchContentWriteOperation) => T): T
  checkpointPassive(): SearchContentCheckpointResult
  checkpointTruncate(): SearchContentCheckpointResult
  getStorageStats(): SearchContentStorageStats
  close(): void
}

type OwnedStatement = {
  get(...bindings: SearchContentBinding[]): unknown
  all(...bindings: SearchContentBinding[]): unknown[]
  run(...bindings: SearchContentBinding[]): SearchContentRunResult
  finalize?(): void
}

const ASYNC_TRANSACTION_ERROR =
  'Search content transactions must be synchronous'
const NESTED_TRANSACTION_ERROR =
  'Search content transactions cannot be nested'
const STORAGE_RESERVE_PAGES = 16
const SQLITE_FULL = 'SQLITE_FULL'

export function getSearchContentDatabasePath(): string {
  return join(getCcHahaDir(), 'db', 'search-index-v1.sqlite')
}

function fileSize(path: string): number {
  try {
    const snapshot = statSync(path)
    return snapshot.isFile() ? snapshot.size : 0
  } catch {
    return 0
  }
}

function configureConnection(database: Database): void {
  database.exec(`PRAGMA busy_timeout = ${LOCAL_INDEX_BUSY_TIMEOUT_MS}`)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA wal_autocheckpoint = 1000')
  database.exec(`PRAGMA journal_size_limit = ${16 * 1024 * 1024}`)
}

function readPragmaScalar(database: Database, sql: string): number {
  const row = database.query<Record<string, number>, []>(sql).get()
  return Object.values(row ?? {})[0] ?? 0
}

function checkpoint(database: Database, mode: 'PASSIVE' | 'TRUNCATE'): SearchContentCheckpointResult {
  const row = database.query<{
    busy: number
    log: number
    checkpointed: number
  }, []>(`PRAGMA wal_checkpoint(${mode})`).get()
  return {
    busy: row?.busy ?? 0,
    logFrames: row?.log ?? 0,
    checkpointedFrames: row?.checkpointed ?? 0,
  }
}

function sqliteFullError(message: string): Error & { code: typeof SQLITE_FULL } {
  return Object.assign(new Error(message), { code: SQLITE_FULL })
}

function setStorageLimit(database: Database, storageLimitBytes?: number): void {
  if (storageLimitBytes === undefined) return
  if (!Number.isFinite(storageLimitBytes) || storageLimitBytes <= 0) {
    throw new Error('Search content storage limit must be a positive number')
  }
  const pageSize = readPragmaScalar(database, 'PRAGMA page_size') || 4096
  const requestedPages = Math.floor(storageLimitBytes / pageSize)
  const safePageBudget = requestedPages - STORAGE_RESERVE_PAGES
  const currentPages = readPragmaScalar(database, 'PRAGMA page_count')
  if (safePageBudget < currentPages) {
    throw sqliteFullError('Search content database exceeds storage limit')
  }
  const effectivePages = readPragmaScalar(
    database,
    `PRAGMA max_page_count = ${safePageBudget}`,
  )
  if (effectivePages > safePageBudget) {
    throw sqliteFullError('Search content database exceeds storage limit')
  }
}

function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false
  }
  try {
    return typeof (value as { then?: unknown }).then === 'function'
  } catch {
    return true
  }
}

export function openSearchContentDatabase(options?: {
  path?: string
  scope?: string
  storageLimitBytes?: number
}): SearchContentDatabase {
  const databasePath = options?.path ?? getSearchContentDatabasePath()
  prepareManagedDatabasePath({
    databasePath,
    filename: 'search-index-v1.sqlite',
    scope: options?.scope ?? (options?.path ? undefined : getClaudeConfigHomeDir()),
  })
  const database = new Database(databasePath)

  try {
    assertSearchContentSchemaSupported(database)
    configureConnection(database)
    migrateSearchContentDatabase(database)
    setStorageLimit(database, options?.storageLimitBytes)
    assertSearchContentSchemaHealthy(database)
    restrictManagedDatabasePermissions(databasePath)
  } catch (error) {
    database.clearQueryCache()
    database.close(true)
    throw error
  }

  const statements = new Map<string, OwnedStatement>()
  let closed = false
  let transactionDepth = 0

  const assertOpen = (): void => {
    if (closed) throw new Error('Search content database is closed')
  }
  const statement = (sql: string): OwnedStatement => {
    const cached = statements.get(sql)
    if (cached) return cached
    const created = database.query(sql) as unknown as OwnedStatement
    statements.set(sql, created)
    return created
  }
  const createReadOperation = (): SearchContentReadOperation => ({
    get<T>(sql: string, ...bindings: SearchContentBinding[]): T | null {
      assertOpen()
      return statement(sql).get(...bindings) as T | null
    },
    all<T>(sql: string, ...bindings: SearchContentBinding[]): T[] {
      assertOpen()
      return statement(sql).all(...bindings) as T[]
    },
  })
  const createWriteOperation = (): SearchContentWriteOperation => ({
    ...createReadOperation(),
    run(sql: string, ...bindings: SearchContentBinding[]) {
      assertOpen()
      return statement(sql).run(...bindings)
    },
    exec(sql: string) {
      assertOpen()
      database.exec(sql)
    },
  })

  return {
    read(operation) {
      assertOpen()
      return operation(createReadOperation())
    },
    write(operation) {
      assertOpen()
      return operation(createWriteOperation())
    },
    transaction(operation) {
      assertOpen()
      if (transactionDepth > 0) throw new Error(NESTED_TRANSACTION_ERROR)
      transactionDepth += 1
      let started = false
      try {
        database.exec('BEGIN IMMEDIATE')
        started = true
        const result = operation(createWriteOperation())
        if (isThenable(result)) throw new Error(ASYNC_TRANSACTION_ERROR)
        database.exec('COMMIT')
        started = false
        return result
      } catch (error) {
        if (started) {
          try {
            database.exec('ROLLBACK')
          } catch {
            // Preserve the original transaction or COMMIT failure.
          }
        }
        throw error
      } finally {
        transactionDepth -= 1
      }
    },
    checkpointPassive() {
      assertOpen()
      return checkpoint(database, 'PASSIVE')
    },
    checkpointTruncate() {
      assertOpen()
      return checkpoint(database, 'TRUNCATE')
    },
    getStorageStats() {
      assertOpen()
      return {
        databaseBytes: fileSize(databasePath),
        walBytes: fileSize(`${databasePath}-wal`),
      }
    },
    close() {
      if (closed) return
      for (const owned of statements.values()) owned.finalize?.()
      statements.clear()
      database.clearQueryCache()
      database.close(true)
      closed = true
    },
  }
}
