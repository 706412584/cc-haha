import * as fs from 'fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { writeFileAtomic } from '../storage/atomicWrite.js'

type RecoverableJsonFileOptions<T> = {
  filePath: string
  label: string
  defaultValue: T
  normalize: (value: unknown) => T | null
}

/**
 * Backup families this reader will restore from, newest first by the epoch
 * embedded in the filename. `.snapshot-` is written by `writeFileAtomic` before
 * every config write; `.bak-before-migration-` is written once by the storage
 * migration. Both embed a `Date.now()` epoch, so they are directly comparable —
 * a snapshot from a minute ago beats a migration backup from last month.
 *
 * `.invalid-*` is deliberately absent: those files hold the corruption itself,
 * never a good copy.
 */
const BACKUP_PREFIXES = ['.snapshot-', '.bak-before-migration-'] as const

function cloneDefault<T>(value: T): T {
  if (value && typeof value === 'object') {
    return JSON.parse(JSON.stringify(value)) as T
  }
  return value
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

/**
 * Move the unusable file aside as `.invalid-*` evidence; returns the new path,
 * or null if the move failed.
 *
 * Move, not copy: the main path is expected to be gone afterwards — either
 * because recovered bytes are committed in its place, or because there is
 * nothing to recover and callers must see the file as missing (that is the
 * long-standing contract `desktopUiPreferencesService` reads `exists` from).
 * `recoverCorruptFile` renames this path back over the main one if the
 * write-back fails, so a failed recovery is still retried on the next read.
 */
async function quarantineInvalidJsonFile(
  filePath: string,
  label: string,
  reason: string,
): Promise<string | null> {
  const backupPath = `${filePath}.invalid-${Date.now()}-${randomBytes(3).toString('hex')}`
  try {
    await fs.rename(filePath, backupPath)
    console.warn(`[desktop] Quarantined invalid ${label} at ${backupPath}: ${reason}`)
    return backupPath
  } catch (error) {
    console.warn(
      `[desktop] Failed to quarantine invalid ${label} from ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

/** Epoch embedded in `<base><prefix><epoch>-<hex>`; 0 when unparseable. */
function embeddedEpoch(name: string, prefixLength: number): number {
  const rest = name.slice(prefixLength)
  const epoch = Number.parseInt(rest.split('-')[0] ?? '', 10)
  return Number.isFinite(epoch) ? epoch : 0
}

/** Candidate backups for `filePath`, newest first (epoch desc, then mtime desc). */
async function rankBackups(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  const matched: { full: string; name: string; epoch: number }[] = []
  for (const name of entries) {
    for (const prefix of BACKUP_PREFIXES) {
      const marker = `${base}${prefix}`
      if (!name.startsWith(marker)) continue
      matched.push({ full: path.join(dir, name), name, epoch: embeddedEpoch(name, marker.length) })
      break
    }
  }
  if (matched.length === 0) return []

  const withStats = await Promise.all(
    matched.map(async (entry) => {
      let mtimeMs = 0
      try {
        mtimeMs = (await fs.stat(entry.full)).mtimeMs
      } catch {
        // Unreadable candidate; keep it ranked last rather than dropping it.
      }
      return { ...entry, mtimeMs }
    }),
  )

  withStats.sort(
    (a, b) => b.epoch - a.epoch || b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name),
  )
  return withStats.map((entry) => entry.full)
}

/**
 * Last-resort recovery: the main file is corrupt, so look for the newest backup
 * that still parses into the expected shape.
 *
 * Returns the value AND the raw bytes it came from. Callers differ in what they
 * should persist: the read path writes the bytes back verbatim so the user's
 * formatting survives, while the storage migration re-serializes the value so
 * a restored pre-migration backup also gets upgraded to the current schema.
 *
 * The write-back is what makes this durable — returning the value without
 * persisting it would leave the main path missing, and the next read would fall
 * straight back to the default, which is the exact loss this guards against.
 */
export async function restoreFromNewestBackup<T>(
  filePath: string,
  label: string,
  normalize: (value: unknown) => T | null,
): Promise<{ value: T; raw: string; backupPath: string } | null> {
  for (const candidate of await rankBackups(filePath)) {
    let raw: string
    try {
      raw = await fs.readFile(candidate, 'utf-8')
    } catch {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }

    const value = normalize(parsed)
    if (value === null) continue

    console.warn(`[desktop] Recovered ${label} from ${candidate}`)
    return { value, raw, backupPath: candidate }
  }
  return null
}

export function normalizeJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

export async function readRecoverableJsonFile<T>({
  filePath,
  label,
  defaultValue,
  normalize,
}: RecoverableJsonFileOptions<T>): Promise<T> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      // A missing file is a deliberate deletion, not corruption. Never
      // resurrect it from a backup.
      return cloneDefault(defaultValue)
    }
    throw ApiError.internal(`Failed to read ${label} from ${filePath}: ${error}`)
  }

  if (raw.trim() === '') {
    return cloneDefault(defaultValue)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // The power-loss case: a correct-size file full of NULs parses as garbage,
    // and a backup is the only copy of the user's data left.
    return recoverCorruptFile(
      filePath,
      label,
      error instanceof Error ? error.message : String(error),
      normalize,
      defaultValue,
    )
  }

  const normalized = normalize(parsed)
  if (normalized === null) {
    // Parsed fine but the shape is unrecognised — e.g. a newer schema this
    // build predates. That is NOT corruption, and the file may be the freshest
    // data on disk, so it must never be overwritten with an older backup.
    // Quarantine it and fall back to the default; the bytes survive in the
    // `.invalid-` file for the newer build to reclaim.
    await quarantineInvalidJsonFile(filePath, label, 'unexpected JSON shape')
    return cloneDefault(defaultValue)
  }

  return normalized
}

/**
 * Recover a file that failed to parse.
 *
 * Order matters, and it is what keeps both invariants true at once:
 *
 *  1. Find a usable backup BEFORE touching the main file. If there is none,
 *     nothing is renamed away — the corrupt file stays put as evidence, so a
 *     later read can retry once a backup appears.
 *  2. Move the corrupt file aside as `.invalid-*` evidence.
 *  3. Commit the recovered bytes to the main path.
 *
 * If step 3 fails, the evidence is renamed BACK onto the main path. That
 * restores the pre-read state, so the next read retries recovery instead of
 * hitting ENOENT and mistaking the file for a deliberate deletion.
 */
async function recoverCorruptFile<T>(
  filePath: string,
  label: string,
  reason: string,
  normalize: (value: unknown) => T | null,
  defaultValue: T,
): Promise<T> {
  const restored = await restoreFromNewestBackup(filePath, label, normalize)
  if (!restored) {
    await quarantineInvalidJsonFile(filePath, label, reason)
    return cloneDefault(defaultValue)
  }

  const quarantinedPath = await quarantineInvalidJsonFile(filePath, label, reason)

  try {
    // Write the backup's bytes back verbatim — a round-trip through
    // JSON.stringify would rewrite the user's formatting for no gain.
    await writeFileAtomic(filePath, restored.raw)
  } catch (error) {
    console.warn(
      `[desktop] Recovered ${label} from ${restored.backupPath} but could not write it back to ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    if (quarantinedPath) {
      // Put the evidence back so the main path exists again and the next read
      // retries recovery rather than reading the absence as a deletion.
      await fs.rename(quarantinedPath, filePath).catch(() => {})
    }
  }

  return restored.value
}
