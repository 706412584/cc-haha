import { OFFICIAL_DEFAULT_MODEL_ID } from '../constants/modelCatalog'
import {
  OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
  OPENAI_OFFICIAL_PROVIDER_ID,
} from '../constants/openaiOfficialProvider'
import type { SavedProvider } from '../types/provider'
import type { RuntimeSelection } from '../types/runtime'
import type { ModelInfo, ReasoningEffortLevel } from '../types/settings'
import {
  GROK_OFFICIAL_DEFAULT_MODEL_ID,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'

export function resolveActiveProviderRuntimeSelection(
  activeId: string | null,
  activeProviderName: string | null,
  providers: SavedProvider[],
  currentModel: ModelInfo | null,
  effortLevel?: ReasoningEffortLevel,
): RuntimeSelection | null {
  const activeProvider = activeId
    ? providers.find((provider) => provider.id === activeId)
    : activeProviderName
      ? providers.find((provider) => provider.name === activeProviderName)
      : undefined
  const inferredProviderId = activeId ?? activeProvider?.id ?? null
  if (!inferredProviderId) return null

  const providerMainModelId = activeProvider?.models.main.trim()
  const modelId = providerMainModelId || currentModel?.id || (
    inferredProviderId === OPENAI_OFFICIAL_PROVIDER_ID
      ? OPENAI_OFFICIAL_DEFAULT_MODEL_ID
      : inferredProviderId === GROK_OFFICIAL_PROVIDER_ID
        ? GROK_OFFICIAL_DEFAULT_MODEL_ID
        : OFFICIAL_DEFAULT_MODEL_ID
  )
  const model = currentModel?.id === modelId ? currentModel : null
  const supportedEfforts = model?.supportedReasoningEfforts
  const selectedEffort = supportedEfforts?.length === 0
    ? undefined
    : model?.defaultReasoningEffort ?? effortLevel

  return {
    providerId: inferredProviderId,
    modelId,
    ...(selectedEffort ? { effortLevel: selectedEffort } : {}),
  }
}

export function resolveDefaultRuntimeSelection(
  activeId: string | null,
  activeProviderName: string | null,
  providers: SavedProvider[],
  currentModel: ModelInfo | null,
  effortLevel?: ReasoningEffortLevel,
): RuntimeSelection {
  return resolveActiveProviderRuntimeSelection(
    activeId,
    activeProviderName,
    providers,
    currentModel,
    effortLevel,
  ) ?? {
    providerId: null,
    modelId: currentModel?.id || OFFICIAL_DEFAULT_MODEL_ID,
    ...(effortLevel ? { effortLevel } : {}),
  }
}
