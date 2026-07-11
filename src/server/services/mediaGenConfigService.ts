import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { savePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js'
import { ApiError } from '../middleware/errorHandler.js'

export const MEDIA_GEN_PLUGIN_ID = 'media-gen@cc-haha-builtin'
const LEGACY_PLUGIN_IDS = ['image-gen@cc-haha-builtin', MEDIA_GEN_PLUGIN_ID] as const
const MODEL_TYPES = ['imageGeneration', 'imageEditing', 'videoGeneration', 'videoEditing', 'videoExtension'] as const
const MAX_NAME_LENGTH = 128
const MAX_URL_LENGTH = 2048
const MAX_MODEL_LENGTH = 256
const MAX_API_KEY_BYTES = 16 * 1024
const MAX_SERIALIZED_API_KEYS_BYTES = 256 * 1024

type ModelType = (typeof MODEL_TYPES)[number]
type Models = Partial<Record<ModelType, string>>
type Provider = {
  id: string
  name: string
  enabled: boolean
  apiFormat: 'openai_compatible'
  baseUrl: string
  models?: Models
}
type MediaGenConfig = {
  schemaVersion: 2
  providers: Array<Provider & { models: Models; apiKeyConfigured: boolean }>
}

function readKeys(): Record<string, string> {
  const value = getSecureStorage().read()?.pluginSecrets?.[MEDIA_GEN_PLUGIN_ID]?.mediaProviderApiKeys
  if (typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

function parseBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) throw ApiError.badRequest('Invalid provider base URL')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw ApiError.badRequest('Invalid provider base URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw ApiError.badRequest('Provider base URL must use http or https')
  return value
}

function parseProvider(value: unknown, ids: Set<string>, defaultEnabled = false): Provider & { apiKey?: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw ApiError.badRequest('Invalid provider')
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.id) || ids.has(input.id)) throw ApiError.badRequest('Provider IDs must be stable and unique')
  ids.add(input.id)
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > MAX_NAME_LENGTH) throw ApiError.badRequest('Invalid provider name')
  if (input.enabled === undefined && !defaultEnabled || input.enabled !== undefined && typeof input.enabled !== 'boolean') throw ApiError.badRequest('Provider enabled must be boolean')
  if (input.apiFormat !== 'openai_compatible') throw ApiError.badRequest('Unsupported provider API format')
  if (input.models !== undefined && (!input.models || typeof input.models !== 'object' || Array.isArray(input.models))) throw ApiError.badRequest('Invalid provider models')
  const rawModels = (input.models ?? {}) as Record<string, unknown>
  if (Object.keys(rawModels).some(key => !MODEL_TYPES.includes(key as ModelType)) || Object.values(rawModels).some(model => typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_LENGTH)) throw ApiError.badRequest('Invalid provider models')
  return { id: input.id, name: input.name, enabled: input.enabled === undefined ? true : input.enabled, apiFormat: 'openai_compatible', baseUrl: parseBaseUrl(input.baseUrl), models: rawModels as Models, apiKey: input.apiKey }
}

function writeSecrets(data: ReturnType<ReturnType<typeof getSecureStorage>['read']>): void {
  if (!getSecureStorage().update(data ?? {}).success) throw new Error('Secure storage update failed')
}

export function saveMediaGenConfig(body: Record<string, unknown>): MediaGenConfig {
  if (body.schemaVersion !== 2 || !Array.isArray(body.providers) || body.providers.length > 16) throw ApiError.badRequest('Expected schemaVersion 2 and at most 16 providers')
  const ids = new Set<string>()
  const oldKeys = readKeys()
  const nextKeys: Record<string, string> = {}
  const providers = body.providers.map(value => {
    const provider = parseProvider(value, ids)
    const apiKey = provider.apiKey as { action?: unknown; value?: unknown } | undefined
    if (apiKey?.action === 'replace' && typeof apiKey.value === 'string' && apiKey.value.length > 0) {
      if (Buffer.byteLength(apiKey.value, 'utf8') > MAX_API_KEY_BYTES) throw ApiError.badRequest('API key exceeds 16 KiB UTF-8 limit')
      nextKeys[provider.id] = apiKey.value
    }
    else if (apiKey?.action === 'keep' || apiKey === undefined) { if (oldKeys[provider.id]) nextKeys[provider.id] = oldKeys[provider.id] }
    else if (apiKey?.action !== 'clear') throw ApiError.badRequest('Invalid API key action')
    const { apiKey: _, ...saved } = provider
    return saved
  })

  const serializedKeys = JSON.stringify(nextKeys)
  if (Buffer.byteLength(serializedKeys, 'utf8') > MAX_SERIALIZED_API_KEYS_BYTES) throw ApiError.badRequest('Serialized API keys exceed 256 KiB UTF-8 limit')
  const storage = getSecureStorage()
  const existing = storage.read() ?? {}
  const pluginSecrets = { ...existing.pluginSecrets, [MEDIA_GEN_PLUGIN_ID]: { ...existing.pluginSecrets?.[MEDIA_GEN_PLUGIN_ID], mediaProviderApiKeys: serializedKeys } }
  if (!storage.update({ ...existing, pluginSecrets }).success) throw new Error('Failed to save media-gen API keys')
  try {
    savePluginOptions(MEDIA_GEN_PLUGIN_ID, { mediaProviderConfig: JSON.stringify({ schemaVersion: 2, providers }) }, { mediaProviderConfig: { type: 'string' } })
  } catch (error) {
    const rollback = storage.update(existing)
    if (!rollback.success) throw new AggregateError([error], 'Failed to save media-gen config and restore secure storage')
    throw error
  }
  return getMediaGenConfig()
}

export function getMediaGenProviderCredentials(providerId: string): { baseUrl: string; apiKey: string; apiFormat: 'openai_chat' } {
  const provider = getMediaGenConfig().providers.find(item => item.id === providerId)
  const apiKey = readKeys()[providerId]
  if (!provider) throw ApiError.badRequest('Unknown media-gen provider')
  if (!apiKey) throw ApiError.badRequest('Provider API key is not configured')
  return { baseUrl: provider.baseUrl, apiKey, apiFormat: 'openai_chat' }
}

export function getMediaGenConfig(): MediaGenConfig {
  const settings = getSettings_DEPRECATED()
  const options = settings.pluginConfigs?.[MEDIA_GEN_PLUGIN_ID]?.options as Record<string, unknown> | undefined
  let providers: Provider[]
  if (typeof options?.mediaProviderConfig === 'string') {
    let raw: unknown
    try { raw = JSON.parse(options.mediaProviderConfig) } catch { throw ApiError.internal('Stored media-gen configuration is invalid JSON') }
    if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== 2 || !Array.isArray((raw as { providers?: unknown }).providers)) throw ApiError.internal('Stored media-gen configuration is invalid')
    const values = (raw as { providers: unknown[] }).providers
    if (values.length > 16) throw ApiError.internal('Stored media-gen configuration is invalid')
    try {
      const ids = new Set<string>()
      providers = values.map(value => parseProvider(value, ids, true))
    } catch {
      throw ApiError.internal('Stored media-gen configuration is invalid')
    }
  } else {
    providers = migrateLegacy(settings)
  }
  const keys = readKeys()
  return { schemaVersion: 2, providers: providers.map(provider => ({ ...provider, models: provider.models ?? {}, apiKeyConfigured: Boolean(keys[provider.id]) })) }
}

function migrateLegacy(settings: ReturnType<typeof getSettings_DEPRECATED>): Provider[] {
  const providers: Provider[] = []
  const migratedKeys: Record<string, string> = {}
  const storage = getSecureStorage()
  const originalSecrets = structuredClone(storage.read() ?? {})
  const originalMediaProviderConfig = (settings.pluginConfigs?.[MEDIA_GEN_PLUGIN_ID]?.options as Record<string, unknown> | undefined)?.mediaProviderConfig
  for (const legacyId of LEGACY_PLUGIN_IDS) {
    const legacyOptions = settings.pluginConfigs?.[legacyId]?.options as Record<string, unknown> | undefined
    const legacySecrets = originalSecrets.pluginSecrets?.[legacyId] ?? {}
    for (let slot = 1; slot <= 3; slot++) {
      const name = legacyOptions?.[`PROVIDER_${slot}_NAME`]
      const baseUrl = legacyOptions?.[`PROVIDER_${slot}_BASE_URL`]
      if (typeof name !== 'string' || !name || typeof baseUrl !== 'string' || !baseUrl) continue
      const model = legacyOptions?.[`PROVIDER_${slot}_MODEL`]
      const id = `legacy-${providers.length + 1}`
      providers.push({ id, name, enabled: true, apiFormat: 'openai_compatible', baseUrl: parseBaseUrl(baseUrl), models: typeof model === 'string' && model ? { imageGeneration: model } : {} })
      const key = legacySecrets[`PROVIDER_${slot}_API_KEY`]
      if (typeof key === 'string' && key) migratedKeys[id] = key
    }
  }
  if (providers.length === 0) return []
  saveMediaGenConfig({ schemaVersion: 2, providers: providers.map(provider => ({ ...provider, apiKey: migratedKeys[provider.id] ? { action: 'replace', value: migratedKeys[provider.id] } : { action: 'clear' } })) })
  const afterSave = storage.read() ?? {}
  const cleaned = structuredClone(afterSave)
  for (const legacyId of LEGACY_PLUGIN_IDS) for (let slot = 1; slot <= 3; slot++) delete cleaned.pluginSecrets?.[legacyId]?.[`PROVIDER_${slot}_API_KEY`]
  if (!storage.update(cleaned).success) {
    const migrationError = new Error('Failed to clean legacy media-gen secrets')
    const rollbackErrors: unknown[] = []
    if (!storage.update(originalSecrets).success) rollbackErrors.push(new Error('Failed to restore secure storage'))
    try {
      savePluginOptions(MEDIA_GEN_PLUGIN_ID, { mediaProviderConfig: originalMediaProviderConfig }, { mediaProviderConfig: { type: 'string' } })
    } catch (error) {
      rollbackErrors.push(error)
    }
    if (rollbackErrors.length > 0) throw new AggregateError([migrationError, ...rollbackErrors], 'Failed to clean legacy media-gen secrets and fully roll back migration')
    throw new Error('Failed to clean legacy media-gen secrets; migration was rolled back')
  }
  return providers
}
