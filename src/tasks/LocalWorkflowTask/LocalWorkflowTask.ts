import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
  WORKFLOW_RUN_ID_TAG,
} from '../../constants/xml.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase } from '../../Task.js'
import { createAbortController } from '../../utils/abortController.js'
import { logForDebugging } from '../../utils/debug.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import {
  evictTaskOutput,
  getTaskOutputPath,
  writeTaskOutput,
} from '../../utils/task/diskOutput.js'
import { PANEL_GRACE_MS, updateTaskState } from '../../utils/task/framework.js'
import { WORKFLOW_MAX_PROGRESS_ROWS } from '../../utils/workflows/constants.js'
import { getWorkflowTranscriptDir } from '../../utils/workflows/paths.js'
import { asAgentId } from '../../types/ids.js'
import {
  isDurableWorkflowEvent,
  type WorkflowPhaseMeta,
  type WorkflowProgressEvent,
} from '../../utils/workflows/types.js'

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  /** Full script text as executed — the same bytes written to `scriptPath`. */
  script: string
  scriptPath?: string
  /** Kept under `prompt` too so generic task consumers can show something. */
  prompt: string
  args?: unknown
  summary?: string
  workflowName?: string
  title?: string
  phases?: WorkflowPhaseMeta[]
  defaultModel?: string
  workflowRunId: string
  ownerAgentId?: string
  workflowProgress: WorkflowProgressEvent[]
  /** Bumped on every applied batch so views can diff cheaply. */
  progressVersion: number
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  logs: string[]
  result?: unknown
  error?: string
  abortController?: AbortController
  /** Per-agent controllers, so a single agent can be skipped or restarted. */
  agentControllers?: Map<string, AbortController>
  evictAfter?: number
}

export function isLocalWorkflowTask(
  task: unknown,
): task is LocalWorkflowTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_workflow'
  )
}

export function registerWorkflowTask(params: {
  taskId: string
  script: string
  scriptPath?: string
  args?: unknown
  summary?: string
  workflowName?: string
  title?: string
  phases?: WorkflowPhaseMeta[]
  defaultModel?: string
  workflowRunId: string
  ownerAgentId?: string
  toolUseId?: string
  startTime?: number
}): LocalWorkflowTaskState {
  const base = createTaskStateBase(
    params.taskId,
    'local_workflow',
    params.summary ?? 'Dynamic workflow',
    params.toolUseId,
  )
  return {
    ...base,
    ...(params.startTime !== undefined ? { startTime: params.startTime } : {}),
    type: 'local_workflow',
    status: 'running',
    script: params.script,
    scriptPath: params.scriptPath,
    args: params.args,
    prompt: params.script,
    summary: params.summary,
    workflowName: params.workflowName,
    title: params.title,
    phases: params.phases,
    defaultModel: params.defaultModel,
    workflowRunId: params.workflowRunId,
    ownerAgentId: params.ownerAgentId,
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    abortController: createAbortController(),
    agentControllers: new Map(),
  }
}

/**
 * Fold a batch of progress events into the task's state.
 *
 * Agent and phase rows are keyed by `type:index` and overwritten in place, so
 * a run that emits hundreds of updates for the same twenty agents keeps twenty
 * rows. Only logs accumulate, and they are the first thing trimmed.
 */
export function updateWorkflowProgressBatch(
  taskId: string,
  events: WorkflowProgressEvent[],
  setAppState: SetAppState,
): void {
  if (events.length === 0) return
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task

    const rows = [...task.workflowProgress]
    const rowIndexByKey = new Map<string, number>()
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      if (row.type === 'workflow_agent' || row.type === 'workflow_phase') {
        rowIndexByKey.set(`${row.type}:${row.index}`, i)
      }
    }

    let agentCount = task.agentCount
    let appendedLogs = false
    for (const event of events) {
      if (event.type === 'workflow_log') {
        rows.push(event)
        appendedLogs = true
        continue
      }
      const key = `${event.type}:${event.index}`
      const existing = rowIndexByKey.get(key)
      if (existing !== undefined) rows[existing] = event
      else {
        rowIndexByKey.set(key, rows.length)
        rows.push(event)
      }
      if (event.type === 'workflow_agent') {
        agentCount = Math.max(agentCount, event.index)
      }
    }

    const trimmed =
      appendedLogs && rows.length > WORKFLOW_MAX_PROGRESS_ROWS * 2
        ? dropOldestLogs(rows, rows.length - WORKFLOW_MAX_PROGRESS_ROWS)
        : rows

    let totalTokens = 0
    let totalToolCalls = 0
    for (const row of trimmed) {
      if (row.type !== 'workflow_agent') continue
      totalTokens += row.tokens ?? 0
      totalToolCalls += row.toolCalls ?? 0
    }

    return {
      ...task,
      workflowProgress: trimmed,
      progressVersion: task.progressVersion + events.length,
      agentCount,
      totalTokens,
      totalToolCalls,
    }
  })
}

function dropOldestLogs(
  rows: WorkflowProgressEvent[],
  toDrop: number,
): WorkflowProgressEvent[] {
  let remaining = toDrop
  const kept: WorkflowProgressEvent[] = []
  for (const row of rows) {
    if (remaining > 0 && row.type === 'workflow_log') {
      remaining--
      continue
    }
    kept.push(row)
  }
  return kept
}

function settleWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
  status: 'completed' | 'failed' | 'killed' | 'paused',
  patch: Partial<LocalWorkflowTaskState>,
): LocalWorkflowTaskState | null {
  let settled: LocalWorkflowTaskState | null = null
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    settled = task
    task.abortController?.abort()
    const endTime = Date.now()
    return {
      ...task,
      ...patch,
      status,
      endTime,
      ...(status !== 'paused' ? { evictAfter: endTime + PANEL_GRACE_MS } : {}),
      abortController: undefined,
      agentControllers: undefined,
    }
  })
  return settled
}

export function completeWorkflowTask(
  taskId: string,
  result: unknown,
  agentCount: number,
  logs: string[],
  setAppState: SetAppState,
): Promise<void> {
  const settled = settleWorkflowTask(taskId, setAppState, 'completed', {
    result,
    agentCount,
    logs,
  })
  if (!settled) return Promise.resolve()
  return writeWorkflowOutput(settled, { result, agentCount, logs })
}

export function failWorkflowTask(
  taskId: string,
  error: string,
  agentCount: number,
  logs: string[],
  setAppState: SetAppState,
): Promise<void> {
  const settled = settleWorkflowTask(taskId, setAppState, 'failed', {
    error,
    agentCount,
    logs,
  })
  if (!settled) return Promise.resolve()
  return evictTaskOutput(taskId).then(() =>
    writeWorkflowOutput(settled, { error, agentCount, logs }),
  )
}

/** Stop the run but keep it resumable: the journal on disk is still valid. */
export function pauseWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): boolean {
  return (
    settleWorkflowTask(taskId, setAppState, 'paused', { notified: true }) !==
    null
  )
}

export function killWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): boolean {
  const settled = settleWorkflowTask(taskId, setAppState, 'killed', {})
  if (!settled) return false
  void evictTaskOutput(taskId)
  enqueueWorkflowNotification({
    taskId,
    summary: settled.summary ?? settled.description,
    status: 'killed',
    agentCount: settled.agentCount,
    totalTokens: settled.totalTokens,
    totalToolCalls: settled.totalToolCalls,
    durationMs: Date.now() - settled.startTime,
    toolUseId: settled.toolUseId,
    transcriptDir: getWorkflowTranscriptDir(settled.workflowRunId),
    scriptPath: settled.scriptPath,
    workflowRunId: settled.workflowRunId,
    args: settled.args,
    setAppState,
  })
  return true
}

function abortWorkflowAgent(
  taskId: string,
  agentKey: string,
  reason: 'user-skip' | 'user-retry',
  setAppState: SetAppState,
): boolean {
  let aborted = false
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const controller = task.agentControllers?.get(agentKey)
    if (controller && !controller.signal.aborted) {
      controller.abort(new DOMException(reason, 'AbortError'))
      aborted = true
    }
    return task
  })
  return aborted
}

export function skipWorkflowAgent(
  taskId: string,
  agentKey: string,
  setAppState: SetAppState,
): boolean {
  return abortWorkflowAgent(taskId, agentKey, 'user-skip', setAppState)
}

export function retryWorkflowAgent(
  taskId: string,
  agentKey: string,
  setAppState: SetAppState,
): boolean {
  return abortWorkflowAgent(taskId, agentKey, 'user-retry', setAppState)
}

/** The `Workflow(...)` call that picks a stopped run back up. */
export function buildResumePrompt(task: LocalWorkflowTaskState): string {
  const argsPart =
    task.args !== undefined ? `, args: ${JSON.stringify(task.args)}` : ''
  return (
    `Resume the paused workflow by calling: Workflow({scriptPath: '${task.scriptPath}', ` +
    `resumeFromRunId: '${task.workflowRunId}'${argsPart}}) — completed agents return cached results.`
  )
}

export function enqueueWorkflowNotification(params: {
  taskId: string
  summary: string
  status: 'completed' | 'failed' | 'killed'
  result?: unknown
  error?: string
  failures?: string[]
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  durationMs: number
  toolUseId?: string
  transcriptDir?: string
  scriptPath?: string
  workflowRunId?: string
  args?: unknown
  setAppState: SetAppState
}): void {
  let shouldEnqueue = false
  let ownerAgentId: string | undefined
  updateTaskState<LocalWorkflowTaskState>(
    params.taskId,
    params.setAppState,
    task => {
      if (task.notified) return task
      shouldEnqueue = true
      ownerAgentId = task.ownerAgentId
      return { ...task, notified: true }
    },
  )
  if (!shouldEnqueue) return

  const message = buildWorkflowNotification(params)
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    agentId: ownerAgentId ? asAgentId(ownerAgentId) : undefined,
  })
  // Root notifications are converted into SDK terminal events when print.ts
  // drains the command. An agent-owned workflow notification is consumed by
  // its parent loop, so it needs an explicitly owned SDK bookend here.
  if (ownerAgentId) {
    emitTaskTerminatedSdk(
      params.taskId,
      params.status === 'killed' ? 'stopped' : params.status,
      {
        toolUseId: params.toolUseId,
        summary: params.summary,
        outputFile: getTaskOutputPath(params.taskId),
        usage: {
          total_tokens: params.totalTokens,
          tool_uses: params.totalToolCalls,
          duration_ms: params.durationMs,
        },
        ownerAgentId,
      },
    )
  }
}

/**
 * The `<task-notification>` the model reads when a run settles.
 *
 * The recovery and journal hints matter: without the exact `Workflow({...})`
 * call and the journal path, a model looking at an empty result has no way to
 * tell "the agents returned nothing" from "post-processing dropped it".
 */
export function buildWorkflowNotification(params: {
  taskId: string
  summary: string
  status: 'completed' | 'failed' | 'killed'
  result?: unknown
  error?: string
  failures?: string[]
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  durationMs: number
  toolUseId?: string
  transcriptDir?: string
  scriptPath?: string
  workflowRunId?: string
  args?: unknown
}): string {
  const {
    taskId,
    summary,
    status,
    result,
    error,
    failures,
    agentCount,
    totalTokens,
    totalToolCalls,
    durationMs,
    toolUseId,
    transcriptDir,
    scriptPath,
    workflowRunId,
    args,
  } = params

  const headline =
    status === 'completed'
      ? `Dynamic workflow "${summary}" completed`
      : status === 'failed'
        ? `Dynamic workflow "${summary}" failed: ${error || 'Unknown error'}`
        : `Dynamic workflow "${summary}" was stopped`

  const argsPart = args !== undefined ? `, args: ${JSON.stringify(args)}` : ''
  const resumeCall =
    scriptPath && workflowRunId
      ? `Workflow({scriptPath: '${scriptPath}', resumeFromRunId: '${workflowRunId}'${argsPart}})`
      : undefined

  const sections: string[] = []
  if (status !== 'completed') {
    const recovery: string[] = []
    if (resumeCall) {
      recovery.push(`To resume after editing the script, call: ${resumeCall}`)
    }
    if (transcriptDir) recovery.push(`Agent transcripts: ${transcriptDir}`)
    if (recovery.length > 0) {
      sections.push(`\n<recovery>\n${recovery.join('\n')}\n</recovery>`)
    }
  } else if (transcriptDir) {
    const notes = [
      `Per-agent results: ${transcriptDir}/journal.jsonl — one {"type":"result",...} line per completed agent with its full return value.`,
      'If the result above is empty or unexpected, Read this file BEFORE diagnosing — do not assume agents returned non-empty results.',
    ]
    if (resumeCall) {
      notes.push(
        `To re-run with edited post-processing: ${resumeCall} — agents whose (prompt, opts) are unchanged replay from cache.`,
      )
    }
    sections.push(`\n<transcripts>\n${notes.join('\n')}\n</transcripts>`)
  }
  if (failures && failures.length > 0) {
    sections.push(`\n<failures>\n${failures.join('\n')}\n</failures>`)
  }

  const resultSection =
    result === undefined
      ? ''
      : `\n<result>${safeJson(result)}</result>`
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''

  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>local_workflow</${TASK_TYPE_TAG}>
<${WORKFLOW_RUN_ID_TAG}>${workflowRunId ?? ''}</${WORKFLOW_RUN_ID_TAG}>
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(taskId)}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${headline}</${SUMMARY_TAG}>${resultSection}${sections.join('')}
<usage><agent_count>${agentCount}</agent_count><subagent_tokens>${totalTokens}</subagent_tokens><tool_uses>${totalToolCalls}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>
</${TASK_NOTIFICATION_TAG}>`
}

async function writeWorkflowOutput(
  task: LocalWorkflowTaskState,
  extra: { result?: unknown; error?: string; agentCount: number; logs: string[] },
): Promise<void> {
  try {
    await writeTaskOutput(
      task.id,
      JSON.stringify(
        {
          summary: task.summary,
          workflowName: task.workflowName,
          workflowRunId: task.workflowRunId,
          agentCount: extra.agentCount,
          logs: extra.logs,
          result: extra.result,
          error: extra.error,
          workflowProgress: task.workflowProgress.filter(isDurableWorkflowEvent),
          totalTokens: task.totalTokens,
          totalToolCalls: task.totalToolCalls,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    logForDebugging(
      `Failed to write workflow output for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '[unserializable result]'
  }
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) {
    killWorkflowTask(taskId, setAppState)
  },
}
