import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type vm from 'vm'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
} from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { SetAppState } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  completeWorkflowTask,
  enqueueWorkflowNotification,
  failWorkflowTask,
  registerWorkflowTask,
  updateWorkflowProgressBatch,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { logForDebugging } from '../../utils/debug.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { emitTaskProgress } from '../../utils/task/sdkProgress.js'
import {
  WORKFLOW_PANEL_EMIT_INTERVAL_MS,
  WORKFLOW_PROGRESS_BATCH_MS,
} from '../../utils/workflows/constants.js'
import { createWorkflowSharedCounters } from '../../utils/workflows/harness.js'
import { createRunJournal } from '../../utils/workflows/journal.js'
import {
  getWorkflowTranscriptDir,
  getWorkflowScriptPath,
} from '../../utils/workflows/paths.js'
import { executeWorkflowScript } from '../../utils/workflows/runtime.js'
import { createNestedWorkflowRunner } from './runNestedWorkflow.js'
import {
  isDurableWorkflowEvent,
  type WorkflowMeta,
  type WorkflowProgressEvent,
} from '../../utils/workflows/types.js'

export type LaunchWorkflowParams = {
  taskId: string
  workflowRunId: string
  script: string
  scriptPath?: string
  args?: unknown
  meta: WorkflowMeta
  vmScript: vm.Script
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  toolUseId?: string
  isResume: boolean
  runNestedWorkflow?: (nameOrRef: unknown, args: unknown) => Promise<unknown>
}

export type LaunchedWorkflow = {
  task: LocalWorkflowTaskState
  transcriptDir: string
  scriptPath: string
}

/**
 * Register the background task for a run and start executing its script.
 *
 * Returns as soon as the task exists so the tool call can hand the model a run
 * id immediately; everything after that happens on the detached promise below.
 */
export function launchWorkflow(params: LaunchWorkflowParams): LaunchedWorkflow {
  const {
    taskId,
    workflowRunId,
    script,
    args,
    meta,
    vmScript,
    toolUseContext,
    canUseTool,
    toolUseId,
    isResume,
  } = params

  const setAppState: SetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const transcriptDir = getWorkflowTranscriptDir(workflowRunId)
  // A caller-supplied path is read-only: it is the user's file, and a resume
  // is supposed to pick up their edits, not overwrite them.
  const callerSuppliedPath = params.scriptPath !== undefined
  const scriptPath =
    params.scriptPath ?? getWorkflowScriptPath(workflowRunId, meta.name)

  // A resumed run replaces the settled task for the same run id, so the
  // progress view shows one entry instead of a stack of dead ones.
  if (isResume) {
    const tasks = toolUseContext.getAppState().tasks
    for (const [id, task] of Object.entries(tasks)) {
      if (
        task.type === 'local_workflow' &&
        task.workflowRunId === workflowRunId &&
        task.status !== 'running'
      ) {
        setAppState(prev => {
          const { [id]: _removed, ...rest } = prev.tasks
          return { ...prev, tasks: rest }
        })
      }
    }
  }

  const task = registerWorkflowTask({
    taskId,
    script,
    scriptPath,
    args,
    summary: meta.description,
    workflowName: meta.name,
    title: meta.title,
    phases: meta.phases,
    defaultModel: toolUseContext.options.mainLoopModel,
    workflowRunId,
    ownerAgentId: toolUseContext.agentId,
    toolUseId,
  })
  registerTask(task, setAppState)

  if (!callerSuppliedPath) void persistScript(scriptPath, script)

  const budgetTotal = getCurrentTurnTokenBudget()
  const spentBeforeRun = getTurnOutputTokens()
  const tokenBudget = {
    total: budgetTotal,
    getTurnSpent: () => getTurnOutputTokens() - spentBeforeRun,
  }

  const batcher = createProgressBatcher({
    taskId,
    toolUseId,
    setAppState,
    getTask: () =>
      toolUseContext.getAppState().tasks[taskId] as
        | LocalWorkflowTaskState
        | undefined,
    fallbackDescription: task.description,
    startTime: task.startTime,
    summary: meta.description,
  })

  void (async () => {
    const journal = createRunJournal(workflowRunId)
    const journalSnapshot = isResume ? await journal.load() : undefined
    const shared = createWorkflowSharedCounters()
    const nestedContext = {
      ...toolUseContext,
      abortController: task.abortController ?? toolUseContext.abortController,
    }
    const onAgentController = (
      agentKey: string,
      controller: AbortController | undefined,
    ) => {
      updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, current => {
        if (!current.agentControllers) return current
        if (controller) current.agentControllers.set(agentKey, controller)
        else current.agentControllers.delete(agentKey)
        return current
      })
    }

    const outcome = await executeWorkflowScript({
      vmScript,
      toolUseContext: nestedContext,
      canUseTool,
      runId: workflowRunId,
      workflowName: meta.name,
      args,
      seedPhaseTitles: meta.phases?.map(phase => phase.title),
      tokenBudget,
      journal,
      journalSnapshot,
      shared,
      onProgress: event => batcher.push(event),
      onAgentController,
      runNestedWorkflow:
        params.runNestedWorkflow ??
        createNestedWorkflowRunner({
          toolUseContext: nestedContext,
          canUseTool,
          runId: workflowRunId,
          tokenBudget,
          journal,
          shared,
          onProgress: event => batcher.push(event),
          onAgentController,
        }),
    })

    batcher.flush()

    const settled = toolUseContext.getAppState().tasks[taskId] as
      | LocalWorkflowTaskState
      | undefined
    // A run the user stopped is already terminal; do not overwrite that.
    if (settled && settled.status !== 'running') return

    const totalTokens = settled?.totalTokens ?? 0
    const totalToolCalls = settled?.totalToolCalls ?? 0
    const status = outcome.error ? 'failed' : 'completed'

    if (outcome.error) {
      await failWorkflowTask(
        taskId,
        outcome.error,
        outcome.agentCount,
        outcome.logs,
        setAppState,
      )
    } else {
      await completeWorkflowTask(
        taskId,
        outcome.result,
        outcome.agentCount,
        outcome.logs,
        setAppState,
      )
    }

    enqueueWorkflowNotification({
      taskId,
      summary: meta.description,
      status,
      result: outcome.error ? undefined : outcome.result,
      error: outcome.error,
      failures: outcome.failures,
      agentCount: outcome.agentCount,
      totalTokens,
      totalToolCalls,
      durationMs: outcome.durationMs,
      toolUseId,
      transcriptDir,
      scriptPath,
      workflowRunId,
      args,
      setAppState,
    })
  })().catch(async error => {
    batcher.cancel()
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`Workflow ${workflowRunId} crashed: ${message}`)
    await failWorkflowTask(taskId, message, 0, [], setAppState)
    enqueueWorkflowNotification({
      taskId,
      summary: meta.description,
      status: 'failed',
      error: message,
      agentCount: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      durationMs: Date.now() - task.startTime,
      toolUseId,
      transcriptDir,
      scriptPath,
      workflowRunId,
      args,
      setAppState,
    })
  })

  return { task, transcriptDir, scriptPath }
}

/**
 * Coalesce progress events before they touch AppState.
 *
 * A 40-agent run emits thousands of token-count updates; applying each one
 * would re-render the whole task list per event. Batching on a short timer
 * keeps the view live without making the UI the bottleneck.
 */
function createProgressBatcher(params: {
  taskId: string
  toolUseId?: string
  setAppState: SetAppState
  getTask: () => LocalWorkflowTaskState | undefined
  fallbackDescription: string
  startTime: number
  summary?: string
}) {
  let pending: WorkflowProgressEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPanelEmit = 0

  const drain = (): void => {
    timer = undefined
    if (pending.length === 0) return
    const batch = pending
    pending = []
    updateWorkflowProgressBatch(params.taskId, batch, params.setAppState)
    emitPanelProgress(batch)
  }

  const emitPanelProgress = (batch: WorkflowProgressEvent[]): void => {
    const durable = batch.filter(isDurableWorkflowEvent)
    if (durable.length === 0) return
    const task = params.getTask()
    if (task?.type !== 'local_workflow' || task.status !== 'running') return

    const lastAgent = [...durable]
      .reverse()
      .find(event => event.type === 'workflow_agent')
    // Token-count churn is throttled; anything else (an agent finishing, a new
    // phase) goes out immediately so the panel is never visibly behind.
    const onlyTokenChurn = durable.every(
      event => event.type === 'workflow_agent' && event.state === 'progress',
    )
    const now = Date.now()
    if (onlyTokenChurn && now - lastPanelEmit < WORKFLOW_PANEL_EMIT_INTERVAL_MS) {
      return
    }
    lastPanelEmit = now

    emitTaskProgress({
      taskId: params.taskId,
      toolUseId: params.toolUseId,
      description:
        lastAgent?.type === 'workflow_agent'
          ? lastAgent.phaseTitle
            ? `${lastAgent.phaseTitle}: ${lastAgent.label}`
            : lastAgent.label
          : params.fallbackDescription,
      startTime: params.startTime,
      totalTokens: task.totalTokens,
      toolUses: task.totalToolCalls,
      lastToolName:
        lastAgent?.type === 'workflow_agent' ? lastAgent.label : undefined,
      summary: params.summary,
      workflowRunId: task.workflowRunId,
      workflowProgress: task.workflowProgress.filter(isDurableWorkflowEvent),
      ownerAgentId: task.ownerAgentId,
    })
  }

  return {
    push(event: WorkflowProgressEvent): void {
      pending.push(event)
      if (!timer) {
        timer = setTimeout(drain, WORKFLOW_PROGRESS_BATCH_MS)
        timer.unref?.()
      }
    },
    flush(): void {
      if (timer) clearTimeout(timer)
      drain()
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = undefined
      pending = []
    },
  }
}

async function persistScript(path: string, script: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, script, 'utf8')
  } catch (error) {
    logForDebugging(
      `Failed to persist workflow script to ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
