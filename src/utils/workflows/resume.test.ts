import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  buildSessionActivityModel,
} from '../../../desktop/src/components/activity/sessionActivityModel.js'
import { useChatStore } from '../../../desktop/src/stores/chatStore.js'
import {
  runsForSession,
  useWorkflowStore,
} from '../../../desktop/src/stores/workflowStore.js'
import { createWorkflowHarness } from './harness.js'
import { WorkflowJournal } from './journal.js'
import type {
  WorkflowAgentRunParams,
  WorkflowAgentRunResult,
} from './runWorkflowAgent.js'
import type { WorkflowProgressEvent } from './types.js'

function makeHarness(options: {
  journal?: WorkflowJournal
  journalSnapshot?: Awaited<ReturnType<WorkflowJournal['load']>>
  onRun?: (params: WorkflowAgentRunParams) => void
}) {
  const events: WorkflowProgressEvent[] = []
  let seq = 0
  const harness = createWorkflowHarness({
    toolUseContext: {
      options: { mainLoopModel: 'test-model' },
    } as unknown as ToolUseContext,
    canUseTool: (() => {}) as unknown as CanUseToolFn,
    runId: 'wf_temp0000-aaa',
    emit: event => events.push(event),
    onAgentController: () => {},
    journal: options.journal,
    journalSnapshot: options.journalSnapshot,
    runAgentImpl: async (
      params: WorkflowAgentRunParams,
    ): Promise<WorkflowAgentRunResult> => {
      options.onRun?.(params)
      return {
        agentId: `live-${++seq}`,
        value: `live:${params.prompt}`,
        tokens: 1,
        toolCalls: 0,
      }
    },
  })
  return { harness, events }
}

describe('workflow resume', () => {
  test('replays cached results and stops replaying at the first miss', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-journal-'))
    try {
      const journal = new WorkflowJournal(join(dir, 'journal.jsonl'))

      // First run: three agents, all recorded.
      const first = makeHarness({ journal })
      const a1 = await first.harness.agent('one')
      const a2 = await first.harness.agent('two')
      const a3 = await first.harness.agent('three')
      expect([a1, a2, a3]).toEqual(['live:one', 'live:two', 'live:three'])

      await journal.flush()
      const snapshot = await journal.load()
      expect(snapshot.results.size).toBe(3)

      // Second run: the middle prompt changed, so it and everything after it
      // must run live again even though the third call is byte-identical.
      const liveRuns: string[] = []
      const second = makeHarness({
        journal,
        journalSnapshot: snapshot,
        onRun: params => liveRuns.push(params.prompt),
      })
      const b1 = await second.harness.agent('one')
      const b2 = await second.harness.agent('CHANGED')
      const b3 = await second.harness.agent('three')

      expect(b1).toBe('live:one')
      expect(liveRuns).toEqual(['CHANGED', 'three'])
      expect(b2).toBe('live:CHANGED')
      expect(b3).toBe('live:three')

      const cachedEvents = second.events.filter(
        event => event.type === 'workflow_agent' && event.cached === true,
      )
      expect(cachedEvents).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('an unchanged script replays every agent from cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-journal-'))
    try {
      const journal = new WorkflowJournal(join(dir, 'journal.jsonl'))
      const first = makeHarness({ journal })
      await first.harness.agent('one')
      await first.harness.agent('two')

      await journal.flush()
      const snapshot = await journal.load()
      const liveRuns: string[] = []
      const second = makeHarness({
        journal,
        journalSnapshot: snapshot,
        onRun: params => liveRuns.push(params.prompt),
      })
      expect(await second.harness.agent('one')).toBe('live:one')
      expect(await second.harness.agent('two')).toBe('live:two')
      expect(liveRuns).toEqual([])
      expect(second.harness.getAgentCount()).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('inserting an agent preserves only the unchanged prefix cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-journal-'))
    try {
      const journal = new WorkflowJournal(join(dir, 'journal.jsonl'))
      const first = makeHarness({ journal })
      await first.harness.agent('A')
      await first.harness.agent('B')
      await first.harness.agent('C')

      await journal.flush()
      const snapshot = await journal.load()
      const liveRuns: string[] = []
      const resumed = makeHarness({
        journal,
        journalSnapshot: snapshot,
        onRun: params => liveRuns.push(params.prompt),
      })

      await resumed.harness.agent('A')
      await resumed.harness.agent('X')
      await resumed.harness.agent('B')
      await resumed.harness.agent('C')

      expect(liveRuns).toEqual(['X', 'B', 'C'])
      expect(
        resumed.events
          .filter(event => event.type === 'workflow_agent' && event.state === 'done')
          .map(event => [event.label, event.cached === true]),
      ).toEqual([
        ['A', true],
        ['X', false],
        ['B', false],
        ['C', false],
      ])

      // Carry the runtime's real events through the same WebSocket transition
      // the desktop uses. Replaying the snapshot models reconnect without
      // constructing the resulting store or Activity rows by hand.
      const sessionId = 'session-cache-insertion'
      const workflowRunId = 'wf_cache-insertion'
      const handleServerMessage = useChatStore.getState().handleServerMessage
      useWorkflowStore.setState({ runs: {} })
      handleServerMessage(sessionId, {
        type: 'system_notification',
        subtype: 'task_started',
        data: {
          task_id: 'workflow-attempt-1',
          task_type: 'local_workflow',
          workflow_name: 'cache-insertion',
          workflow_run_id: workflowRunId,
        },
      })
      handleServerMessage(sessionId, {
        type: 'system_notification',
        subtype: 'task_notification',
        data: {
          task_id: 'workflow-attempt-1',
          workflow_run_id: workflowRunId,
          status: 'stopped',
        },
      })
      handleServerMessage(sessionId, {
        type: 'system_notification',
        subtype: 'task_started',
        data: {
          task_id: 'workflow-attempt-2',
          task_type: 'local_workflow',
          workflow_name: 'cache-insertion',
          workflow_run_id: workflowRunId,
        },
      })
      for (const event of resumed.events) {
        const message = {
          type: 'system_notification' as const,
          subtype: 'task_progress' as const,
          data: {
            task_id: 'workflow-attempt-2',
            workflow_run_id: workflowRunId,
            workflow_progress: [event],
          },
        }
        handleServerMessage(sessionId, message)
        handleServerMessage(sessionId, message)
      }

      const workflowRuns = runsForSession(
        useWorkflowStore.getState(),
        sessionId,
      )
      const activity = buildSessionActivityModel({
        sessionId,
        tasks: [],
        completedAndDismissed: false,
        backgroundTasks: [],
        agentNotifications: [],
        workflowRuns,
      })
      const agentRows = activity.sections.workflow.rows.filter(
        row => !row.groupProgress,
      )

      expect(workflowRuns).toHaveLength(1)
      expect(agentRows.map(row => [row.label, row.cached === true])).toEqual([
        ['A', true],
        ['X', false],
        ['B', false],
        ['C', false],
      ])
    } finally {
      useWorkflowStore.setState({ runs: {} })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('an agent that started but never finished is not replayed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-journal-'))
    try {
      const path = join(dir, 'journal.jsonl')
      const journal = new WorkflowJournal(path)
      await journal.append({
        type: 'started',
        key: '|one|null',
        agentId: 'interrupted',
      })

      const snapshot = await journal.load()
      expect(snapshot.results.size).toBe(0)
      expect(snapshot.started.get('|one|null')).toEqual(['interrupted'])

      const liveRuns: string[] = []
      const { harness } = makeHarness({
        journal,
        journalSnapshot: snapshot,
        onRun: params => liveRuns.push(params.prompt),
      })
      await harness.agent('one')
      expect(liveRuns).toEqual(['one'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
