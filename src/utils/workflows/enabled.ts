import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getGlobalConfig } from '../config.js'
import { isEnvTruthy } from '../envUtils.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from '../settings/settings.js'

export const WORKFLOW_SIZE_GUIDELINES = [
  'unrestricted',
  'small',
  'medium',
  'large',
] as const

export type WorkflowSizeGuideline = (typeof WORKFLOW_SIZE_GUIDELINES)[number]

export const DEFAULT_WORKFLOW_SIZE_GUIDELINE: WorkflowSizeGuideline = 'medium'

/** Agent count each guideline asks Claude to aim for. Advice, not a cap. */
export const WORKFLOW_SIZE_AGENT_TARGETS: Record<
  WorkflowSizeGuideline,
  number | null
> = {
  unrestricted: null,
  small: 5,
  medium: 15,
  large: 50,
}

export type WorkflowsDisabledReason = 'env' | 'managed' | 'settings'

/** Agent count that triggers the "Large workflow" advisory, absent a guideline. */
export const WORKFLOW_LARGE_AGENT_THRESHOLD = 25
/** Projected-token count that triggers the same advisory. */
export const WORKFLOW_LARGE_TOKEN_THRESHOLD = 1_500_000
/** Token estimate per not-yet-started agent, before any real usage is known. */
export const WORKFLOW_ASSUMED_TOKENS_PER_AGENT = 70_000

/**
 * Why dynamic workflows are unavailable, or `null` when they are available.
 *
 * Managed settings are checked separately from user settings so the CLI can
 * say *who* turned the feature off — a user who cannot re-enable it needs to
 * know it was their organisation, not a toggle they flipped.
 */
export function getWorkflowsDisabledReason(): WorkflowsDisabledReason | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS)) return 'env'
  if (getSettingsForSource('policySettings')?.disableWorkflows === true) {
    return 'managed'
  }
  const merged = getSettings_DEPRECATED()
  if (merged.disableWorkflows === true) return 'settings'
  // `enableWorkflows: false` is the /config toggle's off position. It is a
  // separate key from `disableWorkflows` so an org can hard-disable while a
  // user's toggle stays untouched underneath.
  if (merged.enableWorkflows === false) return 'settings'
  return null
}

export function areWorkflowsEnabled(): boolean {
  return getWorkflowsDisabledReason() === null
}

/**
 * Whether typing `ultracode` opts a turn into orchestration.
 *
 * On by default; the `/config` row writes `false` to turn it off. Independent
 * of whether workflows themselves are enabled — a disabled feature has no
 * keyword to suppress.
 */
export function isWorkflowKeywordTriggerEnabled(): boolean {
  if (!areWorkflowsEnabled()) return false
  // The keyword is an opt-in only in a prompt the user typed. A `-p` run, an
  // SDK caller, a scheduled task, or a relayed PR comment can all contain the
  // word "ultracode" without anyone having asked for a hundred agents.
  if (getIsNonInteractiveSession()) return false
  return getSettings_DEPRECATED().workflowKeywordTriggerEnabled ?? true
}

export type LargeWorkflowWarning = {
  axis: 'agents' | 'tokens' | 'both'
  scheduledAgents: number
  totalTokens: number
  projectedTokens: number
  agentCap: number
  tokenCap: number
  /** True when the agent cap came from the size guideline, not the default. */
  capFromGuideline: boolean
}

/**
 * Advisory shown when a run grows past what the user asked for.
 *
 * It never pauses or limits anything — the point is that a runaway script is
 * visible before it has spent the tokens, so the user can stop it from
 * `/workflows`. Suppressed under ultracode: turning that on already opts in
 * to large runs, so the warning would fire on every single run.
 */
export function getLargeWorkflowWarning(params: {
  scheduledAgents: number
  startedAgents: number
  totalTokens: number
  ultracodeActive: boolean
}): LargeWorkflowWarning | undefined {
  if (params.ultracodeActive) return undefined

  const guideline = getWorkflowSizeGuideline()
  const guidelineCap = isWorkflowSizeGuidelineExplicit()
    ? WORKFLOW_SIZE_AGENT_TARGETS[guideline] ?? undefined
    : undefined
  const agentCap =
    positiveInt(process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS) ??
    guidelineCap ??
    WORKFLOW_LARGE_AGENT_THRESHOLD
  const tokenCap =
    positiveInt(process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS) ??
    WORKFLOW_LARGE_TOKEN_THRESHOLD

  const perAgent =
    params.startedAgents > 0
      ? params.totalTokens / params.startedAgents
      : WORKFLOW_ASSUMED_TOKENS_PER_AGENT
  const projectedTokens = Math.max(
    params.totalTokens,
    Math.round(perAgent * params.scheduledAgents),
  )

  const overAgents = params.scheduledAgents > agentCap
  const overTokens = params.totalTokens > tokenCap || projectedTokens > tokenCap
  if (!overAgents && !overTokens) return undefined

  return {
    axis: overAgents && overTokens ? 'both' : overAgents ? 'agents' : 'tokens',
    scheduledAgents: params.scheduledAgents,
    totalTokens: params.totalTokens,
    projectedTokens,
    agentCap,
    tokenCap,
    capFromGuideline: overAgents && guidelineCap !== undefined,
  }
}

function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function describeWorkflowsDisabled(
  reason: WorkflowsDisabledReason,
): string {
  switch (reason) {
    case 'env':
      return 'Dynamic workflows are disabled by CLAUDE_CODE_DISABLE_WORKFLOWS.'
    case 'managed':
      return 'Dynamic workflows are disabled by managed settings (`disableWorkflows`).'
    case 'settings':
      return 'Dynamic workflows are disabled in settings (`disableWorkflows`). Turn them back on in /config.'
  }
}

/**
 * The configured size guideline.
 *
 * A settings file wins over the interactive `/config` value so an organisation
 * can pin the scale; `/config` writes to user settings, which is where the
 * fallback lands.
 */
export function getWorkflowSizeGuideline(): WorkflowSizeGuideline {
  const fromSettings = getWorkflowSizeGuidelineFromSettings()
  if (fromSettings) return fromSettings
  const fromConfig = readGlobalGuideline()
  if (fromConfig) return fromConfig
  return DEFAULT_WORKFLOW_SIZE_GUIDELINE
}

/**
 * The `/config` choice, or undefined.
 *
 * `getGlobalConfig()` throws before bootstrap opens config access, and this is
 * read from the tool prompt — which the SDK can build early. A missing
 * guideline is not worth failing a turn over.
 */
function readGlobalGuideline(): WorkflowSizeGuideline | undefined {
  try {
    const value = getGlobalConfig().workflowSizeGuideline
    return isSizeGuideline(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The guideline a settings file pins, if any.
 *
 * A settings file outranks the `/config` choice so an organisation can fix the
 * scale; `/config` hides its row entirely in that case rather than offering a
 * control that would silently do nothing.
 */
export function getWorkflowSizeGuidelineFromSettings():
  | WorkflowSizeGuideline
  | undefined {
  const managed = getSettingsForSource('policySettings')?.workflowSizeGuideline
  if (isSizeGuideline(managed)) return managed
  const merged = getSettings_DEPRECATED().workflowSizeGuideline
  if (isSizeGuideline(merged)) return merged
  return undefined
}

/** True when the guideline was chosen, rather than falling back to the default. */
export function isWorkflowSizeGuidelineExplicit(): boolean {
  if (getWorkflowSizeGuidelineFromSettings() !== undefined) return true
  return readGlobalGuideline() !== undefined
}

/** Sentence appended to the Workflow tool prompt so Claude sizes runs to taste. */
export function describeWorkflowSizeGuideline(
  guideline: WorkflowSizeGuideline = getWorkflowSizeGuideline(),
): string {
  const target = WORKFLOW_SIZE_AGENT_TARGETS[guideline]
  if (target === null) {
    return 'This session has no workflow size guideline: size the workflow to the task.'
  }
  return (
    `This session has the workflow size guideline: ${guideline} — keep workflows under ${target} agents. ` +
    "This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale. " +
    'The user can raise or remove it with "Dynamic workflow size" in /config.'
  )
}

function isSizeGuideline(value: unknown): value is WorkflowSizeGuideline {
  return (
    typeof value === 'string' &&
    (WORKFLOW_SIZE_GUIDELINES as readonly string[]).includes(value)
  )
}
