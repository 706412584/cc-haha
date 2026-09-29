/**
 * Shared atomic-write helper with power-loss durability.
 *
 * Why this exists: config writes across this codebase were `writeFile(tmp)` +
 * `rename(tmp, target)`. `rename` only guarantees that METADATA is committed —
 * NTFS may commit the directory entry (so the file has the correct SIZE) while
 * the data blocks are still in the page cache. A power loss then leaves a file
 * whose length is correct but whose contents are all 0x00. That is exactly how
 * `cc-haha/providers.json` was silently wiped on 2026-09-29.
 *
 * `fsync` before `rename` closes that window: the data blocks reach stable
 * storage before the directory entry points at them.
 *
 * The implementation mirrors `workspaceFileService.atomicWrite` — the one
 * pre-existing correct path in the repo — so there is a single behaviour to
 * reason about, including the Windows EBUSY/EPERM rename retry loop.
 */

import * as fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'

/** Matches `workspaceFileService.EBUSY_RETRY_DELAYS_MS` — Windows rename retry. */
const EBUSY_RETRY_DELAYS_MS = [50, 50, 50] as const

/** Prefix for pre-write snapshots. Deliberately distinct from the migration
 * backups (`bak-before-migration-`) so retention can never delete those. */
export const SNAPSHOT_SUFFIX = '.snapshot-'

/** How many `.snapshot-*` files to keep per target. */
export const SNAPSHOT_RETENTION = 5

export type WriteFileAtomicOptions = {
  /** File mode for the temp file. Defaults to 0o644, matching prior writers. */
  mode?: number
  /**
   * Copy the current file to `<file>.snapshot-<epochMs>-<hex>` before replacing
   * it, so a corrupt/zero-filled target can be restored on the next read.
   * Best-effort: a snapshot failure never blocks the write.
   */
  snapshot?: boolean
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableWindowsError(err: NodeJS.ErrnoException): boolean {
  if (process.platform !== 'win32') return false
  return err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES'
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined
}

/**
 * Whether existing bytes are worth keeping as a recovery candidate.
 *
 * Deliberately shallow — this must not parse JSON, because the same helper
 * serves non-JSON targets. It only rejects the shapes that are provably
 * useless as a backup: empty/whitespace-only, and anything containing a NUL
 * byte (the power-loss artifact is a correct-length file of pure 0x00).
 *
 * Snapshotting such a file would be worse than not snapshotting at all: the
 * garbage would enter the retention set and, once it aged out the good
 * snapshots, become the newest "backup" the recovery path restores from.
 */
function isWorthSnapshotting(bytes: Buffer): boolean {
  if (bytes.length === 0) return false
  if (bytes.includes(0)) return false
  return bytes.toString('utf-8').trim().length > 0
}

/**
 * Copy the current file aside before it is replaced. Returns the snapshot path,
 * or null when there was nothing worth snapshotting / the copy could not be
 * taken.
 */
async function snapshotExistingFile(filePath: string): Promise<string | null> {
  let bytes: Buffer
  try {
    bytes = await fs.readFile(filePath)
  } catch (error) {
    // ENOENT is the normal "first write" case. Anything else is still
    // non-fatal: a missing snapshot only costs us a recovery candidate.
    if (errnoCode(error) !== 'ENOENT') {
      console.warn(
        `[desktop] Failed to read ${filePath} for snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    return null
  }

  if (!isWorthSnapshotting(bytes)) {
    console.warn(`[desktop] Skipped snapshot of ${filePath}: existing contents look corrupt`)
    return null
  }

  const snapshotPath = `${filePath}${SNAPSHOT_SUFFIX}${Date.now()}-${randomBytes(3).toString('hex')}`
  try {
    await fs.writeFile(snapshotPath, bytes, { flag: 'wx' })
    return snapshotPath
  } catch (error) {
    console.warn(
      `[desktop] Failed to snapshot ${filePath} before write: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

/**
 * Keep only the newest `SNAPSHOT_RETENTION` snapshots for this target.
 *
 * Only ever matches `<basename>.snapshot-*`. `bak-before-migration-*` and
 * `.invalid-*` files are intentionally out of scope and must never be removed
 * here — they are the migration history and the corruption evidence.
 */
async function pruneSnapshots(filePath: string): Promise<void> {
  const dir = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}${SNAPSHOT_SUFFIX}`
  const entries = await fs.readdir(dir)
  const snapshots = entries.filter((name) => name.startsWith(prefix))
  if (snapshots.length <= SNAPSHOT_RETENTION) return

  // Sort newest-first by the embedded epoch; unparseable names sort last.
  const ranked = snapshots
    .map((name) => {
      const rest = name.slice(prefix.length)
      const epoch = Number.parseInt(rest.split('-')[0] ?? '', 10)
      return { name, epoch: Number.isFinite(epoch) ? epoch : 0 }
    })
    .sort((a, b) => (b.epoch - a.epoch) || b.name.localeCompare(a.name))

  await Promise.all(
    ranked.slice(SNAPSHOT_RETENTION).map(({ name }) =>
      fs.unlink(path.join(dir, name)).catch(() => {
        /* best-effort */
      }),
    ),
  )
}

/**
 * Write `contents` to `filePath` atomically and durably.
 *
 * Order: mkdir → (optional) snapshot → tmp (O_EXCL) → fsync → close →
 * rename (Windows retry) → prune snapshots.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string | Buffer,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const { mode = 0o644, snapshot = false } = options
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  if (snapshot) {
    await snapshotExistingFile(filePath)
  }

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}.${randomBytes(3).toString('hex')}`

  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode,
    )
    await handle.writeFile(contents)
    // The whole point of this helper: force data blocks to stable storage
    // before the directory entry is allowed to reference them.
    await handle.sync()
  } catch (err) {
    // A failed write/sync would otherwise leak the temp file — the rename
    // cleanup below never runs because we never reach it. Matters most when
    // the disk is full, which is exactly when leaking files hurts.
    if (handle) {
      try {
        await handle.close()
      } catch {
        /* ignore */
      }
      handle = null
    }
    try {
      await fs.unlink(tmpPath)
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        /* swallow — the primary write either succeeded or already threw. */
      }
    }
  }

  try {
    let attempt = 0
    while (true) {
      try {
        await fs.rename(tmpPath, filePath)
        break
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException
        if (attempt < EBUSY_RETRY_DELAYS_MS.length && isRetryableWindowsError(nodeErr)) {
          await delay(EBUSY_RETRY_DELAYS_MS[attempt]!)
          attempt += 1
          continue
        }
        throw err
      }
    }
  } catch (err) {
    try {
      await fs.unlink(tmpPath)
    } catch {
      /* ignore */
    }
    // Prune on the failure path too: a repeatedly-failing rename (EBUSY
    // exhaustion, read-only target) would otherwise add a snapshot per attempt
    // and never shed one.
    if (snapshot) await pruneSnapshotsQuietly(filePath)
    throw err
  }

  if (snapshot) await pruneSnapshotsQuietly(filePath)
}

/** Retention is housekeeping — never fail the write over it. */
async function pruneSnapshotsQuietly(filePath: string): Promise<void> {
  await pruneSnapshots(filePath).catch(() => {})
}

/**
 * `writeFileAtomic` for JSON, using the same on-disk format as the existing
 * config writers: `JSON.stringify(value, null, 2)` + trailing newline.
 *
 * Callers that need key-sorted output (e.g. the storage migrations) should
 * serialise themselves and call `writeFileAtomic` directly.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options)
}
