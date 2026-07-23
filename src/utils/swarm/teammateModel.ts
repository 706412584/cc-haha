import { CLAUDE_OPUS_4_6_CONFIG, CLAUDE_OPUS_4_8_CONFIG } from '../model/configs.js'
import { getAPIProvider } from '../model/providers.js'

// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// use the current Opus default. Must be provider-aware so Bedrock/Vertex/Foundry
// customers get a conservative provider ID.
export function getHardcodedTeammateModelFallback(): string {
  const provider = getAPIProvider()
  return provider === 'firstParty'
    ? CLAUDE_OPUS_4_8_CONFIG.firstParty
    : CLAUDE_OPUS_4_6_CONFIG[provider]
}
