/**
 * Desktop-side mirror of the CLI's dynamic-workflow progress protocol.
 *
 * These shapes arrive over the session WebSocket inside
 * `system_notification` → `task_started` / `task_progress` / `task_notification`
 * payloads. They are declared here rather than imported from `src/` because the
 * desktop bundle must not pull in the CLI runtime.
 */

export type WorkflowAgentRunState = 'start' | 'progress' | 'done' | 'error'

export type WorkflowAgentEvent = {
  type: 'workflow_agent'
  index: number
  label: string
  state: WorkflowAgentRunState
  phaseIndex?: number
  phaseTitle?: string
  agentType?: string
  isolation?: 'worktree' | 'remote'
  model?: string
  agentId?: string
  queuedAt?: number
  startedAt?: number
  lastProgressAt?: number
  durationMs?: number
  tokens?: number
  toolCalls?: number
  cached?: boolean
  skipped?: boolean
  blocked?: boolean
  error?: string
  promptPreview?: string
  resultPreview?: string
  lastToolName?: string
}

export type WorkflowPhaseEvent = {
  type: 'workflow_phase'
  index: number
  title: string
  kind?: 'meta' | 'script'
}

export type WorkflowProgressEvent = WorkflowAgentEvent | WorkflowPhaseEvent

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** One workflow run as the desktop knows it, live or just finished. */
export type WorkflowRun = {
  taskId: string
  /** Root session that owns persisted artifacts and server events. */
  sourceSessionId: string
  /** Agent transcript that launched this run; absent means root. */
  ownerAgentId?: string
  /** Session/tab currently rendering the run (synthetic for agent detail). */
  sessionId: string
  runId?: string
  workflowName: string
  description?: string
  status: WorkflowRunStatus
  startedAt: number
  updatedAt: number
  endedAt?: number
  agentCount: number
  totalTokens: number
  toolCalls: number
  /** Keyed `workflow_agent:<index>` / `workflow_phase:<index>`, newest value wins. */
  progress: WorkflowProgressEvent[]
  result?: string
  error?: string
}

export type WorkflowPhaseMeta = {
  title: string
  detail?: string
  model?: string
}

export type WorkflowDefinition = {
  name: string
  description: string
  whenToUse?: string
  source: 'built-in' | 'userSettings' | 'projectSettings' | 'plugin' | 'inline'
  phases?: WorkflowPhaseMeta[]
  filePath?: string
  script?: string
}

export type WorkflowRunSummary = {
  runId: string
  sessionId: string
  workflowName: string
  scriptPath: string
  startedAt: number
  completedAgents: number
  status: WorkflowRunStatus | 'unknown'
}

export type WorkflowRunDetail = WorkflowRunSummary & {
  script: string
  description?: string
  phases?: WorkflowPhaseMeta[]
  agents: Array<{ key: string; agentId: string; result: unknown }>
}

/** A phase with the agents that reported under it. */
export type WorkflowPhaseGroup = {
  index: number
  title: string
  agents: WorkflowAgentEvent[]
}

export function isWorkflowAgentEvent(
  event: WorkflowProgressEvent,
): event is WorkflowAgentEvent {
  return event.type === 'workflow_agent'
}

/**
 * A finished run rebuilt from disk, as the server reconstructs it.
 *
 * Carries only what outlives the process: which agents ran, under which
 * phase. There is no live state here — every agent listed has a transcript,
 * which is the fact that it ran.
 */
export type ReconstructedWorkflowRun = {
  runId: string
  taskId: string
  ownerAgentId?: string
  workflowName: string
  status: WorkflowRunStatus
  startedAt: number
  updatedAt: number
  endedAt?: number
  result?: string
  error?: string
  /** Latest durable task snapshot, including resume-cache markers. */
  progress?: WorkflowProgressEvent[]
  agents: Array<{
    agentId: string
    label: string
    phaseIndex: number
    phaseTitle?: string
    agentIndex: number
    state: WorkflowAgentRunState
    error?: string
    skipped?: boolean
  }>
}
