import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { openLocalIndexDatabase } from './database.js'
import { openScheduledRunIndex } from './scheduledRunIndex.js'
import { openSearchContentDatabase } from './searchContentDatabase.js'
import { openTraceIndexDatabase } from './traceDatabase.js'

const roots: string[] = []

async function tempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `managed-db-${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true }),
  ))
})

describe('managed SQLite database paths', () => {
  test.skipIf(process.platform === 'win32').each([
    ['session', 'index-v1.sqlite', openLocalIndexDatabase],
    ['trace', 'trace-index-v1.sqlite', openTraceIndexDatabase],
    ['scheduled', 'scheduled-runs-v1.sqlite', openScheduledRunIndex],
    ['search', 'search-index-v1.sqlite', openSearchContentDatabase],
  ] as const)(
    'rejects a descendant db-directory symlink before opening the %s database',
    async (_kind, filename, openDatabase) => {
      const root = await tempRoot(filename)
      const scope = path.join(root, 'config')
      const outside = path.join(root, 'outside')
      await fs.mkdir(path.join(scope, 'cc-haha'), { recursive: true })
      await fs.mkdir(outside)
      await fs.symlink(outside, path.join(scope, 'cc-haha', 'db'))
      const databasePath = path.join(scope, 'cc-haha', 'db', filename)

      expect(() => openDatabase({ path: databasePath, scope })).toThrow(
        expect.objectContaining({ code: 'LOCAL_INDEX_UNSAFE_PATH' }),
      )
      await expect(fs.stat(path.join(outside, filename))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    },
  )

  test.skipIf(process.platform === 'win32')('allows the configured trust root itself to be a symlink', async () => {
    const root = await tempRoot('scope-symlink')
    const realScope = path.join(root, 'real-config')
    const scope = path.join(root, 'config-link')
    await fs.mkdir(realScope)
    await fs.symlink(realScope, scope)
    const databasePath = path.join(scope, 'cc-haha', 'db', 'index-v1.sqlite')

    const database = openLocalIndexDatabase({ path: databasePath, scope })
    database.close()

    expect((await fs.lstat(databasePath)).isFile()).toBe(true)
  })

  test.each([
    ['session', 'index-v1.sqlite', openLocalIndexDatabase],
    ['trace', 'trace-index-v1.sqlite', openTraceIndexDatabase],
    ['scheduled', 'scheduled-runs-v1.sqlite', openScheduledRunIndex],
    ['search', 'search-index-v1.sqlite', openSearchContentDatabase],
  ] as const)(
    'restricts the %s database directory and SQLite file family to the current user',
    async (_kind, filename, openDatabase) => {
      if (process.platform === 'win32') return

      const root = await tempRoot(`permissions-${filename}`)
      const scope = path.join(root, 'config')
      const ccHahaDir = path.join(scope, 'cc-haha')
      const databaseDir = path.join(ccHahaDir, 'db')
      const databasePath = path.join(databaseDir, filename)
      await fs.mkdir(databaseDir, { recursive: true, mode: 0o777 })
      await fs.chmod(ccHahaDir, 0o777)
      await fs.chmod(databaseDir, 0o777)
      await fs.writeFile(databasePath, '')
      await fs.chmod(databasePath, 0o666)

      const database = openDatabase({ path: databasePath, scope })
      try {
        expect((await fs.stat(ccHahaDir)).mode & 0o777).toBe(0o700)
        expect((await fs.stat(databaseDir)).mode & 0o777).toBe(0o700)
        for (const candidate of [
          databasePath,
          `${databasePath}-wal`,
          `${databasePath}-shm`,
          `${databasePath}-journal`,
        ]) {
          const snapshot = await fs.stat(candidate).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
          })
          if (snapshot) expect(snapshot.mode & 0o777).toBe(0o600)
        }
      } finally {
        database.close()
      }
    },
  )

  test('creates a new managed database file with owner-only permissions before SQLite opens it', async () => {
    if (process.platform === 'win32') return

    const root = await tempRoot('new-file-permissions')
    const scope = path.join(root, 'config')
    const databasePath = path.join(scope, 'cc-haha', 'db', 'index-v1.sqlite')
    const { prepareManagedDatabasePath } = await import('./managedDatabasePath.js')

    prepareManagedDatabasePath({
      databasePath,
      filename: 'index-v1.sqlite',
      scope,
    })

    expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o600)
  })

  test.skipIf(process.platform === 'win32')('rejects an existing database-file symlink', async () => {
    const root = await tempRoot('file-symlink')
    const scope = path.join(root, 'config')
    const databaseDir = path.join(scope, 'cc-haha', 'db')
    const outside = path.join(root, 'outside.sqlite')
    await fs.mkdir(databaseDir, { recursive: true })
    await fs.writeFile(outside, '')
    await fs.symlink(outside, path.join(databaseDir, 'index-v1.sqlite'))

    expect(() => openLocalIndexDatabase({
      path: path.join(databaseDir, 'index-v1.sqlite'),
      scope,
    })).toThrow(expect.objectContaining({ code: 'LOCAL_INDEX_UNSAFE_PATH' }))
  })

  test('rejects an existing database-file hardlink to an outside inode', async () => {
    const root = await tempRoot('file-hardlink')
    const scope = path.join(root, 'config')
    const databaseDir = path.join(scope, 'cc-haha', 'db')
    const outside = path.join(root, 'outside.sqlite')
    await fs.mkdir(databaseDir, { recursive: true })
    await fs.writeFile(outside, 'outside-owned')
    await fs.link(outside, path.join(databaseDir, 'index-v1.sqlite'))

    expect(() => openLocalIndexDatabase({
      path: path.join(databaseDir, 'index-v1.sqlite'),
      scope,
    })).toThrow(expect.objectContaining({ code: 'LOCAL_INDEX_UNSAFE_PATH' }))
    expect(await fs.readFile(outside, 'utf8')).toBe('outside-owned')
  })
})
