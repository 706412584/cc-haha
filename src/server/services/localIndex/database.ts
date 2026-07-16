import { statSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { getLocalIndexDatabasePath } from './config.js'
import {
  LOCAL_INDEX_BUSY_TIMEOUT_MS,
  prepareManagedDatabasePath,
} from './managedDatabasePath.js'
import {
  assertLocalIndexSchemaSupported,
  migrateLocalIndexDatabase,
} from './migrations.js'

export type LocalIndexBinding =
  | bigint
  | boolean
  | number
  | string
  | null
  | Uint8Array

export type LocalIndexRunResult = {
  changes: number
  lastInsertRowid: bigint | number
}

export type LocalIndexReadOperation = {
  get<T>(sql: string, ...bindings: LocalIndexBinding[]): T | null
  all<T>(sql: string, ...bindings: LocalIndexBinding[]): T[]
}

export type LocalIndexWriteOperation = LocalIndexReadOperation & {
  run(sql: string, ...bindings: LocalIndexBinding[]): LocalIndexRunResult
  exec(sql: string): void
}

export type LocalIndexDatabase = {
  read<T>(operation: (database: LocalIndexReadOperation) => T): T
  write<T>(operation: (database: LocalIndexWriteOperation) => T): T
  transaction<T>(operation: (database: LocalIndexWriteOperation) => T): T
  checkpointPassive?(): LocalIndexCheckpointResult
  getStorageStats?(): LocalIndexStorageStats
  close(): void
}

export type LocalIndexCheckpointResult = {
  busy: number
  logFrames: number
  checkpointedFrames: number
}

export type LocalIndexStorageStats = {
  databaseBytes: number
  walBytes: number
}

type OwnedStatement = {
  get(...bindings: LocalIndexBinding[]): unknown
  all(...bindings: LocalIndexBinding[]): unknown[]
  run(...bindings: LocalIndexBinding[]): LocalIndexRunResult
  finalize?(): void
}

const ASYNC_TRANSACTION_ERROR = 'Local index transactions must be synchronous'
const NESTED_TRANSACTION_ERROR = 'Local index transactions cannot be nested'

function consumeIfThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false
  }

  let isThenable = false
  try {
    isThenable = typeof (value as { then?: unknown }).then === 'function'
  } catch {
    isThenable = true
  }
  if (!isThenable) return false

  try {
    void Promise.resolve(value).catch(() => {})
  } catch {
    // The stable synchronous transaction error remains the primary failure.
  }
  return true
}

function configureConnection(database: Database): void {
  database.exec(`PRAGMA busy_timeout = ${LOCAL_INDEX_BUSY_TIMEOUT_MS}`)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA wal_autocheckpoint = 1000')
  database.exec(`PRAGMA journal_size_limit = ${16 * 1024 * 1024}`)
}

function fileSize(path: string): number {
  try {
    const snapshot = statSync(path)
    return snapshot.isFile() ? snapshot.size : 0
  } catch {
    return 0
  }
}

export function openLocalIndexDatabase(options?: {
  path?: string
  scope?: string
}): LocalIndexDatabase {
  const databasePath = options?.path ?? getLocalIndexDatabasePath()
  prepareManagedDatabasePath({
    databasePath,
    filename: 'index-v1.sqlite',
    scope: options?.scope ?? (options?.path ? undefined : getClaudeConfigHomeDir()),
  })
  const database = new Database(databasePath)

  try {
    assertLocalIndexSchemaSupported(database)
    configureConnection(database)
    migrateLocalIndexDatabase(database)
  } catch (error) {
    database.clearQueryCache()
    database.close(true)
    throw error
  }

  const statementCache = new Map<string, OwnedStatement>()
  let closed = false
  let transactionDepth = 0

  const assertOpen = (): void => {
    if (closed) throw new Error('Local index database is closed')
  }

  const getStatement = (sql: string): OwnedStatement => {
    const cached = statementCache.get(sql)
    if (cached) return cached

    const statement = database.query(sql) as unknown as OwnedStatement
    statementCache.set(sql, statement)
    return statement
  }

  const runOperation = <T, Operation>(
    createOperation: (assertActive: () => void) => Operation,
    operation: (database: Operation) => T,
  ): T => {
    assertOpen()
    let active = true
    const assertActive = (): void => {
      assertOpen()
      if (!active) {
        throw new Error('Local index database operation is no longer active')
      }
    }

    try {
      return operation(createOperation(assertActive))
    } finally {
      active = false
    }
  }

  const createReadOperation = (
    assertActive: () => void,
  ): LocalIndexReadOperation => ({
    get<T>(sql: string, ...bindings: LocalIndexBinding[]): T | null {
      assertActive()
      return getStatement(sql).get(...bindings) as T | null
    },
    all<T>(sql: string, ...bindings: LocalIndexBinding[]): T[] {
      assertActive()
      return getStatement(sql).all(...bindings) as T[]
    },
  })

  const createWriteOperation = (
    assertActive: () => void,
  ): LocalIndexWriteOperation => ({
    ...createReadOperation(assertActive),
    run(sql: string, ...bindings: LocalIndexBinding[]): LocalIndexRunResult {
      assertActive()
      return getStatement(sql).run(...bindings)
    },
    exec(sql: string): void {
      assertActive()
      database.exec(sql)
    },
  })

  return {
    read: operation => runOperation(createReadOperation, operation),
    write: operation => runOperation(createWriteOperation, operation),
    transaction: operation => runOperation(createWriteOperation, databaseOperation => {
      if (transactionDepth > 0) {
        throw new Error(NESTED_TRANSACTION_ERROR)
      }
      transactionDepth += 1
      try {
        let transactionStarted = false
        try {
          database.exec('BEGIN IMMEDIATE')
          transactionStarted = true
          const result = operation(databaseOperation)
          if (consumeIfThenable(result)) {
            throw new Error(ASYNC_TRANSACTION_ERROR)
          }
          database.exec('COMMIT')
          transactionStarted = false
          return result
        } catch (error) {
          if (transactionStarted) {
            try {
              database.exec('ROLLBACK')
            } catch {
              // Preserve the callback or COMMIT failure as the actionable error.
            }
          }
          throw error
        }
      } finally {
        transactionDepth -= 1
      }
    }),
    checkpointPassive(): LocalIndexCheckpointResult {
      assertOpen()
      const row = database.query<{
        busy: number
        log: number
        checkpointed: number
      }, []>('PRAGMA wal_checkpoint(PASSIVE)').get()
      return {
        busy: row?.busy ?? 0,
        logFrames: row?.log ?? 0,
        checkpointedFrames: row?.checkpointed ?? 0,
      }
    },
    getStorageStats(): LocalIndexStorageStats {
      assertOpen()
      return {
        databaseBytes: fileSize(databasePath),
        walBytes: fileSize(`${databasePath}-wal`),
      }
    },
    close() {
      if (closed) return
      for (const statement of statementCache.values()) {
        statement.finalize?.()
      }
      statementCache.clear()
      database.clearQueryCache()
      database.close(true)
      closed = true
    },
  }
}
