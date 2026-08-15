/**
 * Shared shapes for dynamic workflows.
 *
 * A dynamic workflow is a plain-JavaScript script that orchestrates subagents.
 * The script never touches the filesystem or the network itself: it calls
 * `agent()` / `parallel()` / `pipeline()` and the runtime spawns real subagents
 * on its behalf. Everything the UI renders while a run is in flight travels as
 * `WorkflowProgressEvent`s, so these shapes are the contract between the
 * runtime, the Ink TUI, the local server, and the desktop app.
 */

/** One entry of `meta.phases` — the phase list shown before a run is approved. */
export type WorkflowPhaseMeta = {
  title: string
  detail?: string
  model?: string
}

/**
 * The `export const meta = {...}` block every script must start with.
 * Parsed as a pure literal (no identifiers, calls, or interpolation) so that
 * listing saved workflows never executes untrusted code.
 */
export type WorkflowMeta = {
  name: string
  description: string
  whenToUse?: string
  title?: string
  phases?: WorkflowPhaseMeta[]
  model?: string
}

/** Where a workflow definition was loaded from. */
export type WorkflowSource =
  | 'built-in'
  | 'userSettings'
  | 'projectSettings'
  | 'plugin'
  | 'inline'

/** A discovered, runnable workflow definition. */
export type WorkflowDefinition = {
  source: WorkflowSource
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhaseMeta[]
  script: string
  filePath?: string
}

export type WorkflowAgentRunState = 'start' | 'progress' | 'done' | 'error'

/** Lifecycle of one `agent()` call. Keyed by `index` (1-based, run-scoped). */
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
  /** Replayed from the resume journal instead of re-run. */
  cached?: boolean
  /** Stopped by the user rather than failed on its own. */
  skipped?: boolean
  /** Refused before spawning (permission rule or safety check). */
  blocked?: boolean
  error?: string
  promptPreview?: string
  resultPreview?: string
  lastToolName?: string
}

/** A `phase()` call, or a seeded entry from `meta.phases`. */
export type WorkflowPhaseEvent = {
  type: 'workflow_phase'
  index: number
  title: string
  /** `'meta'` for entries seeded from meta.phases, `'script'` for phase() calls. */
  kind?: 'meta' | 'script'
}

/** A `log()` call, or a runtime note (a failed pipeline slot, a stall warning). */
export type WorkflowLogEvent = {
  type: 'workflow_log'
  message: string
}

export type WorkflowProgressEvent =
  | WorkflowAgentEvent
  | WorkflowPhaseEvent
  | WorkflowLogEvent

export function isWorkflowAgentEvent(
  event: WorkflowProgressEvent,
): event is WorkflowAgentEvent {
  return event.type === 'workflow_agent'
}

export function isWorkflowPhaseEvent(
  event: WorkflowProgressEvent,
): event is WorkflowPhaseEvent {
  return event.type === 'workflow_phase'
}

/** Progress rows worth persisting in the run summary — logs are transient. */
export function isDurableWorkflowEvent(event: WorkflowProgressEvent): boolean {
  return event.type !== 'workflow_log'
}

/** Options a script may pass as the second argument to `agent()`. */
export type WorkflowAgentOptions = {
  label?: string
  phase?: string
  schema?: unknown
  model?: string
  effort?: string
  isolation?: 'worktree' | 'remote'
  agentType?: string
  stallMs?: number
}

/** Outcome of one script execution, before it is turned into a tool result. */
export type WorkflowRunOutcome = {
  result: unknown
  agentCount: number
  logs: string[]
  failures: string[]
  durationMs: number
  error?: string
}

/** The token allowance a run may spend, threaded in from the parent turn. */
export type WorkflowTokenBudget = {
  total: number | null
  getTurnSpent: () => number
}
