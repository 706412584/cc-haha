import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs'
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

export const LOCAL_INDEX_UNSAFE_PATH = 'LOCAL_INDEX_UNSAFE_PATH' as const
export const LOCAL_INDEX_BUSY_TIMEOUT_MS = 100

export class UnsafeLocalIndexPathError extends Error {
  readonly code = LOCAL_INDEX_UNSAFE_PATH

  constructor() {
    super(LOCAL_INDEX_UNSAFE_PATH)
    this.name = 'UnsafeLocalIndexPathError'
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !child.startsWith(sep)
  )
}

function restrictPermissions(path: string, mode: number): void {
  if (process.platform !== 'win32') chmodSync(path, mode)
}

function ensureRealManagedDirectory(path: string, trustRoot: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const snapshot = lstatSync(path)
  if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
    throw new UnsafeLocalIndexPathError()
  }
  if (!isContained(trustRoot, realpathSync(path))) {
    throw new UnsafeLocalIndexPathError()
  }
  restrictPermissions(path, 0o700)
}

function ensureDatabaseFile(databasePath: string): void {
  try {
    const descriptor = openSync(
      databasePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    closeSync(descriptor)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

function assertDatabaseFamilySafe(databasePath: string): void {
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ]) {
    const snapshot = lstatIfPresent(path)
    if (!snapshot) continue
    if (
      !snapshot.isFile() ||
      snapshot.isSymbolicLink() ||
      snapshot.nlink !== 1
    ) {
      throw new UnsafeLocalIndexPathError()
    }
    restrictPermissions(path, 0o600)
  }
}

export function restrictManagedDatabasePermissions(databasePath: string): void {
  assertDatabaseFamilySafe(resolve(databasePath))
}

/**
 * Prepares the disposable database directory without following any managed
 * descendant symlink. The configured scope itself is the trust boundary and
 * may intentionally be a symlink (for example, a relocated user config).
 */
export function prepareManagedDatabasePath(options: {
  databasePath: string
  filename: string
  scope?: string
}): void {
  const databasePath = resolve(options.databasePath)
  if (!options.scope) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    ensureDatabaseFile(databasePath)
    assertDatabaseFamilySafe(databasePath)
    return
  }

  const lexicalScope = resolve(options.scope)
  const expectedPath = join(lexicalScope, 'cc-haha', 'db', options.filename)
  if (databasePath !== expectedPath) throw new UnsafeLocalIndexPathError()

  // Recursive creation is restricted to the caller-owned trust root. Every
  // managed descendant is created one component at a time and lstat-verified.
  mkdirSync(lexicalScope, { recursive: true })
  const trustRoot = realpathSync(lexicalScope)
  const scopeSnapshot = lstatSync(lexicalScope)
  if (!scopeSnapshot.isDirectory() && !scopeSnapshot.isSymbolicLink()) {
    throw new UnsafeLocalIndexPathError()
  }
  const ccHahaDir = join(lexicalScope, 'cc-haha')
  const databaseDir = join(ccHahaDir, 'db')
  ensureRealManagedDirectory(ccHahaDir, trustRoot)
  ensureRealManagedDirectory(databaseDir, trustRoot)
  ensureDatabaseFile(databasePath)
  assertDatabaseFamilySafe(databasePath)
}
