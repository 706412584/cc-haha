import { MODEL_REASONING_CAPABILITY_TIERS } from '../../shared/modelReasoning.js'
import { normalizeModelContextKey } from './modelContextWindows.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'xhigh_effort'
  | 'max_effort'
  | 'thinking'
  | 'required_thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

/**
 * Active model first, then the shared tier pins. `ANTHROPIC_MODEL` must win when the
 * same id is also pinned on a default tier — otherwise a stale sonnet/haiku
 * capability string can clamp max/xhigh after a provider switch. Context-window
 * markers are transport annotations and must not change model identity.
 *
 * Not memoized: provider switches rewrite these env vars in-process, and a cache
 * keyed only on the model id would keep the previous provider's answer.
 */
const CAPABILITY_TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES',
  },
  ...MODEL_REASONING_CAPABILITY_TIERS,
] as const

export function get3PModelCapabilityOverride(
  model: string,
  capability: ModelCapabilityOverride,
): boolean | undefined {
  if (getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()) {
    return undefined
  }
  const normalizedModel = normalizeModelContextKey(model)
  for (const tier of CAPABILITY_TIERS) {
    const pinned = process.env[tier.modelEnvVar]
    const capabilities = process.env[tier.capabilitiesEnvVar]
    if (!pinned || capabilities === undefined) continue
    if (normalizedModel !== normalizeModelContextKey(pinned)) continue
    return capabilities
      .toLowerCase()
      .split(',')
      .map(s => s.trim())
      .includes(capability)
  }
  return undefined
}
