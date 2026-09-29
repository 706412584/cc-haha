import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Failure-injection tests for `writeFileAtomic`'s non-happy paths.
 *
 * These branches (temp-file cleanup after a failed write, a snapshot copy that
 * cannot be taken, a snapshot read that fails for a reason other than ENOENT)
 * only matter when the disk is already misbehaving, so they cannot be reached
 * through a real filesystem. `node:fs/promises` is mocked for the module under
 * test, while `createRequire` keeps a handle on the REAL fs for this file's own
 * setup and assertions — `mock.module` rewrites every ESM view of the specifier
 * in the file, including one captured before the mock is installed.
 */

const realFs = createRequire(import.meta.url)('fs/promises') as typeof import('node:fs/promises')

let failTempWrite = false
let failSnapshotWrite = false
let failSnapshotReadFor: string | null = null
let fakeSnapshotEntries: string[] | null = null
let renameBusyTimes = 0
const unlinked: string[] = []

mock.module('node:fs/promises', () => ({
  ...realFs,
  rename: async (from: unknown, to: unknown) => {
    if (renameBusyTimes > 0) {
      renameBusyTimes -= 1
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    }
    return realFs.rename(from as never, to as never)
  },
  readdir: async (dirPath: unknown) => {
    if (fakeSnapshotEntries && String(dirPath) === tempDir) {
      return fakeSnapshotEntries
    }
    return realFs.readdir(dirPath as never)
  },
  unlink: async (filePath: unknown) => {
    unlinked.push(path.basename(String(filePath)))
    return realFs.unlink(filePath as never).catch(() => {})
  },
  open: async (filePath: string, flags: number, mode?: number) => {
    const handle = await realFs.open(filePath, flags, mode)
    if (failTempWrite) {
      // The temp file opened fine; writing into it now fails (e.g. ENOSPC).
      return {
        writeFile: async () => {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      }
    }
    return handle
  },
  writeFile: async (filePath: unknown, data: unknown, options?: unknown) => {
    if (failSnapshotWrite && String(filePath).includes('.snapshot-')) {
      throw Object.assign(new Error('snapshot denied'), { code: 'EACCES' })
    }
    return realFs.writeFile(filePath as never, data as never, options as never)
  },
  readFile: async (filePath: unknown, ...rest: unknown[]) => {
    if (failSnapshotReadFor && String(filePath).endsWith(failSnapshotReadFor)) {
      throw Object.assign(new Error('io error'), { code: 'EIO' })
    }
    return (realFs.readFile as (...args: unknown[]) => Promise<unknown>)(filePath, ...rest)
  },
}))

const { SNAPSHOT_SUFFIX, writeFileAtomic } = await import('./atomicWrite.js')

let tempDir: string

beforeEach(async () => {
  tempDir = await realFs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-atomic-failure-'))
  failTempWrite = false
  failSnapshotWrite = false
  failSnapshotReadFor = null
  fakeSnapshotEntries = null
  renameBusyTimes = 0
  unlinked.length = 0
})

afterEach(async () => {
  await realFs.rm(tempDir, { recursive: true, force: true })
})

function snapshotsOf(entries: string[]): string[] {
  return entries.filter((name) => name.startsWith(`providers.json${SNAPSHOT_SUFFIX}`))
}

describe('writeFileAtomic failure branches', () => {
  test('cleans up the temp file when the write into it fails', async () => {
    const target = path.join(tempDir, 'config.json')
    failTempWrite = true

    await expect(writeFileAtomic(target, 'payload')).rejects.toThrow('no space left on device')

    // The half-open temp file must not survive the failure.
    const leftovers = (await realFs.readdir(tempDir)).filter((name) => name.includes('.tmp.'))
    expect(leftovers).toEqual([])
    await expect(realFs.access(target)).rejects.toThrow()
  })

  test('still writes the file when the pre-write snapshot cannot be taken', async () => {
    const target = path.join(tempDir, 'providers.json')
    await realFs.writeFile(target, '{"providers":["keep"]}')
    failSnapshotWrite = true

    // A snapshot failure is best-effort: it must not block the write.
    await writeFileAtomic(target, '{"providers":[]}', { snapshot: true })

    expect(await realFs.readFile(target, 'utf-8')).toBe('{"providers":[]}')
    expect(snapshotsOf(await realFs.readdir(tempDir))).toEqual([])
  })

  test('still writes the file when reading it for a snapshot fails', async () => {
    const target = path.join(tempDir, 'providers.json')
    await realFs.writeFile(target, '{"providers":["keep"]}')
    failSnapshotReadFor = 'providers.json'

    await writeFileAtomic(target, '{"providers":[]}', { snapshot: true })

    expect(await realFs.readFile(target, 'utf-8')).toBe('{"providers":[]}')
    expect(snapshotsOf(await realFs.readdir(tempDir))).toEqual([])
  })

  test('ranks and prunes an over-full snapshot set without touching other families', async () => {
    const target = path.join(tempDir, 'providers.json')
    const prefix = `providers.json${SNAPSHOT_SUFFIX}`
    // Newest-first by embedded epoch; the two oldest (and one unparseable name,
    // which must rank last rather than crash) fall outside the retention set.
    fakeSnapshotEntries = [
      `${prefix}1000-aaaaaa`,
      `${prefix}5000-bbbbbb`,
      `${prefix}3000-cccccc`,
      `${prefix}not-a-number`,
      `${prefix}2000-dddddd`,
      `${prefix}4000-eeeeee`,
      `${prefix}6000-ffffff`,
      `${prefix}7000-gggggg`,
      'providers.json.bak-before-migration-1-aaa',
      'providers.json.invalid-1-bbb',
    ]

    await writeFileAtomic(target, '{"providers":[]}', { snapshot: true })

    // Eight snapshots are ranked; the three lowest (unparseable name + the two
    // oldest epochs) are pruned and the five newest survive, while no other
    // backup family is ever unlinked.
    expect(unlinked.filter((name) => name.startsWith(prefix)).sort()).toEqual(
      [
        `${prefix}1000-aaaaaa`,
        `${prefix}2000-dddddd`,
        `${prefix}not-a-number`,
      ].sort(),
    )
    expect(unlinked).not.toContain('providers.json.bak-before-migration-1-aaa')
    expect(unlinked).not.toContain('providers.json.invalid-1-bbb')
  })

  test('retries the rename on a Windows EBUSY, then succeeds', async () => {
    const target = path.join(tempDir, 'config.json')
    const originalPlatform = process.platform
    // The retry loop is gated on win32; force it so this path is exercised on
    // the Linux CI runner too, not just on a Windows dev box.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    renameBusyTimes = 2
    try {
      await writeFileAtomic(target, 'eventually')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }

    expect(await realFs.readFile(target, 'utf-8')).toBe('eventually')
    expect(renameBusyTimes).toBe(0)
  })

  test('gives up after the retry budget is exhausted', async () => {
    const target = path.join(tempDir, 'config.json')
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // One more failure than the retry budget (EBUSY_RETRY_DELAYS_MS has 3).
    renameBusyTimes = 4
    try {
      await expect(writeFileAtomic(target, 'payload')).rejects.toThrow('resource busy')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }

    await expect(realFs.access(target)).rejects.toThrow()
  })
})
