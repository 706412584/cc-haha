import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  SNAPSHOT_RETENTION,
  SNAPSHOT_SUFFIX,
  writeFileAtomic,
  writeJsonFileAtomic,
} from './atomicWrite.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-atomic-write-'))
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

async function listDir(): Promise<string[]> {
  return fs.readdir(tempDir)
}

function snapshotsOf(entries: string[], base: string): string[] {
  return entries.filter((name) => name.startsWith(`${base}${SNAPSHOT_SUFFIX}`))
}

describe('writeFileAtomic', () => {
  test('writes contents and leaves no temp file behind', async () => {
    const target = path.join(tempDir, 'config.json')
    await writeFileAtomic(target, '{"a":1}\n')

    expect(await fs.readFile(target, 'utf-8')).toBe('{"a":1}\n')

    const leftovers = (await listDir()).filter((name) => name.includes('.tmp.'))
    expect(leftovers).toEqual([])
  })

  test('creates missing parent directories', async () => {
    const target = path.join(tempDir, 'nested', 'deeper', 'config.json')
    await writeFileAtomic(target, 'hello')

    expect(await fs.readFile(target, 'utf-8')).toBe('hello')
  })

  test('overwrites an existing file', async () => {
    const target = path.join(tempDir, 'config.json')
    await fs.writeFile(target, 'old')
    await writeFileAtomic(target, 'new')

    expect(await fs.readFile(target, 'utf-8')).toBe('new')
  })

  test('accepts a Buffer payload', async () => {
    const target = path.join(tempDir, 'blob.bin')
    await writeFileAtomic(target, Buffer.from([1, 2, 3]))

    expect([...(await fs.readFile(target))]).toEqual([1, 2, 3])
  })

  test('honours the mode option', async () => {
    const target = path.join(tempDir, 'secret.json')
    await writeFileAtomic(target, '{}', { mode: 0o600 })

    if (process.platform !== 'win32') {
      const stat = await fs.stat(target)
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })

  test('does not snapshot unless asked', async () => {
    const target = path.join(tempDir, 'config.json')
    await fs.writeFile(target, 'old')
    await writeFileAtomic(target, 'new')

    expect(snapshotsOf(await listDir(), 'config.json')).toEqual([])
  })
})

describe('writeFileAtomic snapshots', () => {
  test('snapshot holds the PRE-write contents, not the new ones', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(target, '{"providers":["keep-me"]}')

    await writeFileAtomic(target, '{"providers":[]}', { snapshot: true })

    const snapshots = snapshotsOf(await listDir(), 'providers.json')
    expect(snapshots).toHaveLength(1)

    // The snapshot must preserve the good data so recovery can use it.
    const snapshotBody = await fs.readFile(path.join(tempDir, snapshots[0]!), 'utf-8')
    expect(snapshotBody).toBe('{"providers":["keep-me"]}')
    expect(await fs.readFile(target, 'utf-8')).toBe('{"providers":[]}')
  })

  test('does not snapshot when there is nothing to snapshot yet', async () => {
    const target = path.join(tempDir, 'brand-new.json')
    await writeFileAtomic(target, '{}', { snapshot: true })

    expect(snapshotsOf(await listDir(), 'brand-new.json')).toEqual([])
  })

  test('never snapshots a zero-filled file', async () => {
    const target = path.join(tempDir, 'providers.json')
    // The power-loss artifact: correct length, all NUL bytes. Snapshotting it
    // would let the garbage enter the retention set and eventually evict the
    // last good snapshot, which is the exact failure this whole change exists
    // to prevent.
    await fs.writeFile(target, Buffer.alloc(64, 0))

    await writeFileAtomic(target, '{"ok":true}', { snapshot: true })

    expect(snapshotsOf(await listDir(), 'providers.json')).toEqual([])
  })

  test('never snapshots an empty or whitespace-only file', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(target, '   \n')

    await writeFileAtomic(target, '{"ok":true}', { snapshot: true })

    expect(snapshotsOf(await listDir(), 'providers.json')).toEqual([])
  })

  test('no snapshot is ever taken of corrupt content', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(target, '{"good":true}')
    await writeFileAtomic(target, '{"next":1}', { snapshot: true })

    // Corrupt the main file, then write over it repeatedly. Every snapshot on
    // disk must be a complete, NUL-free document — corrupt bytes must never
    // become a recovery candidate.
    await fs.writeFile(target, Buffer.alloc(64, 0))
    for (let i = 0; i < SNAPSHOT_RETENTION + 2; i++) {
      await writeFileAtomic(target, `{"round":${i}}`, { snapshot: true })
    }

    const snapshots = snapshotsOf(await listDir(), 'providers.json')
    expect(snapshots.length).toBeGreaterThan(0)
    for (const name of snapshots) {
      const bytes = await fs.readFile(path.join(tempDir, name))
      expect(bytes.includes(0)).toBe(false)
      expect(JSON.parse(bytes.toString('utf-8'))).toBeDefined()
    }
  })

  test('prunes old snapshots down to the retention limit', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(target, 'v0')

    // SNAPSHOT_RETENTION + 2 writes => 7 snapshots created, 5 kept.
    for (let i = 1; i <= SNAPSHOT_RETENTION + 2; i++) {
      await writeFileAtomic(target, `v${i}`, { snapshot: true })
    }

    const snapshots = snapshotsOf(await listDir(), 'providers.json')
    expect(snapshots).toHaveLength(SNAPSHOT_RETENTION)
  })

  test('keeps the NEWEST snapshots when pruning', async () => {
    const target = path.join(tempDir, 'providers.json')
    await fs.writeFile(target, 'v0')

    for (let i = 1; i <= SNAPSHOT_RETENTION + 2; i++) {
      await writeFileAtomic(target, `v${i}`, { snapshot: true })
    }

    const snapshots = snapshotsOf(await listDir(), 'providers.json')
    const bodies = await Promise.all(
      snapshots.map((name) => fs.readFile(path.join(tempDir, name), 'utf-8')),
    )

    // The oldest snapshots (v0..v1) should have been dropped, newest kept.
    expect(bodies).not.toContain('v0')
    expect(bodies).toContain(`v${SNAPSHOT_RETENTION + 1}`)
  })

  test('never deletes bak-before-migration files', async () => {
    const target = path.join(tempDir, 'providers.json')
    const migrationBackup = `${path.basename(target)}.bak-before-migration-1700000000000-abc123`
    await fs.writeFile(path.join(tempDir, migrationBackup), 'precious migration history')
    await fs.writeFile(target, 'v0')

    // Force well past the retention limit.
    for (let i = 1; i <= SNAPSHOT_RETENTION + 3; i++) {
      await writeFileAtomic(target, `v${i}`, { snapshot: true })
    }

    const entries = await listDir()
    expect(entries).toContain(migrationBackup)
    expect(await fs.readFile(path.join(tempDir, migrationBackup), 'utf-8')).toBe(
      'precious migration history',
    )
  })

  test('never deletes .invalid- quarantine files', async () => {
    const target = path.join(tempDir, 'providers.json')
    const quarantined = `${path.basename(target)}.invalid-1700000000000-deadbe`
    await fs.writeFile(path.join(tempDir, quarantined), 'corruption evidence')
    await fs.writeFile(target, 'v0')

    for (let i = 1; i <= SNAPSHOT_RETENTION + 3; i++) {
      await writeFileAtomic(target, `v${i}`, { snapshot: true })
    }

    expect(await listDir()).toContain(quarantined)
  })
})

describe('writeFileAtomic failure handling', () => {
  test('throws and cleans up the temp file when rename cannot succeed', async () => {
    // Deterministic rename failure: the target path is an existing DIRECTORY.
    // On Windows this surfaces as EPERM/EACCES — the retryable set — so this
    // also exercises the retry-then-give-up path.
    const target = path.join(tempDir, 'occupied')
    await fs.mkdir(target)

    await expect(writeFileAtomic(target, 'payload')).rejects.toThrow()

    const leftovers = (await listDir()).filter((name) => name.includes('.tmp.'))
    expect(leftovers).toEqual([])
  })

})

describe('writeJsonFileAtomic', () => {
  test('serialises with 2-space indent and a trailing newline', async () => {
    const target = path.join(tempDir, 'config.json')
    await writeJsonFileAtomic(target, { a: 1, nested: { b: [1, 2] } })

    const raw = await fs.readFile(target, 'utf-8')
    expect(raw).toBe('{\n  "a": 1,\n  "nested": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}\n')
    expect(JSON.parse(raw)).toEqual({ a: 1, nested: { b: [1, 2] } })
  })

  test('round-trips through JSON.parse', async () => {
    const target = path.join(tempDir, 'config.json')
    const value = { providers: [{ id: 'a', apiKey: 'secret' }], activeId: 'a' }
    await writeJsonFileAtomic(target, value)

    expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual(value)
  })
})
