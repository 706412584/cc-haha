export const GROK_DEFAULT_MAIN_MODEL = 'grok-4.6'
export const GROK_DEFAULT_SONNET_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_HAIKU_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_MODEL = GROK_DEFAULT_MAIN_MODEL
export const GROK_DEFAULT_CONTEXT_WINDOW = 500_000

export type GrokModelCatalogEntry = {
  value: string
  label: string
  description: string
  contextWindow?: number
  source?: 'official' | 'cli'
  supportsReasoningEffort?: boolean
  reasoningEffort?: string
  reasoningEfforts?: string[]
}

export const GROK_MODEL_CATALOG: GrokModelCatalogEntry[] = [
  {
    ...model('grok-4.6', 'Grok 4.6', "SpaceXAI's latest frontier model", 500_000),
    supportsReasoningEffort: true,
    reasoningEffort: 'high',
    reasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
  },
  {
    ...model('grok-4.5', 'Grok 4.5', 'Grok frontier text model', 500_000),
    supportsReasoningEffort: true,
    reasoningEffort: 'high',
    reasoningEfforts: ['high', 'medium', 'low'],
  },
  {
    ...model('grok-composer-2.5-fast', 'Composer 2.5', 'Grok coding model', 200_000),
    supportsReasoningEffort: false,
  },
]

function model(
  value: string,
  label: string,
  description: string,
  contextWindow: number,
  source: 'official' | 'cli' = 'official',
): GrokModelCatalogEntry {
  return { value, label, description, contextWindow, source }
}

const EXPLICIT_MODELS = new Set(GROK_MODEL_CATALOG.map((entry) => entry.value))
const CLAUDE_COMPATIBILITY_ALIASES = new Set([
  'default',
  'grok',
  'haiku',
  'sonnet',
  'opus',
])

export function resolveGrokModel(modelId: string): string {
  const requested = modelId.trim()
  const normalized = requested.toLowerCase()
  if (EXPLICIT_MODELS.has(normalized)) return normalized
  if (
    !normalized ||
    normalized.startsWith('claude-') ||
    CLAUDE_COMPATIBILITY_ALIASES.has(normalized)
  ) {
    return GROK_DEFAULT_MAIN_MODEL
  }

  // The authenticated catalog can expose models newer than this bundled
  // client. Forward those IDs unchanged so selecting a remotely advertised
  // model never silently sends the request to a different model.
  return requested
}

export function getGrokContextWindowForModel(modelId: string): number | null {
  const resolved = resolveGrokModel(modelId)
  return GROK_MODEL_CATALOG.find((model) => model.value === resolved)?.contextWindow ?? null
}

export function resolveGrokReasoningEffort(
  modelId: string,
  requestedEffort: unknown,
): string | undefined {
  const resolved = resolveGrokModel(modelId)
  const model = GROK_MODEL_CATALOG.find((entry) => entry.value === resolved)
  if (model?.supportsReasoningEffort === false) return undefined
  if (
    typeof requestedEffort === 'string' &&
    model?.reasoningEfforts?.includes(requestedEffort)
  ) {
    return requestedEffort
  }
  return model?.reasoningEffort
}
