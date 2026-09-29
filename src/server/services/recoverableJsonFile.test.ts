import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { normalizeJsonObject, readRecoverableJsonFile } from './recoverableJsonFile.js'
import { SNAPSHOT_SUFFIX, writeFileAtomic } from '../storage/atomicWrite.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-recoverable-'))
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

type Index = { providers: string[]; activeId: string | null }

function normalizeIndex(value: unknown): Index | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.providers)) return null
  if (!record.providers.every((id) => typeof id === 'string')) return null
  const activeId = typeof record.activeId === 'string' ? record.activeId : null
  return { providers: record.providers as string[], activeId }
}

function readIndex(filePath: string) {
  return readRecoverableJsonFile<Index>({
    filePath,
    label: 'providers index',
    defaultValue: { providers: [], activeId: null },
    normalize: normalizeIndex,
  })
}

async function writeSnapshot(filePath: string, epoch: number, body: string): Promise<string> {
  const snapshotPath = `${filePath}${SNAPSHOT_SUFFIX}${epoch}-abc123`
  await fs.writeFile(snapshotPath, body)
  return snapshotPath
}

function quarantinesOf(entries: string[], base: string): string[] {
  return entries.filter((name) => name.startsWith(`${base}.invalid-`))
}

describe('readRecoverableJsonFile — happy paths', () => {
  test('returns the parsed value when the file is valid', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(target, JSON.stringify({ providers: ['a'], activeId: 'a' }))

    expect(await readIndex(target)).toEqual({ providers: ['a'], activeId: 'a' })
  })

  test('returns the default when the file is missing, without restoring', async () => {
    const target = path.join(tempDir, 'providers.json')
    await writeSnapshot(target, 1000, JSON.stringify({ providers: ['ghost'], activeId: null }))

    expect(await readIndex(target)).toEqual({ providers: [], activeId: null })

    // A missing file is a deliberate delete; the backup must stay untouched and
    // the main path must not be recreated.
    await expect(fs.access(target)).rejects.toThrow()
  })

  test('returns the default for an empty file', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(target, '   \n')

    expect(await readIndex(target)).toEqual({ providers: [], activeId: null })
  })
})

describe('readRecoverableJsonFile — zero-filled file recovery', () => {
  test('restores from a snapshot when the main file is all NULs', async () => {
    const target = path.join(tempDir, 'providers.json')
    const good = JSON.stringify({ providers: ['a', 'b', 'c'], activeId: 'b' })
    await writeSnapshot(target, 1000, good)

    // Reproduce the power-loss artifact: correct length, all zero bytes.
    await fs.writeFile(target, Buffer.alloc(good.length, 0))

    expect(await readIndex(target)).toEqual({ providers: ['a', 'b', 'c'], activeId: 'b' })

    // The recovery is only useful if it is durable — the main path must now
    // hold the restored bytes, not the NULs.
    expect(await fs.readFile(target, 'utf-8')).toBe(good)
  })

  test('quarantines the corrupt file as evidence before restoring', async () => {
    const target = path.join(tempDir, 'providers.json')
    await writeSnapshot(target, 1000, JSON.stringify({ providers: ['a'], activeId: null }))
    await fs.writeFile(target, Buffer.alloc(64, 0))

    await readIndex(target)

    const quarantined = quarantinesOf(await fs.readdir(tempDir), 'providers.json')
    expect(quarantined).toHaveLength(1)
    expect((await fs.readFile(path.join(tempDir, quarantined[0]!), 'utf-8')).length).toBe(64)
  })

  test('prefers the newest snapshot when several exist', async () => {
    const target = path.join(tempDir, 'providers.json')
    await writeSnapshot(target, 1000, JSON.stringify({ providers: ['old'], activeId: null }))
    await writeSnapshot(target, 3000, JSON.stringify({ providers: ['new'], activeId: null }))
    await writeSnapshot(target, 2000, JSON.stringify({ providers: ['middle'], activeId: null }))
    await fs.writeFile(target, Buffer.alloc(32, 0))

    expect(await readIndex(target)).toEqual({ providers: ['new'], activeId: null })
  })

  test('falls back to a migration backup when no snapshot exists', async () => {
    const target = path.join(tempDir, 'providers.json')
    const migrationBackup = `${path.basename(target)}.bak-before-migration-1790662980531-44dab4`
    await fs.writeFile(
      path.join(tempDir, migrationBackup),
      JSON.stringify({ providers: ['legacy'], activeId: 'legacy' }),
    )
    await fs.writeFile(target, Buffer.alloc(32, 0))

    expect(await readIndex(target)).toEqual({ providers: ['legacy'], activeId: 'legacy' })
  })

  test('a newer snapshot outranks an older migration backup', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(
      path.join(tempDir, `${path.basename(target)}.bak-before-migration-1000-aaa`),
      JSON.stringify({ providers: ['migration'], activeId: null }),
    )
    await writeSnapshot(target, 5000, JSON.stringify({ providers: ['snapshot'], activeId: null }))
    await fs.writeFile(target, Buffer.alloc(32, 0))

    expect(await readIndex(target)).toEqual({ providers: ['snapshot'], activeId: null })
  })

  test('never restores from a quarantined .invalid- file', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(
      path.join(tempDir, `${path.basename(target)}.invalid-1700000000000-deadbe`),
      JSON.stringify({ providers: ['corrupt'], activeId: null }),
    )
    await fs.writeFile(target, Buffer.alloc(32, 0))

    expect(await readIndex(target)).toEqual({ providers: [], activeId: null })
  })

  test('skips a backup whose shape is wrong and uses the next older one', async () => {
    const target = path.join(tempDir, 'providers.json')
    await writeSnapshot(target, 1000, JSON.stringify({ providers: ['usable'], activeId: null }))
    // Newest candidate, but `providers` is not an array of strings.
    await writeSnapshot(target, 9000, JSON.stringify({ providers: [{ nope: true }] }))
    await fs.writeFile(target, Buffer.alloc(32, 0))

    expect(await readIndex(target)).toEqual({ providers: ['usable'], activeId: null })
  })

  test('skips a backup that is not valid JSON at all', async () => {
    const target = path.join(tempDir, 'providers.json')
    await writeSnapshot(target, 1000, JSON.stringify({ providers: ['usable'], activeId: null }))
    await writeSnapshot(target, 9000, 'not json {{{')
    await fs.writeFile(target, Buffer.alloc(32, 0))

    expect(await readIndex(target)).toEqual({ providers: ['usable'], activeId: null })
  })
})

describe('readRecoverableJsonFile — recovery does not overreach', () => {
  test('returns the default when the file is corrupt and no backup exists', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(target, Buffer.alloc(32, 0))

    expect(await readIndex(target)).toEqual({ providers: [], activeId: null })
    expect(quarantinesOf(await fs.readdir(tempDir), 'providers.json')).toHaveLength(1)
  })

  test('does NOT overwrite a well-formed file whose shape is merely unrecognised', async () => {
    const target = path.join(tempDir, 'providers.json')
    // An older backup exists and would parse — but the main file is valid JSON
    // in a shape this build predates (e.g. a newer schema). Overwriting it with
    // older data would be silent data loss, so the reader must refuse.
    await writeSnapshot(target, 1000, JSON.stringify({ providers: ['older'], activeId: null }))
    const newer = JSON.stringify({ providers: 'not-an-array', schemaVersion: 99 })
    await fs.writeFile(target, newer)

    expect(await readIndex(target)).toEqual({ providers: [], activeId: null })
    expect(quarantinesOf(await fs.readdir(tempDir), 'providers.json')).toHaveLength(1)
    // The unrecognised bytes survive intact for a newer build to reclaim.
    const quarantined = quarantinesOf(await fs.readdir(tempDir), 'providers.json')[0]!
    expect(await fs.readFile(path.join(tempDir, quarantined), 'utf-8')).toBe(newer)
    // The main path is gone (moved aside), not replaced with the old backup.
    await expect(fs.access(target)).rejects.toThrow()
  })

  test('leaves the corrupt file in place when no backup can be used', async () => {
    const target = path.join(tempDir, 'providers.json')
    const corruptSnapshot = await writeSnapshot(target, 1000, 'broken {{{')
    const corrupt = Buffer.alloc(32, 0)
    await fs.writeFile(target, corrupt)

    expect(await readIndex(target)).toEqual({ providers: [], activeId: null })

    // Copy, not move: the main path must still exist so a later read can retry
    // recovery. If it were renamed away, the next read would see ENOENT and
    // treat it as a deliberate deletion, never trying the backup again.
    expect(await fs.readFile(target)).toEqual(corrupt)
    expect(quarantinesOf(await fs.readdir(tempDir), 'providers.json')).toHaveLength(1)
    // The unusable candidate is left alone as evidence.
    expect(await fs.readFile(corruptSnapshot, 'utf-8')).toBe('broken {{{')
  })

  test('retries recovery on the next read after a failed write-back', async () => {
    const target = path.join(tempDir, 'providers.json')
    await writeSnapshot(target, 1000, JSON.stringify({ providers: ['recovered'], activeId: null }))
    await fs.writeFile(target, Buffer.alloc(32, 0))

    // First read restores.
    expect(await readIndex(target)).toEqual({ providers: ['recovered'], activeId: null })

    // Simulate the file going bad again later; recovery must still work.
    await fs.writeFile(target, Buffer.alloc(32, 0))
    expect(await readIndex(target)).toEqual({ providers: ['recovered'], activeId: null })
  })
})

describe('readRecoverableJsonFile — object normalize helper', () => {
  test('normalizeJsonObject rejects arrays and primitives', async () => {
    const target = path.join(tempDir, 'settings.json')
    await writeFileAtomic(target, JSON.stringify([1, 2, 3]))

    const result = await readRecoverableJsonFile<Record<string, unknown>>({
      filePath: target,
      label: 'settings',
      defaultValue: {},
      normalize: normalizeJsonObject,
    })
    expect(result).toEqual({})
  })

  test('normalizeJsonObject accepts a plain object', async () => {
    const target = path.join(tempDir, 'settings.json')
    await writeFileAtomic(target, JSON.stringify({ env: { A: '1' } }))

    const result = await readRecoverableJsonFile<Record<string, unknown>>({
      filePath: target,
      label: 'settings',
      defaultValue: {},
      normalize: normalizeJsonObject,
    })
    expect(result).toEqual({ env: { A: '1' } })
  })
})
