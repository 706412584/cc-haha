// desktop/src/types/provider.ts

export type ApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses'

export type ProviderAuthStrategy =
  | 'api_key'
  | 'auth_token'
  | 'auth_token_empty_api_key'
  | 'dual_same_token'
  | 'dual_dummy'

export type ProviderRuntimeKind = 'anthropic_compatible' | 'openai_oauth' | 'grok_oauth'

export type ModelMapping = {
  main: string
  fable?: string
  haiku: string
  sonnet: string
  opus: string
}

export type Model1mSupport = {
  main: boolean
  haiku: boolean
  sonnet: boolean
  opus: boolean
}

export type ModelContextWindows = Record<string, number>

export type ImageGenerationConfig = {
  model: string
  baseUrl?: string
  apiKey?: string
}

export type SavedProvider = {
  id: string
  presetId: string
  name: string
  apiKey: string  // masked from server
  authStrategy?: ProviderAuthStrategy
  baseUrl: string
  apiFormat: ApiFormat
  runtimeKind?: ProviderRuntimeKind
  models: ModelMapping
  model1mSupport?: Model1mSupport
  autoCompactWindow?: number
  modelContextWindows?: ModelContextWindows
  toolSearchEnabled?: boolean
  disableExperimentalBetas?: boolean
  imageGeneration?: ImageGenerationConfig
  notes?: string
  /**
   * Sticky compatibility marker — server sets this when it observes the
   * provider rejecting Anthropic's `thinking` field with a 4xx (typical
   * for Bedrock proxies that wrap unknown params into
   * additionalModelRequestFields). The desktop renders a "思考不兼容"
   * badge next to the provider in Settings, and the server starts the
   * sidecar with CLAUDE_CODE_DISABLE_THINKING=1 so subsequent calls
   * stop sending thinking. Cleared automatically when the user edits
   * the provider, giving the new config a fresh chance.
   */
  thinkingIncompatible?: boolean
  /** Last 4xx message snippet, surfaced in the badge tooltip. */
  thinkingIncompatibleReason?: string
}

export type CreateProviderInput = {
  presetId: string
  name: string
  apiKey: string
  authStrategy?: ProviderAuthStrategy
  baseUrl: string
  apiFormat?: ApiFormat
  runtimeKind?: ProviderRuntimeKind
  models: ModelMapping
  model1mSupport?: Model1mSupport
  autoCompactWindow?: number
  modelContextWindows?: ModelContextWindows
  toolSearchEnabled?: boolean
  disableExperimentalBetas?: boolean
  imageGeneration?: ImageGenerationConfig
  notes?: string
}

export type UpdateProviderInput = {
  name?: string
  apiKey?: string
  authStrategy?: ProviderAuthStrategy
  baseUrl?: string
  apiFormat?: ApiFormat
  runtimeKind?: ProviderRuntimeKind
  models?: ModelMapping
  model1mSupport?: Model1mSupport | null
  autoCompactWindow?: number | null
  modelContextWindows?: ModelContextWindows | null
  toolSearchEnabled?: boolean
  disableExperimentalBetas?: boolean
  imageGeneration?: ImageGenerationConfig | null
  notes?: string
}

export type TestProviderConfigInput = {
  baseUrl: string
  apiKey: string
  modelId: string
  authStrategy?: ProviderAuthStrategy
  apiFormat?: ApiFormat
}

/** Input for the server-side `/api/providers/fetch-models` proxy. */
export type FetchModelsInput = {
  baseUrl: string
  apiKey: string
  apiFormat?: ApiFormat
}

/** Response from `/api/providers/fetch-models`. `data` is the upstream JSON body verbatim. */
export type FetchModelsResponse = {
  status: number
  data: unknown
}

export type ProviderTestStepResult = {
  success: boolean
  latencyMs: number
  error?: string
  modelUsed?: string
  httpStatus?: number
}

export type ProviderTestResult = {
  /** Step 1: Basic connectivity */
  connectivity: ProviderTestStepResult
  /** Step 2: Proxy pipeline (only for openai_* formats) */
  proxy?: ProviderTestStepResult
}

/** Which cc-switch app section a candidate was read from. */
export type CcSwitchAppType = 'claude' | 'claude-desktop'

export type CcSwitchSkipReason =
  | 'no-base-url'
  | 'no-api-key'
  | 'no-model'
  | 'unsupported-format'
  | 'full-url-endpoint'

export type CcSwitchUnavailableReason =
  | 'not-found'
  | 'unreadable'
  | 'sqlite-unavailable'
  | 'schema-unsupported'
  | 'version-too-old'

export type CcSwitchCandidate = {
  /** Opaque and unique — used as the React key and the selection id. */
  sourceId: string
  appType: CcSwitchAppType
  name: string
  baseUrl: string
  /** Already masked by the server; display as-is. */
  apiKeyPreview: string
  hasApiKey: boolean
  models: ModelMapping
  model1mSupport: Model1mSupport
  apiFormat: ApiFormat
  authStrategy: ProviderAuthStrategy
  presetId: string
  /** Was the active provider in cc-switch. */
  isCurrent: boolean
  importable: boolean
  skipReason?: CcSwitchSkipReason
  /** An existing provider of ours this one likely duplicates. */
  duplicate?: { id: string; name: string }
  notes?: string
}

export type CcSwitchScanResult = {
  available: boolean
  reason?: CcSwitchUnavailableReason
  source?: 'sqlite' | 'json'
  configDir?: string
  candidates: CcSwitchCandidate[]
}

export type CcSwitchImportResult = {
  imported: SavedProvider[]
  skipped: { sourceId: string; reason: string }[]
}

export type ProviderModelInfo = {
  id: string
  ownedBy?: string
}

export type ProviderModelsInput = {
  baseUrl: string
  apiKey: string
  isFullUrl?: boolean
  modelsUrl?: string
}

export type FetchUpstreamModelsInput = {
  baseUrl: string
  apiKey: string
  apiFormat: ApiFormat
}

export type FetchUpstreamModelsResult = {
  status: number
  data: unknown
}

export type ProviderModelsErrorCode =
  | 'missing-config'
  | 'auth-failed'
  | 'endpoint-not-found'
  | 'timeout'
  | 'not-supported'
  | 'network'
  | 'unknown'

/**
 * Upstream failures come back as HTTP 200 with `ok: false` — only a failure of
 * our own server throws. Switch on `errorCode`, never on `message`.
 */
export type ProviderModelsResult =
  | { ok: true; models: ProviderModelInfo[]; endpoint: string }
  | {
    ok: false
    errorCode: ProviderModelsErrorCode
    message: string
    httpStatus?: number
    endpointsTried: string[]
  }
