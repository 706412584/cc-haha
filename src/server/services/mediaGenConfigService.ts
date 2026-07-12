import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { savePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js'
import { ApiError } from '../middleware/errorHandler.js'
import { ProviderService } from './providerService.js'

export const MEDIA_GEN_PLUGIN_ID = 'media-gen@cc-haha-builtin'
const LEGACY_PLUGIN_IDS = ['image-gen@cc-haha-builtin', MEDIA_GEN_PLUGIN_ID] as const
const MODEL_TYPES = ['imageGeneration', 'imageEditing', 'videoGeneration', 'videoEditing', 'videoExtension'] as const
const MAX_API_KEY_BYTES = 16 * 1024
const MAX_SERIALIZED_API_KEYS_BYTES = 256 * 1024

type ModelType = (typeof MODEL_TYPES)[number]
type Models = Partial<Record<ModelType, string>>
export type MediaGenCredentialRef = { kind: 'saved_provider'; providerId: string }
type Provider = { id: string; name: string; enabled: boolean; apiFormat: 'openai_compatible'; baseUrl: string; models?: Models; credentialRef?: MediaGenCredentialRef }
export type MediaGenConfig = { schemaVersion: 3; providers: Array<Provider & { models: Models; apiKeyConfigured: boolean }> }
export type MediaGenApiKeyUpdate = { action: 'keep' } | { action: 'replace'; value: string } | { action: 'clear' } | { action: 'reference'; credentialRef: MediaGenCredentialRef }
export type MediaGenFetchModelsInput = { providerId: string; baseUrl: string; apiFormat: 'openai_compatible'; apiKey: MediaGenApiKeyUpdate }

function readKeys(): Record<string, string> {
  const value = getSecureStorage().read()?.pluginSecrets?.[MEDIA_GEN_PLUGIN_ID]?.mediaProviderApiKeys
  if (typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {}
  } catch { return {} }
}

function parseBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048) throw ApiError.badRequest('Invalid provider base URL')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw ApiError.badRequest('Invalid provider base URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw ApiError.badRequest('Provider base URL must use http or https')
  return value
}

function parseCredentialRef(value: unknown): MediaGenCredentialRef | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw ApiError.badRequest('Invalid credential reference')
  const ref = value as Record<string, unknown>
  if (ref.kind !== 'saved_provider' || typeof ref.providerId !== 'string' || !ref.providerId || Object.keys(ref).length !== 2) throw ApiError.badRequest('Invalid credential reference')
  return { kind: 'saved_provider', providerId: ref.providerId }
}

function parseProvider(value: unknown, ids: Set<string>, defaultEnabled = false): Provider & { apiKey?: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw ApiError.badRequest('Invalid provider')
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.id) || ids.has(input.id)) throw ApiError.badRequest('Provider IDs must be stable and unique')
  ids.add(input.id)
  if (typeof input.name !== 'string' || input.name.length > 128) throw ApiError.badRequest('Invalid provider name')
  if ((input.enabled === undefined && !defaultEnabled) || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw ApiError.badRequest('Provider enabled must be boolean')
  if (input.apiFormat !== 'openai_compatible') throw ApiError.badRequest('Unsupported provider API format')
  if (input.models !== undefined && (!input.models || typeof input.models !== 'object' || Array.isArray(input.models))) throw ApiError.badRequest('Invalid provider models')
  const models = (input.models ?? {}) as Record<string, unknown>
  if (Object.keys(models).some(key => !MODEL_TYPES.includes(key as ModelType)) || Object.values(models).some(model => typeof model !== 'string' || !model || model.length > 256)) throw ApiError.badRequest('Invalid provider models')
  return { id: input.id, name: input.name, enabled: input.enabled ?? true, apiFormat: 'openai_compatible', baseUrl: parseBaseUrl(input.baseUrl), models: models as Models, credentialRef: parseCredentialRef(input.credentialRef), apiKey: input.apiKey }
}

async function resolveSavedProvider(ref: MediaGenCredentialRef, baseUrl: string) {
  let saved
  try { saved = await new ProviderService().getProvider(ref.providerId) } catch { throw ApiError.badRequest('Referenced provider is unavailable') }
  if (!saved.apiKey || (saved.apiFormat !== 'openai_chat' && saved.apiFormat !== 'openai_responses')) throw ApiError.badRequest('Referenced provider is not a compatible static-key provider')
  if (new URL(parseBaseUrl(saved.baseUrl)).origin !== new URL(baseUrl).origin) throw ApiError.badRequest('Referenced provider origin does not match media provider')
  return saved
}

export async function resolveMediaGenProviderCredentials(input: MediaGenFetchModelsInput): Promise<{ baseUrl: string; apiKey: string; apiFormat: 'openai_chat' }> {
  const baseUrl = parseBaseUrl(input.baseUrl)
  if (input.apiKey.action === 'replace') {
    if (!input.apiKey.value || Buffer.byteLength(input.apiKey.value, 'utf8') > MAX_API_KEY_BYTES) throw ApiError.badRequest('Invalid API key')
    return { baseUrl, apiKey: input.apiKey.value, apiFormat: 'openai_chat' }
  }
  if (input.apiKey.action === 'clear') throw ApiError.badRequest('Provider API key is not configured; re-enter the API key')
  if (input.apiKey.action === 'reference') return { baseUrl, apiKey: (await resolveSavedProvider(input.apiKey.credentialRef, baseUrl)).apiKey, apiFormat: 'openai_chat' }
  const provider = getMediaGenConfig().providers.find(item => item.id === input.providerId)
  if (!provider || new URL(provider.baseUrl).origin !== new URL(baseUrl).origin) throw ApiError.badRequest('Provider origin changed; re-enter the API key')
  if (provider.credentialRef) return { baseUrl, apiKey: (await resolveSavedProvider(provider.credentialRef, baseUrl)).apiKey, apiFormat: 'openai_chat' }
  const apiKey = readKeys()[input.providerId]
  if (!apiKey) throw ApiError.badRequest('Provider API key is not configured; re-enter the API key')
  return { baseUrl, apiKey, apiFormat: 'openai_chat' }
}
export const getMediaGenProviderCredentials = resolveMediaGenProviderCredentials

export async function saveMediaGenConfig(body: Record<string, unknown>): Promise<MediaGenConfig> {
  if (body.schemaVersion !== 3 || !Array.isArray(body.providers) || body.providers.length > 16) throw ApiError.badRequest('Expected schemaVersion 3 and at most 16 providers')
  const ids = new Set<string>()
  const oldConfig = getMediaGenConfig()
  const oldProviders = new Map(oldConfig.providers.map(provider => [provider.id, provider]))
  const oldKeys = readKeys()
  const nextKeys: Record<string, string> = {}
  const providers: Provider[] = []
  for (const value of body.providers) {
    const parsed = parseProvider(value, ids)
    const action = parsed.apiKey as MediaGenApiKeyUpdate | undefined
    let credentialRef = parsed.credentialRef
    if (action?.action === 'replace') {
      if (!action.value || Buffer.byteLength(action.value, 'utf8') > MAX_API_KEY_BYTES) throw ApiError.badRequest('API key exceeds 16 KiB UTF-8 limit')
      nextKeys[parsed.id] = action.value
      credentialRef = undefined
    } else if (action?.action === 'reference') {
      await resolveSavedProvider(action.credentialRef, parsed.baseUrl)
      credentialRef = action.credentialRef
    } else if (action?.action === 'keep' || action === undefined) {
      if (credentialRef) await resolveSavedProvider(credentialRef, parsed.baseUrl)
      else if (oldKeys[parsed.id]) {
        const oldProvider = oldProviders.get(parsed.id)
        if (!oldProvider || new URL(oldProvider.baseUrl).origin !== new URL(parsed.baseUrl).origin) throw ApiError.badRequest('Provider origin changed; re-enter the API key')
        nextKeys[parsed.id] = oldKeys[parsed.id]
      }
    } else if (action?.action === 'clear') credentialRef = undefined
    else throw ApiError.badRequest('Invalid API key action')
    const { apiKey: _, ...provider } = parsed
    providers.push({ ...provider, credentialRef })
  }
  const serialized = JSON.stringify(nextKeys)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_API_KEYS_BYTES) throw ApiError.badRequest('Serialized API keys exceed 256 KiB UTF-8 limit')
  const storage = getSecureStorage()
  const existing = storage.read() ?? {}
  const pluginSecrets = { ...existing.pluginSecrets, [MEDIA_GEN_PLUGIN_ID]: { ...existing.pluginSecrets?.[MEDIA_GEN_PLUGIN_ID], mediaProviderApiKeys: serialized } }
  if (!storage.update({ ...existing, pluginSecrets }).success) throw new Error('Failed to save media-gen API keys')
  try { savePluginOptions(MEDIA_GEN_PLUGIN_ID, { mediaProviderConfig: JSON.stringify({ schemaVersion: 3, providers }) }, { mediaProviderConfig: { type: 'string' } }) }
  catch (error) {
    if (!storage.update(existing).success) throw new AggregateError([error], 'Failed to save media-gen config and restore secure storage')
    throw error
  }
  return getMediaGenConfig()
}

export function getMediaGenConfig(): MediaGenConfig {
  const settings = getSettings_DEPRECATED()
  const options = settings.pluginConfigs?.[MEDIA_GEN_PLUGIN_ID]?.options as Record<string, unknown> | undefined
  let providers: Provider[]
  if (typeof options?.mediaProviderConfig === 'string') {
    let raw: unknown
    try { raw = JSON.parse(options.mediaProviderConfig) } catch { throw ApiError.internal('Stored media-gen configuration is invalid JSON') }
    if (!raw || typeof raw !== 'object' || ![2, 3].includes((raw as { schemaVersion?: number }).schemaVersion ?? 0) || !Array.isArray((raw as { providers?: unknown }).providers) || (raw as { providers: unknown[] }).providers.length > 16) throw ApiError.internal('Stored media-gen configuration is invalid')
    try {
      const ids = new Set<string>()
      providers = (raw as { providers: unknown[] }).providers.map(value => parseProvider(value, ids, true))
    } catch { throw ApiError.internal('Stored media-gen configuration is invalid') }
  } else providers = migrateLegacy(settings)
  const keys = readKeys()
  return { schemaVersion: 3, providers: providers.map(provider => ({ ...provider, models: provider.models ?? {}, apiKeyConfigured: Boolean(keys[provider.id] || provider.credentialRef) })) }
}

function migrateLegacy(settings: ReturnType<typeof getSettings_DEPRECATED>): Provider[] {
  const providers: Provider[] = []
  const migratedKeys: Record<string, string> = {}
  const storage = getSecureStorage()
  const originalSecrets = structuredClone(storage.read() ?? {})
  const originalMediaProviderConfig = (settings.pluginConfigs?.[MEDIA_GEN_PLUGIN_ID]?.options as Record<string, unknown> | undefined)?.mediaProviderConfig
  for (const legacyId of LEGACY_PLUGIN_IDS) {
    const options = settings.pluginConfigs?.[legacyId]?.options as Record<string, unknown> | undefined
    const secrets = originalSecrets.pluginSecrets?.[legacyId] ?? {}
    for (let slot = 1; slot <= 3; slot++) {
      const name = options?.[`PROVIDER_${slot}_NAME`]
      const baseUrl = options?.[`PROVIDER_${slot}_BASE_URL`]
      if (typeof name !== 'string' || !name || typeof baseUrl !== 'string' || !baseUrl) continue
      const model = options?.[`PROVIDER_${slot}_MODEL`]
      const id = `legacy-${providers.length + 1}`
      providers.push({ id, name, enabled: true, apiFormat: 'openai_compatible', baseUrl: parseBaseUrl(baseUrl), models: typeof model === 'string' && model ? { imageGeneration: model } : {} })
      const key = secrets[`PROVIDER_${slot}_API_KEY`]
      if (typeof key === 'string' && key) migratedKeys[id] = key
    }
  }
  if (!providers.length) return []
  const nextSecrets = structuredClone(originalSecrets)
  const serialized = JSON.stringify(migratedKeys)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_API_KEYS_BYTES) throw ApiError.badRequest('Serialized API keys exceed 256 KiB UTF-8 limit')
  nextSecrets.pluginSecrets = { ...nextSecrets.pluginSecrets, [MEDIA_GEN_PLUGIN_ID]: { ...nextSecrets.pluginSecrets?.[MEDIA_GEN_PLUGIN_ID], mediaProviderApiKeys: serialized } }
  if (!storage.update(nextSecrets).success) throw new Error('Failed to save migrated media-gen API keys')
  try { savePluginOptions(MEDIA_GEN_PLUGIN_ID, { mediaProviderConfig: JSON.stringify({ schemaVersion: 3, providers }) }, { mediaProviderConfig: { type: 'string' } }) }
  catch (error) {
    if (!storage.update(originalSecrets).success) throw new AggregateError([error], 'Failed to migrate media-gen config and restore secure storage')
    throw error
  }
  const cleaned = structuredClone(storage.read() ?? {})
  for (const legacyId of LEGACY_PLUGIN_IDS) for (let slot = 1; slot <= 3; slot++) delete cleaned.pluginSecrets?.[legacyId]?.[`PROVIDER_${slot}_API_KEY`]
  if (!storage.update(cleaned).success) {
    const migrationError = new Error('Failed to clean legacy media-gen secrets')
    const rollbackErrors: unknown[] = []
    if (!storage.update(originalSecrets).success) rollbackErrors.push(new Error('Failed to restore secure storage'))
    try { savePluginOptions(MEDIA_GEN_PLUGIN_ID, { mediaProviderConfig: originalMediaProviderConfig }, { mediaProviderConfig: { type: 'string' } }) } catch (error) { rollbackErrors.push(error) }
    if (rollbackErrors.length) throw new AggregateError([migrationError, ...rollbackErrors], 'Failed to clean legacy media-gen secrets and fully roll back migration')
    throw new Error('Failed to clean legacy media-gen secrets; migration was rolled back')
  }
  return providers
}
