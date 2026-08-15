import { cpus } from 'os'

/** Hard cap on `agent()` calls per run — a backstop against runaway loops. */
export const WORKFLOW_MAX_AGENTS = 1000

/** A single parallel()/pipeline() call may not fan out wider than this. */
export const WORKFLOW_MAX_FANOUT = 4096

/** Scripts larger than this are rejected before parsing (512 KiB). */
export const WORKFLOW_SCRIPT_MAX_BYTES = 524_288

/**
 * Wall-clock budget for the *synchronous* portion of the script. Awaiting an
 * agent does not consume it; a `while (true) {}` with no await does.
 */
export const WORKFLOW_SYNC_TIMEOUT_MS = 30_000

/** An agent that emits no progress for this long is reported as stalled. */
export const WORKFLOW_AGENT_STALL_MS = 180_000

/** Prompt/result previews shown in the progress view are clipped to this. */
export const WORKFLOW_PREVIEW_MAX_CHARS = 400

/** Labels are clipped to this when derived from the prompt. */
export const WORKFLOW_LABEL_MAX_CHARS = 60

/** Upper bound on log lines carried in the final result. */
export const WORKFLOW_MAX_COLLECTED_LOGS = 1000

/** Progress rows retained in task state; logs beyond this are dropped first. */
export const WORKFLOW_MAX_PROGRESS_ROWS = 500

/** Progress events are coalesced on this interval before touching AppState. */
export const WORKFLOW_PROGRESS_BATCH_MS = 16

/** Minimum spacing between task-panel progress emissions. */
export const WORKFLOW_PANEL_EMIT_INTERVAL_MS = 10_000

/** Agent type used for every subagent a workflow script spawns. */
export const WORKFLOW_SUBAGENT_TYPE = 'workflow-subagent'

/** Run ids look like `wf_<8 hex>-<3 hex>`; agent ids append `-<index>`. */
export const WORKFLOW_RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/

/**
 * Concurrency ceiling for in-flight agents. Bounded by CPU count so a fan-out
 * of 500 items does not spawn 500 model streams on a laptop.
 */
export function getWorkflowConcurrency(
  cpuCount: number = cpus().length,
): number {
  return Math.min(16, Math.max(2, cpuCount - 2))
}

export const WORKFLOW_DATE_BANNED_MESSAGE =
  'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). ' +
  'Stamp results after the workflow returns, or pass timestamps via args.'

export const WORKFLOW_RANDOM_BANNED_MESSAGE =
  'Math.random() is unavailable in workflow scripts (breaks resume). ' +
  'For N independent samples, include the index in the agent label or prompt.'

export const WORKFLOW_IMPORT_BANNED_MESSAGE =
  'import() is not available in workflow scripts.'

export const WORKFLOW_AGENT_CAP_MESSAGE =
  `Workflow agent() call cap reached (${WORKFLOW_MAX_AGENTS}). This usually means a loop using ` +
  'budget.remaining() never terminates because no token budget was set — remaining() returns ' +
  'Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.'

/** System prompt for a workflow subagent that returns free text. */
export const WORKFLOW_SUBAGENT_PROMPT =
  'You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.\n' +
  'NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string ' +
  'to the calling script — it is your return value, not a message to a human. Output the literal result; do not ' +
  'output confirmations like "Done." Be concise — the script will parse your output.'

/** System prompt for a workflow subagent forced through StructuredOutput. */
export function workflowStructuredSubagentPrompt(toolName: string): string {
  return (
    'You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.\n' +
    `- After calling ${toolName} successfully, end your turn. No acknowledgment needed.`
  )
}

/** Appended to a schema-bearing agent prompt so the model uses the tool. */
export function workflowStructuredOutputNote(toolName: string): string {
  return (
    `\nNOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${toolName} ` +
    "tool exactly once — the tool's input schema defines the required shape. Do your work, then call " +
    `${toolName}; do NOT put your answer in a text response (the script reads ONLY the tool call). ` +
    `If validation fails, read the error and call ${toolName} again with a corrected shape.`
  )
}
