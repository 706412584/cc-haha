import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  openScheduledRunIndex,
  paginateScheduledRunRecords,
  type ScheduledRunIndex,
  type ScheduledRunRecord,
} from './scheduledRunIndex.js'

let index: ScheduledRunIndex | undefined
let tmpDir: string | undefined

afterEach(async () => {
  index?.close()
  index = undefined
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

async function createIndex(): Promise<ScheduledRunIndex> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-index-'))
  index = openScheduledRunIndex({
    path: path.join(tmpDir, 'scheduled-runs-v1.sqlite'),
  })
  return index
}

function run(
  id: string,
  startedAt: string,
  overrides: Partial<ScheduledRunRecord> = {},
): ScheduledRunRecord {
  return {
    id,
    taskId: 'task-1',
    taskName: 'Daily review',
    startedAt,
    status: 'completed',
    prompt: `prompt-${id}`,
    ...overrides,
  }
}

describe('scheduled run read index', () => {
  test('projects only safe scalar summary fields with stable order and cursors', async () => {
    const target = await createIndex()
    const largeOutput = 'x'.repeat(256 * 1024)
    const runs = [
      run('old-run', '2025-01-01T00:00:00.000Z'),
      run('current-run', '2026-07-15T02:00:00.000Z', {
        completedAt: '2026-07-15T02:00:05.000Z',
        status: 'failed',
        output: largeOutput,
        error: 'provider failed',
        exitCode: 1,
        durationMs: 5_000,
        sessionId: 'session-1',
        futureField: { preserved: true },
      }),
      run('tie-run', '2026-07-15T02:00:00.000Z', {
        taskId: 'task-2',
      }),
    ]

    const status = target.replaceAll({
      runs,
      source: {
        path: '/tmp/scheduled_tasks_log.json',
        size: 1234,
        mtimeMs: 4567,
        fingerprint: 'sha256:first',
      },
    })
    const firstPage = target.list({ limit: 2, summaryOnly: true })
    const secondPage = target.list({ limit: 2, cursor: firstPage.nextCursor })

    expect(status).toMatchObject({ state: 'ready', revision: 1 })
    expect(firstPage.runs.map(item => item.id)).toEqual(['current-run', 'tie-run'])
    expect(firstPage.runs[0]).toMatchObject({
      id: 'current-run',
      hasOutput: true,
      hasError: true,
    })
    for (const field of [
      'taskName',
      'prompt',
      'output',
      'error',
      'outputPreview',
      'errorPreview',
    ]) {
      expect(firstPage.runs[0]).not.toHaveProperty(field)
    }
    expect(secondPage.runs.map(item => item.id)).toEqual(['old-run'])
    expect(target.getStatus()).toMatchObject({
      sourcePath: '/tmp/scheduled_tasks_log.json',
      sourceFingerprint: 'sha256:first',
      sourceSize: 1234,
      sourceMtimeMs: 4567,
      revision: 1,
    })
  })

  test('rebuilds a sensitive v1 database and physically scrubs discarded bodies', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-index-v1-'))
    const databasePath = path.join(tmpDir, 'scheduled-runs-v1.sqlite')
    const promptSecret = 'v1-prompt-secret-4f6d0c31'
    const outputSecret = 'v1-output-secret-9a321bd8'
    const legacy = new Database(databasePath)
    legacy.exec(`
      CREATE TABLE scheduled_run_source (
        singleton INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        source_mtime_ms REAL NOT NULL,
        source_fingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        last_error_code TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE scheduled_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        started_at_ms REAL NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        prompt_preview TEXT NOT NULL,
        output_preview TEXT,
        error_preview TEXT,
        has_output INTEGER NOT NULL,
        has_error INTEGER NOT NULL,
        exit_code REAL,
        duration_ms REAL,
        session_id TEXT,
        source_ordinal INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        run_json TEXT NOT NULL
      );
      INSERT INTO scheduled_run_source VALUES (
        1, '/tmp/scheduled_tasks_log.json', 100, 100, 'legacy', 1,
        'ready', NULL, 100
      );
    `)
    legacy.query(`
      INSERT INTO scheduled_runs VALUES (
        ?, 'task-1', ?, '2026-07-15T00:00:00.000Z', 1,
        '2026-07-15T00:00:01.000Z', 'completed', ?, ?, NULL,
        1, 0, 0, 1, NULL, 0, 1, ?
      )
    `).run(
      'legacy-run',
      promptSecret,
      promptSecret,
      outputSecret,
      JSON.stringify({ prompt: promptSecret, output: outputSecret }),
    )
    legacy.exec('PRAGMA user_version = 1')
    legacy.close(true)

    index = openScheduledRunIndex({ path: databasePath })
    index.close()
    index = undefined

    const upgraded = new Database(databasePath, { readonly: true })
    const columns = upgraded.query<{ name: string }, []>(
      'PRAGMA table_info(scheduled_runs)',
    ).all().map(column => column.name)
    expect(columns).toEqual([
      'run_id',
      'task_id',
      'started_at',
      'started_at_ms',
      'completed_at',
      'completed_at_ms',
      'status',
      'has_output',
      'has_error',
      'exit_code',
      'duration_ms',
      'session_id',
      'source_ordinal',
      'revision',
    ])
    expect(upgraded.query<{ user_version: number }, []>('PRAGMA user_version').get())
      .toEqual({ user_version: 2 })
    upgraded.close(true)

    for (const member of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      const bytes = await fs.readFile(member).catch(() => Buffer.alloc(0))
      expect(bytes.includes(Buffer.from(promptSecret))).toBe(false)
      expect(bytes.includes(Buffer.from(outputSecret))).toBe(false)
    }
  })

  test('atomically replaces append, update, and delete mutations while preserving the last good revision on interruption', async () => {
    const target = await createIndex()
    const source = {
      path: '/tmp/scheduled_tasks_log.json',
      size: 100,
      mtimeMs: 100,
      fingerprint: 'sha256:one',
    }
    target.replaceAll({
      runs: [run('run-1', '2026-07-15T01:00:00.000Z')],
      source,
    })
    target.replaceAll({
      runs: [
        run('run-1', '2026-07-15T01:00:00.000Z', { status: 'failed' }),
        run('run-2', '2026-07-15T02:00:00.000Z'),
      ],
      source: { ...source, size: 200, mtimeMs: 200, fingerprint: 'sha256:two' },
    })
    target.replaceAll({
      runs: [run('run-2', '2026-07-15T02:00:00.000Z')],
      source: { ...source, size: 150, mtimeMs: 300, fingerprint: 'sha256:three' },
    })

    expect(target.list().runs.map(item => item.id)).toEqual(['run-2'])
    expect(target.getStatus().revision).toBe(3)

    expect(() => target.replaceAll({
      runs: [run('run-3', '2026-07-15T03:00:00.000Z')],
      source: { ...source, size: 300, mtimeMs: 400, fingerprint: 'sha256:four' },
      failAfterRows: 1,
    })).toThrow('injected scheduled-run projection failure')
    expect(target.list().runs.map(item => item.id)).toEqual(['run-2'])
    expect(target.getStatus().revision).toBe(3)
  })

  test('resets a versioned cursor at the new head when the projection revision changes', async () => {
    const target = await createIndex()
    const startedAt = '2026-07-15T03:00:00.000Z'
    const source = {
      path: '/tmp/scheduled_tasks_log.json',
      size: 100,
      mtimeMs: 100,
      fingerprint: 'sha256:one',
    }
    target.replaceAll({
      runs: [
        run('run-0', startedAt),
        run('run-z', startedAt),
        run('run-a', startedAt),
      ],
      source,
    })
    const firstPage = target.list({ limit: 2, summaryOnly: true })
    expect(firstPage.runs.map(item => item.id)).toEqual(['run-0', 'run-z'])

    target.replaceAll({
      runs: [run('run-z', startedAt), run('run-a', startedAt)],
      source: { ...source, size: 200, mtimeMs: 200, fingerprint: 'sha256:two' },
    })
    const resetPage = target.list({
      limit: 1,
      summaryOnly: true,
      cursor: firstPage.nextCursor,
    })

    expect(resetPage).toMatchObject({ reset: true, revision: 2 })
    expect(resetPage.runs.map(item => item.id)).toEqual(['run-z'])
    expect(resetPage.nextCursor).toBeString()
    expect(target.list({
      limit: 2,
      summaryOnly: true,
      cursor: resetPage.nextCursor,
    }).runs.map(item => item.id)).toEqual(['run-a'])
  })

  test('explicitly resets legacy and malformed cursors instead of silently treating them as positions', async () => {
    const target = await createIndex()
    target.replaceAll({
      runs: [run('run-1', '2026-07-15T01:00:00.000Z')],
      source: {
        path: '/tmp/scheduled_tasks_log.json',
        size: 100,
        mtimeMs: 100,
        fingerprint: 'sha256:one',
      },
    })
    const legacyCursor = Buffer.from(JSON.stringify([0, 0, 'run-1'])).toString('base64url')

    expect(target.list({ cursor: legacyCursor })).toMatchObject({
      reset: true,
      runs: [{ id: 'run-1' }],
    })
    expect(target.list({ cursor: 'not-a-cursor' })).toMatchObject({
      reset: true,
      runs: [{ id: 'run-1' }],
    })
  })

  test('applies the same revision-reset contract to canonical-file fallback pages', () => {
    const runs = [
      run('newer', '2026-07-15T02:00:00.000Z'),
      run('older', '2026-07-15T01:00:00.000Z'),
    ]
    const firstPage = paginateScheduledRunRecords(runs, { limit: 1 }, 'file:one')
    const resetPage = paginateScheduledRunRecords(runs, {
      limit: 1,
      cursor: firstPage.nextCursor,
    }, 'file:two')

    expect(resetPage).toMatchObject({ reset: true })
    expect(resetPage.runs.map(item => item.id)).toEqual(['newer'])
  })

  test('resets a cursor after the SQLite database is recreated at the same numeric revision', async () => {
    const target = await createIndex()
    const databasePath = path.join(tmpDir!, 'scheduled-runs-v1.sqlite')
    target.replaceAll({
      runs: [
        run('old-head', '2026-07-15T03:00:00.000Z'),
        run('old-tail', '2026-07-15T02:00:00.000Z'),
      ],
      source: {
        path: '/tmp/scheduled_tasks_log.json',
        size: 100,
        mtimeMs: 100,
        fingerprint: 'canonical-generation-old',
      },
    })
    const oldPage = target.list({ limit: 1, summaryOnly: true })
    target.close()
    index = undefined
    await Promise.all([
      fs.rm(databasePath, { force: true }),
      fs.rm(`${databasePath}-wal`, { force: true }),
      fs.rm(`${databasePath}-shm`, { force: true }),
    ])

    index = openScheduledRunIndex({ path: databasePath })
    index.replaceAll({
      runs: [
        run('new-head', '2026-07-15T05:00:00.000Z'),
        run('new-middle', '2026-07-15T04:00:00.000Z'),
        run('new-tail', '2026-07-15T01:00:00.000Z'),
      ],
      source: {
        path: '/tmp/scheduled_tasks_log.json',
        size: 200,
        mtimeMs: 200,
        fingerprint: 'canonical-generation-new',
      },
    })

    const resetPage = index.list({
      limit: 2,
      summaryOnly: true,
      cursor: oldPage.nextCursor,
    })
    expect(resetPage).toMatchObject({ reset: true, revision: 1 })
    expect(resetPage.runs.map(item => item.id)).toEqual(['new-head', 'new-middle'])
  })

  test('binds SQLite and canonical-file cursors to the task filter scope', async () => {
    const runs = [
      run('a-new', '2026-07-15T04:00:00.000Z', { taskId: 'task-a' }),
      run('b-new', '2026-07-15T03:00:00.000Z', { taskId: 'task-b' }),
      run('a-old', '2026-07-15T02:00:00.000Z', { taskId: 'task-a' }),
      run('b-old', '2026-07-15T01:00:00.000Z', { taskId: 'task-b' }),
    ]
    const target = await createIndex()
    target.replaceAll({
      runs,
      source: {
        path: '/tmp/scheduled_tasks_log.json',
        size: 100,
        mtimeMs: 100,
        fingerprint: 'canonical-generation',
      },
    })

    const sqliteGlobal = target.list({ limit: 2, summaryOnly: true })
    const sqliteTask = target.list({
      taskId: 'task-b',
      limit: 10,
      summaryOnly: true,
      cursor: sqliteGlobal.nextCursor,
    })
    expect(sqliteTask).toMatchObject({ reset: true })
    expect(sqliteTask.runs.map(item => item.id)).toEqual(['b-new', 'b-old'])

    const fileGlobal = paginateScheduledRunRecords(
      runs,
      { limit: 2, summaryOnly: true },
      'file:canonical-generation',
    )
    const fileTask = paginateScheduledRunRecords(
      runs,
      {
        taskId: 'task-b',
        limit: 10,
        summaryOnly: true,
        cursor: fileGlobal.nextCursor,
      },
      'file:canonical-generation',
    )
    expect(fileTask).toMatchObject({ reset: true })
    expect(fileTask.runs.map(item => item.id)).toEqual(['b-new', 'b-old'])
  })

  test('filters non-terminal notification candidates without changing their stable order', async () => {
    const runs = [
      run('completed', '2026-07-15T04:00:00.000Z'),
      run('running-new', '2026-07-15T03:00:00.000Z', { status: 'running' }),
      run('failed', '2026-07-15T02:00:00.000Z', { status: 'failed' }),
      run('running-old', '2026-07-15T01:00:00.000Z', { status: 'running' }),
    ]
    const target = await createIndex()
    target.replaceAll({
      runs,
      source: {
        path: '/tmp/scheduled_tasks_log.json',
        size: 100,
        mtimeMs: 100,
        fingerprint: 'canonical-generation',
      },
    })

    expect(target.list({ nonterminalOnly: true, summaryOnly: true }).runs.map(item => item.id))
      .toEqual(['running-new', 'running-old'])
    expect(paginateScheduledRunRecords(
      runs,
      { nonterminalOnly: true, summaryOnly: true },
      'file:canonical-generation',
    ).runs.map(item => item.id)).toEqual(['running-new', 'running-old'])
  })

  test('pages only terminal runs completed at or after the notification floor in both backends', async () => {
    const completionFloor = Date.parse('2026-07-15T03:00:00.000Z')
    const runs = [
      run('fresh-new-start', '2026-07-15T04:00:00.000Z', {
        completedAt: '2026-07-15T04:00:05.000Z',
      }),
      run('still-running', '2026-07-15T02:30:00.000Z', { status: 'running' }),
      run('fresh-old-start', '2026-07-14T23:00:00.000Z', {
        completedAt: '2026-07-15T03:00:01.000Z',
      }),
      run('completed-before-floor', '2026-07-14T22:00:00.000Z', {
        completedAt: '2026-07-15T02:59:59.999Z',
      }),
    ]
    const target = await createIndex()
    target.replaceAll({
      runs,
      source: {
        path: '/tmp/scheduled_tasks_log.json',
        size: 100,
        mtimeMs: 100,
        fingerprint: 'canonical-generation',
      },
    })

    const sqliteFirst = target.list({
      completedAfterMs: completionFloor,
      limit: 1,
      summaryOnly: true,
    })
    const sqliteSecond = target.list({
      completedAfterMs: completionFloor,
      cursor: sqliteFirst.nextCursor,
      limit: 1,
      summaryOnly: true,
    })
    expect(sqliteFirst.runs.map(item => item.id)).toEqual(['fresh-new-start'])
    expect(sqliteSecond.runs.map(item => item.id)).toEqual(['fresh-old-start'])

    const canonicalFirst = paginateScheduledRunRecords(runs, {
      completedAfterMs: completionFloor,
      limit: 1,
      summaryOnly: true,
    }, 'file:canonical-generation')
    const canonicalSecond = paginateScheduledRunRecords(runs, {
      completedAfterMs: completionFloor,
      cursor: canonicalFirst.nextCursor,
      limit: 1,
      summaryOnly: true,
    }, 'file:canonical-generation')
    expect(canonicalFirst.runs.map(item => item.id)).toEqual(['fresh-new-start'])
    expect(canonicalSecond.runs.map(item => item.id)).toEqual(['fresh-old-start'])

    const raw = new Database(path.join(tmpDir!, 'scheduled-runs-v1.sqlite'), {
      readonly: true,
    })
    const plan = raw.query<{ detail: string }, [number]>(`
      EXPLAIN QUERY PLAN
      SELECT run_id FROM scheduled_runs
      WHERE status IN ('completed', 'failed', 'timeout')
        AND completed_at_ms >= ?
      ORDER BY started_at_ms DESC, source_ordinal ASC, run_id ASC
      LIMIT 51
    `).all(completionFloor).map(row => row.detail).join('\n')
    raw.close(true)
    expect(plan).toContain('scheduled_runs_terminal_completion_idx')
    expect(plan).not.toContain('SCAN scheduled_runs')

    expect(target.list({
      cursor: sqliteFirst.nextCursor,
      limit: 10,
      summaryOnly: true,
    })).toMatchObject({ reset: true })
  })
})
