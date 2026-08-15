/**
 * Ultracode: xhigh effort plus standing dynamic-workflow orchestration.
 *
 * Not a sixth effort level — it is `xhigh` with a flag beside it. Keeping it
 * out of `EffortLevel` matters: every model-capability check, settings write,
 * and picker row already reasons about the five real levels, and a sixth would
 * have to be special-cased in all of them to mean "xhigh, but also…".
 */

import { modelSupportsXHighEffort } from '../effort.js'
import { areWorkflowsEnabled } from './enabled.js'

export const ULTRACODE_EFFORT_ARG = 'ultracode'

/** Effort ultracode resolves to once the flag is recorded separately. */
export const ULTRACODE_EFFORT_LEVEL = 'xhigh' as const

export const ULTRACODE_MENU_DESCRIPTION =
  'xhigh effort + dynamic workflows for maximum thoroughness'

export const ULTRACODE_ENTER_REMINDER =
  'Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. ' +
  "Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool's " +
  '**Ultracode** section and quality patterns. Solo only on conversational/trivial turns.'

export const ULTRACODE_STILL_ON_REMINDER =
  'Ultracode is still on — use the Workflow tool; see its Ultracode section.'

export const ULTRACODE_EXIT_REMINDER =
  "Ultracode is off — the Workflow tool's standard opt-in rule applies again."

export const WORKFLOW_KEYWORD_REMINDER =
  'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — ' +
  'use the Workflow tool to fulfill the request.'

export type UltracodeRequest =
  | { ok: true }
  | { ok: false; reason: 'workflows-disabled' | 'model' }

/**
 * Whether ultracode can be turned on right now.
 *
 * Both preconditions are real: without workflows there is nothing to
 * orchestrate, and without xhigh the "ultra" half of the level is a lie.
 */
export function canEnableUltracode(model: string): UltracodeRequest {
  if (!areWorkflowsEnabled()) return { ok: false, reason: 'workflows-disabled' }
  if (!modelSupportsXHighEffort(model)) return { ok: false, reason: 'model' }
  return { ok: true }
}

export function describeUltracodeRefusal(
  reason: Exclude<UltracodeRequest, { ok: true }>['reason'],
  model: string,
): string {
  switch (reason) {
    case 'workflows-disabled':
      return 'Ultracode needs dynamic workflows enabled (see /config).'
    case 'model':
      return `Ultracode runs at xhigh effort, which ${model} doesn't support — switch to an xhigh-capable model.`
  }
}
