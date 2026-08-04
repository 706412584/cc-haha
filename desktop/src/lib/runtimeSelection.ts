import { OFFICIAL_DEFAULT_MODEL_ID } from '../constants/modelCatalog'
import {
  OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
  OPENAI_OFFICIAL_PROVIDER_ID,
} from '../constants/openaiOfficialProvider'
import type { SavedProvider } from '../types/provider'
import type { RuntimeSelection } from '../types/runtime'
import {
  GROK_OFFICIAL_DEFAULT_MODEL_ID,
  GROK_OFFICIAL_MODELS,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'
import {
  isModelReasoningEffort,
  normalizeModelReasoningEffort,
  resolveModelReasoningProfile,
  type ModelReasoningApiFormat,
} from '../../../src/shared/modelReasoning'

export function resolveActiveProviderRuntimeSelection(
  activeId: string | null,
  activeProviderName: string | null,
  providers: SavedProvider[],
  currentModelId: string | undefined,
): RuntimeSelection | null {
  const activeProvider = activeId
    ? providers.find((provider) => provider.id === activeId)
    : activeProviderName
      ? providers.find((provider) => provider.name === activeProviderName)
      : undefined
  const inferredProviderId = activeId ?? activeProvider?.id ?? null
  if (!inferredProviderId) return null

  const providerMainModelId = activeProvider?.models.main.trim()

  return {
    providerId: inferredProviderId,
    modelId: providerMainModelId || currentModelId || (
      inferredProviderId === OPENAI_OFFICIAL_PROVIDER_ID
        ? OPENAI_OFFICIAL_DEFAULT_MODEL_ID
        : inferredProviderId === GROK_OFFICIAL_PROVIDER_ID
          ? GROK_OFFICIAL_DEFAULT_MODEL_ID
          : OFFICIAL_DEFAULT_MODEL_ID
    ),
  }
}

export function resolveDefaultRuntimeSelection(
  activeId: string | null,
  activeProviderName: string | null,
  providers: SavedProvider[],
  currentModelId: string | undefined,
): RuntimeSelection {
  return resolveActiveProviderRuntimeSelection(
    activeId,
    activeProviderName,
    providers,
    currentModelId,
  ) ?? {
    providerId: null,
    modelId: currentModelId || OFFICIAL_DEFAULT_MODEL_ID,
  }
}

export function normalizeRuntimeSelection(
  selection: RuntimeSelection,
  apiFormat?: ModelReasoningApiFormat,
): RuntimeSelection {
  if (
    selection.effortLevel === undefined ||
    selection.providerId === null ||
    selection.providerId === OPENAI_OFFICIAL_PROVIDER_ID
  ) {
    return selection
  }

  if (selection.providerId === GROK_OFFICIAL_PROVIDER_ID) {
    const model = GROK_OFFICIAL_MODELS.find((entry) => entry.id === selection.modelId)
    const effortLevel = model?.supportedReasoningEfforts?.includes(selection.effortLevel)
      ? selection.effortLevel
      : model?.defaultReasoningEffort ?? model?.supportedReasoningEfforts?.[0]
    const { effortLevel: _unsupportedEffort, ...runtime } = selection
    return effortLevel ? { ...runtime, effortLevel } : runtime
  }

  const requestedEffort = isModelReasoningEffort(selection.effortLevel)
    ? selection.effortLevel
    : undefined
  const reasoningProfile = resolveModelReasoningProfile(selection.modelId, apiFormat)
  if (!reasoningProfile && apiFormat === undefined) return selection
  const effortLevel = normalizeModelReasoningEffort(
    selection.modelId,
    requestedEffort,
    apiFormat,
  )
  if (effortLevel === selection.effortLevel) return selection

  const { effortLevel: _unsupportedEffort, ...runtime } = selection
  return effortLevel ? { ...runtime, effortLevel } : runtime
}
