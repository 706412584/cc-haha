import { describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import { cleanupTaskOutput } from '../../utils/task/diskOutput.js'
import { WORKFLOW_MAX_PROGRESS_ROWS } from '../../utils/workflows/constants.js'
import type { WorkflowProgressEvent } from '../../utils/workflows/types.js'
import {
  buildResumePrompt,
  buildWorkflowNotification,
  completeWorkflowTask,
  registerWorkflowTask,
  updateWorkflowProgressBatch,
  type LocalWorkflowTaskState,
} from './LocalWorkflowTask.js'

/** A minimal AppState stand-in: these helpers only read and write `tasks`. */
function makeStore(task: LocalWorkflowTaskState): {
  setAppState: SetAppState
  get: () => LocalWorkflowTaskState
} {
  let state = { tasks: { [task.id]: task } } as unknown as AppState
  return {
    setAppState: updater => {
      state = updater(state)
    },
    get: () => state.tasks[task.id] as LocalWorkflowTaskState,
  }
}

function makeTask(taskId = 'w0000001'): LocalWorkflowTaskState {
  return registerWorkflowTask({
    taskId,
    script: "export const meta = { name: 'demo', description: 'Demo' }\n",
    scriptPath: '/tmp/demo.wf_abc12345-def.js',
    summary: 'Demo',
    workflowName: 'demo',
    workflowRunId: 'wf_abc12345-def',
  })
}

function agent(
  index: number,
  state: 'start' | 'progress' | 'done' | 'error',
  extra: Partial<Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>> = {},
): WorkflowProgressEvent {
  return { type: 'workflow_agent', index, label: `a${index}`, state, ...extra }
}

describe('updateWorkflowProgressBatch', () => {
  test('replaces an agent row in place and recomputes the totals', () => {
    const store = makeStore(makeTask())
    updateWorkflowProgressBatch(
      'w0000001',
      [agent(1, 'progress', { tokens: 10, toolCalls: 1 })],
      store.setAppState,
    )
    updateWorkflowProgressBatch(
      'w0000001',
      [
        agent(1, 'done', { tokens: 40, toolCalls: 3 }),
        agent(2, 'progress', { tokens: 5, toolCalls: 0 }),
      ],
      store.setAppState,
    )

    const task = store.get()
    expect(task.workflowProgress.filter(r => r.type === 'workflow_agent')).toHaveLength(2)
    expect(task.agentCount).toBe(2)
    expect(task.totalTokens).toBe(45)
    expect(task.totalToolCalls).toBe(3)
    expect(task.progressVersion).toBe(3)
  })

  test('phase rows are keyed separately from agent rows with the same index', () => {
    const store = makeStore(makeTask())
    updateWorkflowProgressBatch(
      'w0000001',
      [
        { type: 'workflow_phase', index: 1, title: 'Scan', kind: 'meta' },
        agent(1, 'done'),
      ],
      store.setAppState,
    )
    const rows = store.get().workflowProgress
    expect(rows).toHaveLength(2)
    expect(rows[0]?.type).toBe('workflow_phase')
    expect(rows[1]?.type).toBe('workflow_agent')
  })

  test('logs are trimmed before agent rows when the buffer overflows', () => {
    const store = makeStore(makeTask())
    const logs: WorkflowProgressEvent[] = Array.from(
      { length: WORKFLOW_MAX_PROGRESS_ROWS * 2 + 10 },
      (_unused, i) => ({ type: 'workflow_log', message: `line ${i}` }),
    )
    updateWorkflowProgressBatch(
      'w0000001',
      [agent(1, 'done', { tokens: 7 }), ...logs],
      store.setAppState,
    )

    const rows = store.get().workflowProgress
    expect(rows.length).toBeLessThanOrEqual(WORKFLOW_MAX_PROGRESS_ROWS + 1)
    expect(rows.some(r => r.type === 'workflow_agent')).toBe(true)
    // Oldest logs go first, so the newest line must survive.
    const kept = rows.filter(r => r.type === 'workflow_log')
    expect(kept.at(-1)).toEqual({
      type: 'workflow_log',
      message: `line ${logs.length - 1}`,
    })
    expect(store.get().totalTokens).toBe(7)
  })

  test('a settled task ignores late progress', () => {
    const task = makeTask()
    const store = makeStore({ ...task, status: 'completed' })
    updateWorkflowProgressBatch('w0000001', [agent(1, 'done')], store.setAppState)
    expect(store.get().workflowProgress).toHaveLength(0)
  })

  test('an empty batch does not bump the version', () => {
    const store = makeStore(makeTask())
    updateWorkflowProgressBatch('w0000001', [], store.setAppState)
    expect(store.get().progressVersion).toBe(0)
  })
})

describe('completeWorkflowTask', () => {
  test('resolves only after the durable progress snapshot is readable', async () => {
    const task = makeTask('wdurable1')
    try {
      const store = makeStore(task)
      updateWorkflowProgressBatch(
        task.id,
        [agent(1, 'done', { cached: true, agentId: 'agent-a' })],
        store.setAppState,
      )

      await completeWorkflowTask(task.id, 'done', 1, [], store.setAppState)

      const output = JSON.parse(await readFile(task.outputFile, 'utf8')) as {
        workflowProgress: WorkflowProgressEvent[]
      }
      expect(output.workflowProgress).toContainEqual(
        expect.objectContaining({
          type: 'workflow_agent',
          index: 1,
          cached: true,
        }),
      )
    } finally {
      await cleanupTaskOutput(task.id)
    }
  })
})

describe('buildWorkflowNotification', () => {
  const base = {
    taskId: 'w0000001',
    summary: 'Demo',
    agentCount: 3,
    totalTokens: 1200,
    totalToolCalls: 9,
    durationMs: 4500,
    transcriptDir: '/tmp/run',
    scriptPath: '/tmp/demo.wf_abc12345-def.js',
    workflowRunId: 'wf_abc12345-def',
  }

  test('a completed run points at the journal and the replay call', () => {
    const message = buildWorkflowNotification({
      ...base,
      status: 'completed',
      result: ['ALPHA'],
    })
    expect(message).toContain('<status>completed</status>')
    expect(message).toContain('<workflow-run-id>wf_abc12345-def</workflow-run-id>')
    expect(message).toContain('/tmp/run/journal.jsonl')
    expect(message).toContain(
      "Workflow({scriptPath: '/tmp/demo.wf_abc12345-def.js', resumeFromRunId: 'wf_abc12345-def'})",
    )
    expect(message).toContain('<result>["ALPHA"]</result>')
    expect(message).toContain(
      '<usage><agent_count>3</agent_count><subagent_tokens>1200</subagent_tokens><tool_uses>9</tool_uses><duration_ms>4500</duration_ms></usage>',
    )
  })

  test('a failed run offers recovery instead of the journal note', () => {
    const message = buildWorkflowNotification({
      ...base,
      status: 'failed',
      error: 'agent exploded',
      failures: ['parallel[1] failed: boom'],
    })
    expect(message).toContain('<recovery>')
    expect(message).not.toContain('journal.jsonl')
    expect(message).toContain('<failures>\nparallel[1] failed: boom\n</failures>')
    expect(message).toContain('failed: agent exploded')
  })

  test('args are threaded into the resume call so a replay reruns the same input', () => {
    const message = buildWorkflowNotification({
      ...base,
      status: 'failed',
      error: 'nope',
      args: ['a.ts', 'b.ts'],
    })
    expect(message).toContain('args: ["a.ts","b.ts"]')
  })
})

describe('buildResumePrompt', () => {
  test('names the script path and run id', () => {
    const prompt = buildResumePrompt({
      ...makeTask(),
      args: { q: 1 },
    })
    expect(prompt).toContain("scriptPath: '/tmp/demo.wf_abc12345-def.js'")
    expect(prompt).toContain("resumeFromRunId: 'wf_abc12345-def'")
    expect(prompt).toContain('args: {"q":1}')
  })
})
