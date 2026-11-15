import { MODEL_REASONING_CAPABILITY_TIERS } from '../../shared/modelReasoning.js'
import { normalizeModelContextKey } from './modelContextWindows.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'
import { getProviderRouteForModel } from './providerEnvScope.js'

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

function readCapabilityOverride(
  model: string,
  capability: ModelCapabilityOverride,
  env: Readonly<Record<string, string | undefined>>,
): boolean | undefined {
  const normalizedModel = normalizeModelContextKey(model)
  for (const tier of CAPABILITY_TIERS) {
    const pinned = env[tier.modelEnvVar]
    const capabilities = env[tier.capabilitiesEnvVar]
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

// Not memoized: provider switches rewrite the capability env vars in-process,
// and a cache keyed only on the model id would keep the previous provider's
// answer for the same model after a switch. Reading a few env vars is cheap.
const getSessionCapabilityOverride = (
  model: string,
  capability: ModelCapabilityOverride,
): boolean | undefined => {
  if (getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()) {
    return undefined
  }
  return readCapabilityOverride(model, capability, process.env)
}

/**
 * An Agent routed to another saved provider reads that provider's declared
 * capabilities for its model; the session's answers come from process.env.
 */
export function get3PModelCapabilityOverride(
  model: string,
  capability: ModelCapabilityOverride,
): boolean | undefined {
  const route = getProviderRouteForModel(model)
  return route
    ? readCapabilityOverride(model, capability, route.env)
    : getSessionCapabilityOverride(model, capability)
}
