import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import {
  backupLocalIndexDatabaseFamily,
  classifyLocalIndexFailure,
  isConfirmedLocalIndexCorruption,
} from './recovery.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-local-index-recovery-'))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

describe('local index recovery', () => {
  test('moves only the fixed derived database family into the managed backup directory', async () => {
    const scope = await createTempDir()
    const databasePath = join(scope, 'cc-haha', 'db', 'index-v1.sqlite')
    const sourcePath = join(scope, 'projects', '-repo', 'source.jsonl')
    await mkdir(dirname(databasePath), { recursive: true })
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, 'canonical-source')
    for (const [suffix, contents] of [
      ['', 'database'],
      ['-wal', 'wal'],
      ['-shm', 'shm'],
    ] as const) {
      await writeFile(`${databasePath}${suffix}`, contents)
    }

    const result = await backupLocalIndexDatabaseFamily({
      scope,
      databasePath,
      reason: 'SQLITE_CORRUPT',
      now: () => Date.UTC(2026, 6, 15),
    })

    expect(relative(join(scope, 'cc-haha', 'db', 'backups'), result.backupPath))
      .not.toStartWith('..')
    expect(await readFile(join(result.backupPath, 'index-v1.sqlite'), 'utf-8')).toBe('database')
    expect(await readFile(join(result.backupPath, 'index-v1.sqlite-wal'), 'utf-8')).toBe('wal')
    expect(await readFile(join(result.backupPath, 'index-v1.sqlite-shm'), 'utf-8')).toBe('shm')
    expect(await readFile(sourcePath, 'utf-8')).toBe('canonical-source')
  })

  test('auto-recovers confirmed corruption but never busy, read-only, disk-full, or future schema', () => {
    const corrupt = Object.assign(new Error('private database path'), { code: 'SQLITE_CORRUPT' })
    const busy = Object.assign(new Error('private database path'), { code: 'SQLITE_BUSY' })
    const readOnly = Object.assign(new Error('private database path'), { code: 'SQLITE_READONLY' })
    const diskFull = Object.assign(new Error('private database path'), { code: 'SQLITE_FULL' })
    const futureSchema = Object.assign(new Error('private database path'), {
      code: 'LOCAL_INDEX_SCHEMA_UNSUPPORTED',
    })
    const cannotOpen = Object.assign(new Error('/private/readonly/index-v1.sqlite'), {
      code: 'SQLITE_CANTOPEN',
    })
    const permissionDenied = Object.assign(new Error('/private/readonly/index-v1.sqlite'), {
      code: 'SQLITE_PERM',
    })

    expect(classifyLocalIndexFailure(corrupt)).toBe('SQLITE_CORRUPT')
    expect(classifyLocalIndexFailure(busy)).toBe('SQLITE_BUSY')
    expect(classifyLocalIndexFailure(readOnly)).toBe('DISK_WRITE_FAILED')
    expect(classifyLocalIndexFailure(diskFull)).toBe('DISK_WRITE_FAILED')
    expect(classifyLocalIndexFailure(cannotOpen)).toBe('DISK_WRITE_FAILED')
    expect(classifyLocalIndexFailure(permissionDenied)).toBe('DISK_WRITE_FAILED')
    expect(classifyLocalIndexFailure(futureSchema)).toBe('SCHEMA_UNSUPPORTED')
    expect(isConfirmedLocalIndexCorruption(corrupt)).toBe(true)
    expect(isConfirmedLocalIndexCorruption(busy)).toBe(false)
    expect(isConfirmedLocalIndexCorruption(readOnly)).toBe(false)
    expect(isConfirmedLocalIndexCorruption(diskFull)).toBe(false)
    expect(isConfirmedLocalIndexCorruption(cannotOpen)).toBe(false)
    expect(isConfirmedLocalIndexCorruption(permissionDenied)).toBe(false)
    expect(isConfirmedLocalIndexCorruption(futureSchema)).toBe(false)
  })

  test.each(['cc-haha', 'db', 'backups'] as const)(
    'rejects a symlinked managed %s ancestor without moving external files',
    async (ancestor) => {
      const scope = await createTempDir()
      const outside = await createTempDir()
      const databasePath = join(scope, 'cc-haha', 'db', 'index-v1.sqlite')
      const externalSentinel = join(outside, 'outside-sentinel.txt')
      await writeFile(externalSentinel, 'must-stay-outside')

      let protectedDatabasePath: string
      if (ancestor === 'cc-haha') {
        await mkdir(join(outside, 'db'), { recursive: true })
        protectedDatabasePath = join(outside, 'db', 'index-v1.sqlite')
        await symlink(
          outside,
          join(scope, 'cc-haha'),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      } else if (ancestor === 'db') {
        await mkdir(join(scope, 'cc-haha'), { recursive: true })
        protectedDatabasePath = join(outside, 'index-v1.sqlite')
        await symlink(
          outside,
          join(scope, 'cc-haha', 'db'),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      } else {
        await mkdir(dirname(databasePath), { recursive: true })
        protectedDatabasePath = databasePath
        await symlink(
          outside,
          join(dirname(databasePath), 'backups'),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      }
      await writeFile(protectedDatabasePath, 'must-not-move')

      await expect(backupLocalIndexDatabaseFamily({
        scope,
        databasePath,
        reason: 'MANUAL_REBUILD',
      })).rejects.toMatchObject({ code: 'LOCAL_INDEX_UNSAFE_PATH' })

      expect(await readFile(protectedDatabasePath, 'utf-8')).toBe('must-not-move')
      expect(await readFile(externalSentinel, 'utf-8')).toBe('must-stay-outside')
    },
  )

  test('rejects an arbitrary rebuild target outside the fixed database family', async () => {
    const scope = await createTempDir()
    await expect(backupLocalIndexDatabaseFamily({
      scope,
      databasePath: join(scope, 'projects', '-repo', 'source.jsonl'),
      reason: 'MANUAL_REBUILD',
    })).rejects.toMatchObject({ code: 'LOCAL_INDEX_UNSAFE_PATH' })
  })

  test('rolls back a partial family move and retains no completed backup', async () => {
    const scope = await createTempDir()
    const databasePath = join(scope, 'cc-haha', 'db', 'index-v1.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    for (const suffix of ['', '-wal', '-shm']) {
      await writeFile(`${databasePath}${suffix}`, suffix || 'database')
    }
    let moves = 0

    await expect(backupLocalIndexDatabaseFamily({
      scope,
      databasePath,
      reason: 'SQLITE_CORRUPT',
      renameFile: async (from, to) => {
        moves += 1
        if (moves === 2) throw Object.assign(new Error('forced move failure'), { code: 'EIO' })
        await rename(from, to)
      },
    })).rejects.toMatchObject({ code: 'LOCAL_INDEX_BACKUP_FAILED' })

    for (const suffix of ['', '-wal', '-shm']) {
      expect((await stat(`${databasePath}${suffix}`)).isFile()).toBe(true)
    }
    const backupsRoot = join(scope, 'cc-haha', 'db', 'backups')
    expect(await readdir(backupsRoot)).toEqual([])
  })

  test('keeps only the newest three bounded derived backups', async () => {
    const scope = await createTempDir()
    const databasePath = join(scope, 'cc-haha', 'db', 'index-v1.sqlite')
    await mkdir(dirname(databasePath), { recursive: true })
    for (let index = 0; index < 5; index += 1) {
      await writeFile(databasePath, `database-${index}`)
      await backupLocalIndexDatabaseFamily({
        scope,
        databasePath,
        reason: 'MANUAL_REBUILD',
        now: () => Date.UTC(2026, 6, 15, 0, 0, index),
      })
    }

    const backups = await readdir(join(scope, 'cc-haha', 'db', 'backups'))
    expect(backups).toHaveLength(3)
    expect(backups.some(name => name.includes('00-00-04'))).toBe(true)
    expect(backups.some(name => name.includes('00-00-00'))).toBe(false)
  })
})
