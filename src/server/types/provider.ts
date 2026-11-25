/**
 * Provider types — preset-based provider configuration.
 *
 * Providers are stored in ~/.claude/cc-haha/providers.json as a lightweight index.
 * The active provider's env vars are written to ~/.claude/settings.json.
 */

import { z } from 'zod'

export const CLAUDE_OFFICIAL_PROVIDER_ID = 'claude-official'
export const OPENAI_OFFICIAL_PROVIDER_ID = 'openai-official'
export const GROK_OFFICIAL_PROVIDER_ID = 'grok-official'
export const DEEPSEEK_ACCOUNT_PROVIDER_ID = 'deepseek-account'
export const PROVIDER_TOOL_SEARCH_OPT_IN_SCHEMA_VERSION = 4
export const PROVIDER_REQUEST_COMPATIBILITY_SCHEMA_VERSION = 5
export const PROVIDER_OFFICIAL_MODEL_SETTINGS_SCHEMA_VERSION = 6
export const PROVIDER_IMAGE_PROTOCOL_SCHEMA_VERSION = 7
export const PROVIDER_DEEPSEEK_ACCOUNT_MODEL_IDS_SCHEMA_VERSION = 8
export const PROVIDER_PROXY_CONFIG_SCHEMA_VERSION = 9
export const PROVIDER_ENV_OWNER_SCHEMA_VERSION = 10
// Optional import-only scripts keep old providers unchanged and preserve template fields.
export const PROVIDER_USAGE_SCRIPT_SCHEMA_VERSION = 11
export const BUILT_IN_PROVIDER_IDS = [
  CLAUDE_OFFICIAL_PROVIDER_ID,
  OPENAI_OFFICIAL_PROVIDER_ID,
  GROK_OFFICIAL_PROVIDER_ID,
  DEEPSEEK_ACCOUNT_PROVIDER_ID,
] as const

export function isBuiltInProviderId(id: string | null | undefined): boolean {
  return !!id && (BUILT_IN_PROVIDER_IDS as readonly string[]).includes(id)
}

export const ApiFormatSchema = z.enum([
  'anthropic',         // Native Anthropic Messages API (passthrough, no proxy)
  'openai_chat',       // OpenAI Chat Completions /v1/chat/completions
  'openai_responses',  // OpenAI Responses API /v1/responses
])
export type ApiFormat = z.infer<typeof ApiFormatSchema>

/**
 * Protocols a preset can route one model family to. Wider than ApiFormat: a
 * gateway may serve a family only over a protocol no provider record is saved
 * with (OpenCode Go serves Gemini only over Google `generateContent`).
 */
export const ModelApiFormatSchema = z.enum([...ApiFormatSchema.options, 'gemini'])
export type ModelApiFormat = z.infer<typeof ModelApiFormatSchema>

export const ProviderAuthStrategySchema = z.enum([
  'api_key',
  'auth_token',
  'auth_token_empty_api_key',
  'dual_same_token',
  'dual_dummy',
])
export type ProviderAuthStrategy = z.infer<typeof ProviderAuthStrategySchema>

export const ProviderRuntimeKindSchema = z.enum([
  'anthropic_compatible',
  'openai_oauth',
  'grok_oauth',
  'deepseek_oauth',
])
export type ProviderRuntimeKind = z.infer<typeof ProviderRuntimeKindSchema>

export const ModelMappingSchema = z.object({
  main: z.string(),
  fable: z.string().optional(),
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
})

export const OfficialProviderModelsSchema = z.object({
  [CLAUDE_OFFICIAL_PROVIDER_ID]: ModelMappingSchema.optional(),
  [OPENAI_OFFICIAL_PROVIDER_ID]: ModelMappingSchema.optional(),
  [GROK_OFFICIAL_PROVIDER_ID]: ModelMappingSchema.optional(),
  [DEEPSEEK_ACCOUNT_PROVIDER_ID]: ModelMappingSchema.optional(),
}).passthrough()

export const Model1mSupportSchema = z.object({
  main: z.boolean(),
  // Defaulted rather than required: providers saved before the Fable slot
  // existed carry no `fable` key, and a required field would reject them.
  fable: z.boolean().default(false),
  haiku: z.boolean(),
  sonnet: z.boolean(),
  opus: z.boolean(),
})

export const AutoCompactWindowSchema = z.number().int().min(16000).max(10000000)
export const ModelContextWindowsSchema = z.record(
  z.string().min(1),
  z.number().int().min(16000).max(10000000),
)
/** Per-model reply limits, keyed like `modelContextWindows` (a gateway's catalog). */
export const ModelMaxOutputTokensSchema = z.record(
  z.string().min(1),
  z.number().int().min(1024).max(10000000),
)
export const ToolSearchEnabledSchema = z.boolean()
export const DisableExperimentalBetasSchema = z.boolean()
export const SupportsNestedToolResultMediaSchema = z.boolean()

const RequestCapabilitySchema = z.enum(['auto', 'supported', 'unsupported'])
const OutputTokenBudgetSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

// These options describe this endpoint's contract, not capabilities inferred
// from a model name. Missing fields retain automatic behavior.
export const RequestCompatibilitySchema = z.object({
  maxOutputTokens: OutputTokenBudgetSchema.optional(),
  outputTokenLimit: OutputTokenBudgetSchema.optional(),
  outputTokenField: z.enum(['auto', 'max_tokens', 'max_completion_tokens', 'omit']).optional(),
  sampling: RequestCapabilitySchema.optional(),
  reasoning: RequestCapabilitySchema.optional(),
  parallelTools: RequestCapabilitySchema.optional(),
  structuredOutput: RequestCapabilitySchema.optional(),
}).passthrough()

export type RequestCompatibility = z.infer<typeof RequestCompatibilitySchema>

export const ImageGenerationConfigSchema = z.object({
  protocol: z.enum(['openai_images', 'gemini_native', 'xai_images']).optional(),
  model: z.string().trim().min(1),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().trim().optional(),
}).passthrough()

export const ProviderProxyModeSchema = z.enum(['follow_global', 'direct', 'manual'])
export type ProviderProxyMode = z.infer<typeof ProviderProxyModeSchema>

/**
 * Per-provider network proxy override. Absent (or mode 'follow_global') means
 * the provider keeps using the global NetworkSettings proxy — built-in
 * official providers never grow this field, so they always follow the global
 * setting by construction.
 */
export const ProviderProxyConfigSchema = z.object({
  mode: ProviderProxyModeSchema,
  url: z.string().trim().optional(),
}).superRefine((config, ctx) => {
  if (config.mode === 'manual' && !config.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: 'proxy.url is required when proxy.mode is manual',
    })
  }
})
export type ProviderProxyConfig = z.infer<typeof ProviderProxyConfigSchema>

/**
 * A provider's balance/quota query, as cc-switch stores it in a provider's
 * `meta.usage_script`. It is kept exactly as cc-switch wrote it, field names
 * included, so the same scripts and template settings can run once cc-haha has
 * a runner for them; template fields not listed here (Coding Plan ids,
 * Volcengine signing keys, ...) are preserved. cc-haha does not run it yet.
 */
export const ProviderUsageScriptSchema = z.object({
  enabled: z.boolean(),
  language: z.string().optional(),
  code: z.string(),
  timeout: z.number().int().nonnegative().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  accessToken: z.string().optional(),
  userId: z.string().optional(),
  templateType: z.string().optional(),
  autoQueryInterval: z.number().int().nonnegative().optional(),
}).passthrough()

export type ProviderUsageScript = z.infer<typeof ProviderUsageScriptSchema>

export const SavedProviderSchema = z.object({
  id: z.string(),
  presetId: z.string(),
  name: z.string().min(1),
  apiKey: z.string(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  runtimeKind: ProviderRuntimeKindSchema.default('anthropic_compatible'),
  models: ModelMappingSchema,
  model1mSupport: Model1mSupportSchema.optional(),
  autoCompactWindow: AutoCompactWindowSchema.optional(),
  modelContextWindows: ModelContextWindowsSchema.optional(),
  modelMaxOutputTokens: ModelMaxOutputTokensSchema.optional(),
  toolSearchEnabled: ToolSearchEnabledSchema.optional(),
  disableExperimentalBetas: DisableExperimentalBetasSchema.optional(),
  supportsNestedToolResultMedia: SupportsNestedToolResultMediaSchema.optional(),
  requestCompatibility: RequestCompatibilitySchema.optional(),
  imageGeneration: ImageGenerationConfigSchema.optional(),
  proxy: ProviderProxyConfigSchema.optional(),
  notes: z.string().optional(),
  /**
   * Per-provider custom request headers (curl-style multi-line "Name: Value").
   * Forwarded verbatim to the upstream as `ANTHROPIC_CUSTOM_HEADERS`. Lets a
   * user override User-Agent or add any other header a provider requires
   * (e.g. xingchiapi whitelists specific programming clients). Persisted on
   * the provider itself rather than only in the shared settings.json so a
   * non-default provider can carry its own header set.
   */
  customHeaders: z.string().optional(),
  /**
   * Optional override for the proxy's turn-limit trim budget, in UTF-8 bytes
   * of model-visible message content. Some relays cap a request's history size
   * and change both the wording and the threshold without notice; this lets the
   * user raise or lower the budget from providers.json (or the desktop provider
   * API) without waiting for a code change. Absent reads the environment
   * variable, then the built-in default.
   */
  turnLimitTrimBytes: z.number().int().positive().optional(),
  /**
   * Sticky compatibility marker: set to true when cc-haha observes this
   * provider rejecting Anthropic's `thinking` field via a 4xx like
   * "additionalModelRequestFields not supported" (typical for Bedrock
   * proxies that wrap unknown Anthropic params into AWS's
   * additionalModelRequestFields). When true, `buildProviderManagedEnv`
   * injects `CLAUDE_CODE_DISABLE_THINKING=1` so subsequent sidecar
   * launches stop sending thinking entirely. Cleared automatically on
   * any updateProvider() so users get a fresh chance after editing
   * config — matches the desktop providerCompatStore re-arm semantics
   * for fake tool_use detection.
   */
  thinkingIncompatible: z.boolean().optional(),
  /**
   * Optional last-seen 4xx message from the provider, surfaced in the
   * Settings tooltip so the user understands WHY the badge appeared.
   * Truncated to 500 chars on persist so a chatty proxy can't blow the
   * providers.json file.
   */
  thinkingIncompatibleReason: z.string().max(500).optional(),
  /**
   * Monotonically-increasing counter bumped on every {@link updateProvider}.
   * The runtime layer captures this value alongside the per-session
   * `runtimeOverride` at session start, and the next `set_runtime_config`
   * compares revisions to decide whether to force a CLI restart even when
   * the (providerId, modelId, effort, thinkingEnabled) tuple is unchanged.
   *
   * This catches "user changed baseUrl / apiKey / apiFormat / model mapping
   * but the override tuple still matches" — without it, the CLI keeps its
   * spawn-time `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` env until the
   * subprocess is killed for some other reason, which makes provider
   * config edits feel "stuck".
   *
   * Optional for backwards compatibility with providers.json files written
   * before this field existed; absent reads as 0.
   */
  revision: z.number().int().nonnegative().optional(),
  usageScript: ProviderUsageScriptSchema.optional(),
})

/**
 * A built-in OAuth provider has no saved record, so a user's per-model window
 * override lives beside its model mapping, keyed by provider id then model id.
 * Absent on older indexes, which read as "no overrides".
 */
export const OfficialProviderContextWindowsSchema = z.record(
  z.string(),
  ModelContextWindowsSchema,
)

export const ProvidersIndexSchema = z.object({
  schemaVersion: z.number().int().positive().optional(),
  activeId: z.string().nullable(),
  providers: z.array(SavedProviderSchema),
  providerOrder: z.array(z.string()).default([]),
  officialProviderModels: OfficialProviderModelsSchema.default({}),
  officialProviderContextWindows: OfficialProviderContextWindowsSchema.default({}),
})

export const CreateProviderSchema = z.object({
  presetId: z.string().min(1),
  name: z.string().min(1),
  apiKey: z.string(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  runtimeKind: ProviderRuntimeKindSchema.default('anthropic_compatible'),
  models: ModelMappingSchema,
  model1mSupport: Model1mSupportSchema.optional(),
  autoCompactWindow: AutoCompactWindowSchema.optional(),
  modelContextWindows: ModelContextWindowsSchema.optional(),
  modelMaxOutputTokens: ModelMaxOutputTokensSchema.optional(),
  toolSearchEnabled: ToolSearchEnabledSchema.optional(),
  disableExperimentalBetas: DisableExperimentalBetasSchema.optional(),
  supportsNestedToolResultMedia: SupportsNestedToolResultMediaSchema.optional(),
  requestCompatibility: RequestCompatibilitySchema.optional(),
  imageGeneration: ImageGenerationConfigSchema.optional(),
  proxy: ProviderProxyConfigSchema.optional(),
  notes: z.string().optional(),
  customHeaders: z.string().optional(),
  turnLimitTrimBytes: z.number().int().positive().optional(),
})

export const UpdateProviderSchema = z.object({
  name: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  baseUrl: z.string().optional(),
  apiFormat: ApiFormatSchema.optional(),
  runtimeKind: ProviderRuntimeKindSchema.optional(),
  models: ModelMappingSchema.optional(),
  model1mSupport: Model1mSupportSchema.nullable().optional(),
  autoCompactWindow: AutoCompactWindowSchema.nullable().optional(),
  modelContextWindows: ModelContextWindowsSchema.nullable().optional(),
  modelMaxOutputTokens: ModelMaxOutputTokensSchema.nullable().optional(),
  toolSearchEnabled: ToolSearchEnabledSchema.optional(),
  disableExperimentalBetas: DisableExperimentalBetasSchema.optional(),
  supportsNestedToolResultMedia: SupportsNestedToolResultMediaSchema.optional(),
  requestCompatibility: RequestCompatibilitySchema.nullable().optional(),
  imageGeneration: ImageGenerationConfigSchema.nullable().optional(),
  proxy: ProviderProxyConfigSchema.nullable().optional(),
  notes: z.string().optional(),
  customHeaders: z.string().nullable().optional(),
  turnLimitTrimBytes: z.number().int().positive().nullable().optional(),
})

export const TestProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  modelId: z.string().min(1),
  authStrategy: ProviderAuthStrategySchema.optional(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  supportsNestedToolResultMedia: SupportsNestedToolResultMediaSchema.optional(),
  requestCompatibility: RequestCompatibilitySchema.optional(),
  /**
   * Preset the config derives from, so an unsaved test resolves the same per-model
   * protocol rules and upstream headers the proxy would. Only an id crosses the
   * wire — the rules themselves stay server-side.
   */
  presetId: z.string().optional(),
  /**
   * The provider's multi-line `customHeaders` text. Probes call the upstream
   * directly (not through the proxy), so without this a gateway enforcing a
   * client whitelist would fail the probe while real chat succeeds.
   */
  customHeaders: z.string().optional(),
  proxy: ProviderProxyConfigSchema.optional(),
})

/**
 * Input for `POST /api/providers/fetch-models`. The model list is fetched
 * server-side to bypass the renderer's secure-context restrictions — most
 * webviews block plain `http://` requests as mixed content (the desktop
 * UI runs at `tauri://localhost` / `https://...`), and many self-hosted
 * relay providers also do not return `Access-Control-Allow-Origin` for
 * `/v1/models`. Either failure mode kills the previous browser-side
 * `fetch()`. Server-side has neither restriction.
 */
export const FetchModelsSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  apiFormat: ApiFormatSchema.default('anthropic'),
  /** See `TestProviderSchema.customHeaders`: the probe bypasses the proxy. */
  customHeaders: z.string().optional(),
})

export const ReorderProvidersSchema = z.object({
  // A permutation of the display provider ids, including built-in official providers.
  // The legacy saved-provider-only permutation is still accepted by ProviderService.
  orderedIds: z.array(z.string().min(1)).min(1),
})

// TypeScript types
export type ModelMapping = z.infer<typeof ModelMappingSchema>
export type OfficialProviderModels = z.infer<typeof OfficialProviderModelsSchema>
export type Model1mSupport = z.infer<typeof Model1mSupportSchema>
export type ImageGenerationConfig = z.infer<typeof ImageGenerationConfigSchema>
export type SavedProvider = z.infer<typeof SavedProviderSchema>
export type ProvidersIndex = z.infer<typeof ProvidersIndexSchema>
export type CreateProviderInput = z.infer<typeof CreateProviderSchema>
/**
 * What an import may persist on top of `CreateProviderInput`. The usage script
 * is accepted only from an import read on this machine, not from the public
 * create route.
 */
export type ImportProviderInput = CreateProviderInput & { usageScript?: ProviderUsageScript }
export type UpdateProviderInput = z.infer<typeof UpdateProviderSchema>
export type TestProviderInput = z.infer<typeof TestProviderSchema>
export type FetchModelsInput = z.infer<typeof FetchModelsSchema>
export type ReorderProvidersInput = z.infer<typeof ReorderProvidersSchema>

/**
 * Why step 2 ran. The two reasons do different work — one rewrites the wire
 * protocol, the other only rewrites nested tool-result media — so the UI must
 * not label both "protocol conversion".
 */
export type ProviderTestProxyReason = 'api_format' | 'nested_tool_result_media'

export interface ProviderTestStepResult {
  success: boolean
  latencyMs: number
  error?: string
  modelUsed?: string
  httpStatus?: number
  /** Only set on the proxy step; says what actually forced local handling. */
  reason?: ProviderTestProxyReason
}

export interface ProviderTestResult {
  /** Step 1: Basic connectivity — API reachable, key valid, model exists */
  connectivity: ProviderTestStepResult
  /** Step 2: Proxy pipeline when the provider requires local request handling */
  proxy?: ProviderTestStepResult
}
