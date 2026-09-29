import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Failure-injection tests for the recovery path's defensive branches: an
 * unreadable directory, a candidate that cannot be stat'd or read, a main file
 * that fails for a reason other than ENOENT, a quarantine rename that fails,
 * and a write-back that fails after the corrupt file was moved aside.
 *
 * None of these can be produced with a healthy filesystem, so `node:fs/promises`
 * is mocked. `createRequire` holds the REAL fs for setup/assertions because
 * `mock.module` rewrites every ESM view of the specifier in this file.
 */

const realFs = createRequire(import.meta.url)('fs/promises') as typeof import('node:fs/promises')

let readdirThrows = false
let statThrows = false
let candidateReadThrows = false
let mainReadErrorCode: string | null = null
let renameThrows = false
let openThrows = false

mock.module('node:fs/promises', () => ({
  ...realFs,
  readdir: async (dirPath: unknown) => {
    if (readdirThrows) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return realFs.readdir(dirPath as never)
  },
  stat: async (filePath: unknown) => {
    if (statThrows && String(filePath).includes('.snapshot-')) {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    }
    return realFs.stat(filePath as never)
  },
  readFile: async (filePath: unknown, ...rest: unknown[]) => {
    const p = String(filePath)
    if (mainReadErrorCode && p.endsWith('providers.json')) {
      throw Object.assign(new Error('permission denied'), { code: mainReadErrorCode })
    }
    if (candidateReadThrows && p.includes('.snapshot-')) {
      throw Object.assign(new Error('io error'), { code: 'EIO' })
    }
    return (realFs.readFile as (...args: unknown[]) => Promise<unknown>)(filePath, ...rest)
  },
  rename: async (from: unknown, to: unknown) => {
    if (renameThrows) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return realFs.rename(from as never, to as never)
  },
  open: async (...args: unknown[]) => {
    if (openThrows) throw Object.assign(new Error('read-only fs'), { code: 'EROFS' })
    return (realFs.open as (...a: unknown[]) => Promise<unknown>)(...args)
  },
}))

const { readRecoverableJsonFile } = await import('./recoverableJsonFile.js')
const { SNAPSHOT_SUFFIX } = await import('../storage/atomicWrite.js')

type Index = { providers: string[]; activeId: string | null }

function normalizeIndex(value: unknown): Index | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.providers)) return null
  if (!record.providers.every((id) => typeof id === 'string')) return null
  return { providers: record.providers as string[], activeId: null }
}

function readIndex(filePath: string) {
  return readRecoverableJsonFile<Index>({
    filePath,
    label: 'providers index',
    defaultValue: { providers: [], activeId: null },
    normalize: normalizeIndex,
  })
}

let tempDir: string

beforeEach(async () => {
  tempDir = await realFs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-recoverable-fail-'))
  readdirThrows = false
  statThrows = false
  candidateReadThrows = false
  mainReadErrorCode = null
  renameThrows = false
  openThrows = false
})

afterEach(async () => {
  await realFs.rm(tempDir, { recursive: true, force: true })
})

describe('readRecoverableJsonFile failure branches', () => {
  test('throws an internal error when the main file cannot be read for a reason other than ENOENT', async () => {
    const target = path.join(tempDir, 'providers.json')
    await realFs.writeFile(target, '{}')
    mainReadErrorCode = 'EACCES'

    await expect(readIndex(target)).rejects.toThrow(/Failed to read/)
  })

  test('treats an unreadable directory as having no backups and falls back to the default', async () => {
    const target = path.join(tempDir, 'providers.json')
    await realFs.writeFile(target, Buffer.alloc(32, 0))
    readdirThrows = true

    expect(await readIndex(target)).toEqual({ providers: [], activeId: null })
  })

  test('still restores from a candidate whose stat fails (ranked last, not dropped)', async () => {
    const target = path.join(tempDir, 'providers.json')
    await realFs.writeFile(
      `${target}${SNAPSHOT_SUFFIX}1000-abc123`,
      JSON.stringify({ providers: ['from-statless-backup'], activeId: null }),
    )
    await realFs.writeFile(target, Buffer.alloc(32, 0))
    statThrows = true

    expect(await readIndex(target)).toEqual({ providers: ['from-statless-backup'], activeId: null })
  })

  test('skips a candidate that cannot be read and falls back to the default', async () => {
    const target = path.join(tempDir, 'providers.json')
    await realFs.writeFile(
      `${target}${SNAPSHOT_SUFFIX}1000-abc123`,
      JSON.stringify({ providers: ['unreadable'], activeId: null }),
    )
    await realFs.writeFile(target, Buffer.alloc(32, 0))
    candidateReadThrows = true

    expect(await readIndex(target)).toEqual({ providers: [], activeId: null })
  })

  test('still uses a backup whose filename has no parseable epoch', async () => {
    const target = path.join(tempDir, 'providers.json')
    await realFs.writeFile(
      `${target}${SNAPSHOT_SUFFIX}not-a-number`,
      JSON.stringify({ providers: ['epochless'], activeId: null }),
    )
    await realFs.writeFile(target, Buffer.alloc(32, 0))

    expect(await readIndex(target)).toEqual({ providers: ['epochless'], activeId: null })
  })

  test('falls back to the default when the corrupt file cannot be quarantined', async () => {
    const target = path.join(tempDir, 'providers.json')
    await realFs.writeFile(target, Buffer.alloc(32, 0))
    renameThrows = true

    expect(await readIndex(target)).toEqual({ providers: [], activeId: null })
  })

  test('puts the corrupt file back when the recovered bytes cannot be written', async () => {
    const target = path.join(tempDir, 'providers.json')
    const corrupt = Buffer.alloc(32, 0)
    await realFs.writeFile(
      `${target}${SNAPSHOT_SUFFIX}1000-abc123`,
      JSON.stringify({ providers: ['recovered'], activeId: null }),
    )
    await realFs.writeFile(target, corrupt)
    // The write-back goes through writeFileAtomic, which opens a temp file.
    openThrows = true

    // The value is still returned to the caller...
    expect(await readIndex(target)).toEqual({ providers: ['recovered'], activeId: null })

    // ...and the main path exists again so the next read retries instead of
    // reading the absence as a deliberate deletion.
    expect(await realFs.readFile(target)).toEqual(corrupt)
  })
})
