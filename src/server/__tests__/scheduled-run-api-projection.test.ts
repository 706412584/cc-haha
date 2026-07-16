import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleScheduledTasksApi } from '../api/scheduled-tasks.js'
import { resetScheduledRunReadModelForTests } from '../services/localIndex/scheduledRunReadModel.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalLocalIndexMode = process.env.CC_HAHA_LOCAL_INDEX

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-run-api-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.CC_HAHA_LOCAL_INDEX = 'on'
  await fs.writeFile(path.join(tmpDir, 'scheduled_tasks_log.json'), JSON.stringify({
    runs: [
      {
        id: 'older',
        taskId: 'task-1',
        taskName: 'Task',
        startedAt: '2026-07-15T01:00:00.000Z',
        completedAt: '2026-07-15T03:00:01.000Z',
        status: 'completed',
        prompt: 'old prompt',
        output: 'old output',
      },
      {
        id: 'still-running',
        taskId: 'task-1',
        taskName: 'Task',
        startedAt: '2026-07-15T00:00:00.000Z',
        status: 'running',
        prompt: 'running prompt',
      },
      {
        id: 'newer',
        taskId: 'task-1',
        taskName: 'Task',
        startedAt: '2026-07-15T02:00:00.000Z',
        completedAt: '2026-07-15T02:00:01.000Z',
        status: 'failed',
        prompt: 'new prompt',
        output: 'x'.repeat(256 * 1024),
        error: 'provider failed',
        futureField: 'preserved',
      },
    ],
  }))
})

afterEach(async () => {
  await resetScheduledRunReadModelForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalLocalIndexMode === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
  else process.env.CC_HAHA_LOCAL_INDEX = originalLocalIndexMode
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function get(url: string, segments: string[]): Promise<Record<string, any>> {
  const request = new Request(url)
  const response = await handleScheduledTasksApi(request, new URL(url), segments)
  expect(response.status).toBe(200)
  return response.json() as Promise<Record<string, any>>
}

describe('scheduled run projection API', () => {
  test('keeps the old no-option response full and field-compatible', async () => {
    const body = await get(
      'http://localhost/api/scheduled-tasks/runs?limit=1',
      ['api', 'scheduled-tasks', 'runs'],
    )

    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]).toMatchObject({
      id: 'newer',
      output: 'x'.repeat(256 * 1024),
      futureField: 'preserved',
    })
    expect(body).not.toHaveProperty('nextCursor')
  })

  test('pages lightweight summaries and retrieves exact detail on demand', async () => {
    const first = await get(
      'http://localhost/api/scheduled-tasks/runs?limit=1&summaryOnly=true',
      ['api', 'scheduled-tasks', 'runs'],
    )
    expect(first.runs[0]).toMatchObject({
      id: 'newer',
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
      expect(first.runs[0]).not.toHaveProperty(field)
    }
    expect(first.nextCursor).toBeString()

    const second = await get(
      `http://localhost/api/scheduled-tasks/runs?limit=1&summaryOnly=true&cursor=${encodeURIComponent(first.nextCursor)}`,
      ['api', 'scheduled-tasks', 'runs'],
    )
    expect(second.runs.map((run: { id: string }) => run.id)).toEqual(['older'])

    const detail = await get(
      'http://localhost/api/scheduled-tasks/runs/newer',
      ['api', 'scheduled-tasks', 'runs', 'newer'],
    )
    expect(detail.run).toMatchObject({
      id: 'newer',
      output: 'x'.repeat(256 * 1024),
      futureField: 'preserved',
    })
  })

  test('returns only non-terminal candidates for notification initialization', async () => {
    const body = await get(
      'http://localhost/api/scheduled-tasks/runs?summaryOnly=true&nonterminalOnly=true',
      ['api', 'scheduled-tasks', 'runs'],
    )

    expect(body.runs.map((run: { id: string }) => run.id)).toEqual(['still-running'])
    expect(body.runs[0]).not.toHaveProperty('output')
  })

  test('returns terminal completion candidates across old start times without historical rows', async () => {
    const body = await get(
      `http://localhost/api/scheduled-tasks/runs?summaryOnly=true&completedAfterMs=${Date.parse('2026-07-15T03:00:00.000Z')}`,
      ['api', 'scheduled-tasks', 'runs'],
    )

    expect(body.runs.map((run: { id: string }) => run.id)).toEqual(['older'])
    expect(body.runs[0]).not.toHaveProperty('output')
  })

  test('returns a reset head page when a cursor crosses a projected revision', async () => {
    const first = await get(
      'http://localhost/api/scheduled-tasks/runs?limit=1&summaryOnly=true',
      ['api', 'scheduled-tasks', 'runs'],
    )
    await fs.writeFile(path.join(tmpDir, 'scheduled_tasks_log.json'), JSON.stringify({
      runs: [{
        id: 'replacement-head',
        taskId: 'task-1',
        taskName: 'Task',
        startedAt: '2026-07-15T03:00:00.000Z',
        status: 'completed',
        prompt: 'replacement',
      }],
    }))

    const reset = await get(
      `http://localhost/api/scheduled-tasks/runs?limit=1&summaryOnly=true&cursor=${encodeURIComponent(first.nextCursor)}`,
      ['api', 'scheduled-tasks', 'runs'],
    )
    expect(reset).toMatchObject({ reset: true })
    expect(reset.runs.map((run: { id: string }) => run.id)).toEqual(['replacement-head'])
  })

  test('keeps the same reset contract when SQLite is unavailable and reads canonical JSON', async () => {
    const dbPath = path.join(tmpDir, 'cc-haha', 'db', 'scheduled-runs-v1.sqlite')
    await fs.mkdir(dbPath, { recursive: true })
    const first = await get(
      'http://localhost/api/scheduled-tasks/runs?limit=1&summaryOnly=true',
      ['api', 'scheduled-tasks', 'runs'],
    )
    await fs.writeFile(path.join(tmpDir, 'scheduled_tasks_log.json'), JSON.stringify({
      runs: [{
        id: 'fallback-replacement',
        taskId: 'task-1',
        taskName: 'Task',
        startedAt: '2026-07-15T04:00:00.000Z',
        status: 'completed',
        prompt: 'fallback replacement',
      }],
    }))

    const reset = await get(
      `http://localhost/api/scheduled-tasks/runs?limit=1&summaryOnly=true&cursor=${encodeURIComponent(first.nextCursor)}`,
      ['api', 'scheduled-tasks', 'runs'],
    )
    expect(reset).toMatchObject({ reset: true })
    expect(reset.runs.map((run: { id: string }) => run.id)).toEqual(['fallback-replacement'])
  })
})
