import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export type LocalIndexErrorCode =
  | 'SQLITE_CORRUPT'
  | 'SQLITE_BUSY'
  | 'SCHEMA_UNSUPPORTED'
  | 'DISK_WRITE_FAILED'
  | 'SOURCE_PARSE_DEGRADED'
  | 'LOCAL_INDEX_START_FAILED'

export type LocalIndexBackupReason = 'SQLITE_CORRUPT' | 'MANUAL_REBUILD'

export type LocalIndexBackupResult = {
  backupPath: string
  movedFiles: number
  removedBackups: number
}

export const LOCAL_INDEX_UNSAFE_PATH = 'LOCAL_INDEX_UNSAFE_PATH' as const
export const LOCAL_INDEX_BACKUP_FAILED = 'LOCAL_INDEX_BACKUP_FAILED' as const
export const LOCAL_INDEX_MAX_BACKUPS = 3
export const LOCAL_INDEX_MAX_BACKUP_BYTES = 256 * 1024 * 1024

class LocalIndexRecoveryError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LocalIndexRecoveryError'
  }
}

function rawErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code.toUpperCase() : null
}

export function classifyLocalIndexFailure(error: unknown): LocalIndexErrorCode {
  const code = rawErrorCode(error)
  if (
    code === 'SQLITE_CORRUPT' ||
    code === 'SQLITE_BUSY' ||
    code === 'SCHEMA_UNSUPPORTED' ||
    code === 'DISK_WRITE_FAILED' ||
    code === 'SOURCE_PARSE_DEGRADED' ||
    code === 'LOCAL_INDEX_START_FAILED'
  ) {
    return code
  }
  if (code === 'LOCAL_INDEX_SCHEMA_UNSUPPORTED' || code === 'SCHEMA_UNSUPPORTED') {
    return 'SCHEMA_UNSUPPORTED'
  }
  if (code === LOCAL_INDEX_BACKUP_FAILED) return 'DISK_WRITE_FAILED'
  if (code?.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB') {
    return 'SQLITE_CORRUPT'
  }
  if (code?.startsWith('SQLITE_BUSY') || code?.startsWith('SQLITE_LOCKED')) {
    return 'SQLITE_BUSY'
  }
  if (
    code?.startsWith('SQLITE_READONLY') ||
    code?.startsWith('SQLITE_FULL') ||
    code?.startsWith('SQLITE_IOERR') ||
    code?.startsWith('SQLITE_CANTOPEN') ||
    code?.startsWith('SQLITE_PERM') ||
    code === 'ENOSPC' ||
    code === 'EROFS' ||
    code === 'EACCES' ||
    code === 'EPERM'
  ) {
    return 'DISK_WRITE_FAILED'
  }
  return 'LOCAL_INDEX_START_FAILED'
}

export function isConfirmedLocalIndexCorruption(error: unknown): boolean {
  return classifyLocalIndexFailure(error) === 'SQLITE_CORRUPT'
}

function assertManagedDatabasePath(scope: string, databasePath: string): void {
  const expected = resolve(scope, 'cc-haha', 'db', 'index-v1.sqlite')
  if (resolve(databasePath) !== expected) {
    throw new LocalIndexRecoveryError(LOCAL_INDEX_UNSAFE_PATH)
  }
}

async function ensureManagedDirectory(path: string): Promise<void> {
  try {
    await mkdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
  }
  const snapshot = await lstat(path)
  if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
    throw new LocalIndexRecoveryError(LOCAL_INDEX_UNSAFE_PATH)
  }
}

async function prepareManagedBackupsRoot(
  scope: string,
  databasePath: string,
): Promise<string> {
  const normalizedScope = resolve(scope)
  await mkdir(normalizedScope, { recursive: true })
  const ccHahaDir = join(normalizedScope, 'cc-haha')
  const databaseDir = join(ccHahaDir, 'db')
  const backupsRoot = join(databaseDir, 'backups')
  if (dirname(resolve(databasePath)) !== databaseDir) {
    throw new LocalIndexRecoveryError(LOCAL_INDEX_UNSAFE_PATH)
  }
  // The configured scope is the trust boundary. Managed descendants must be
  // real directories so a rebuild can never follow a redirected database or
  // backup ancestor outside that boundary.
  await ensureManagedDirectory(ccHahaDir)
  await ensureManagedDirectory(databaseDir)
  await ensureManagedDirectory(backupsRoot)
  return backupsRoot
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directorySize(child)
    else if (entry.isFile()) total += (await stat(child)).size
  }
  return total
}

async function enforceBackupRetention(backupsRoot: string): Promise<number> {
  let entries
  try {
    entries = (await readdir(backupsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0
    throw error
  }
  const sized = await Promise.all(entries.map(async entry => ({
    path: join(backupsRoot, entry.name),
    size: await directorySize(join(backupsRoot, entry.name)),
  })))
  let retainedBytes = 0
  let removed = 0
  for (const [index, entry] of sized.entries()) {
    retainedBytes += entry.size
    if (index < LOCAL_INDEX_MAX_BACKUPS && retainedBytes <= LOCAL_INDEX_MAX_BACKUP_BYTES) {
      continue
    }
    retainedBytes -= entry.size
    await rm(entry.path, { recursive: true, force: true })
    removed += 1
  }
  return removed
}

export async function backupLocalIndexDatabaseFamily(options: {
  scope: string
  databasePath: string
  reason: LocalIndexBackupReason
  now?: () => number
  renameFile?: typeof rename
}): Promise<LocalIndexBackupResult> {
  assertManagedDatabasePath(options.scope, options.databasePath)
  const now = options.now ?? Date.now
  const renameFile = options.renameFile ?? rename
  const backupsRoot = await prepareManagedBackupsRoot(
    options.scope,
    options.databasePath,
  )
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const token = randomUUID().slice(0, 8)
  const pendingPath = join(backupsRoot, `.pending-${stamp}-${token}`)
  const backupPath = join(backupsRoot, `${stamp}-${options.reason.toLowerCase()}-${token}`)
  const family = [options.databasePath, `${options.databasePath}-wal`, `${options.databasePath}-shm`]
  const moved: Array<{ source: string; destination: string }> = []

  await mkdir(pendingPath)
  try {
    for (const source of family) {
      if (!await exists(source)) continue
      const destination = join(pendingPath, basename(source))
      await renameFile(source, destination)
      moved.push({ source, destination })
    }
    if (moved.length === 0) {
      await rm(pendingPath, { recursive: true, force: true })
      return {
        backupPath: backupsRoot,
        movedFiles: 0,
        removedBackups: await enforceBackupRetention(backupsRoot),
      }
    }
    await renameFile(pendingPath, backupPath)
  } catch {
    let rollbackComplete = true
    for (const entry of moved.reverse()) {
      try {
        await renameFile(entry.destination, entry.source)
      } catch {
        rollbackComplete = false
      }
    }
    if (rollbackComplete) {
      await rm(pendingPath, { recursive: true, force: true }).catch(() => undefined)
    }
    await enforceBackupRetention(backupsRoot).catch(() => undefined)
    throw new LocalIndexRecoveryError(LOCAL_INDEX_BACKUP_FAILED)
  }

  return {
    backupPath,
    movedFiles: moved.length,
    removedBackups: await enforceBackupRetention(backupsRoot),
  }
}
