import { api } from './client'
import type {
  AddMarketplaceResponse,
  CatalogPlugin,
  KnownLanguageServersResponse,
  PluginDetail,
  PluginListResponse,
  PluginPrerequisitesResponse,
  PluginReloadSummary,
  PluginSessionReloadSummary,
  PluginScope,
} from '../types/plugin'

export type MediaGenModelType = 'imageGeneration' | 'imageEditing' | 'videoGeneration' | 'videoEditing' | 'videoExtension'
export type MediaGenCredentialRef = { kind: 'saved_provider'; providerId: string }
export type MediaGenProvider = { id: string; name: string; enabled: boolean; apiFormat: 'openai_compatible'; baseUrl: string; models: Partial<Record<MediaGenModelType, string>>; apiKeyConfigured: boolean; credentialRef?: MediaGenCredentialRef }
export type MediaGenConfig = { schemaVersion: 3; providers: MediaGenProvider[] }
export type MediaGenApiKeyUpdate = { action: 'keep' } | { action: 'replace'; value: string } | { action: 'clear' } | { action: 'reference'; credentialRef: MediaGenCredentialRef }
export type MediaGenProviderChoice = { id: string; name: string; baseUrl: string; credentialConfigured: boolean; compatible: boolean }
export type MediaGenProviderUpdate = Omit<MediaGenProvider, 'apiKeyConfigured'> & { apiKey: MediaGenApiKeyUpdate }
export type MediaGenFetchModelsRequest = Pick<MediaGenProvider, 'baseUrl' | 'apiFormat'> & { providerId: string; apiKey: MediaGenApiKeyUpdate }
export type MediaGenModelsPayload = unknown

type PluginActionPayload = {
  id: string
  scope?: PluginScope
  keepData?: boolean
}

export const pluginsApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<PluginListResponse>(`/api/plugins${query}`)
  },

  detail: (id: string, cwd?: string) => {
    const query = new URLSearchParams({ id })
    if (cwd) query.set('cwd', cwd)
    return api.get<{ detail: PluginDetail }>(`/api/plugins/detail?${query.toString()}`)
  },

  prerequisites: (id: string, cwd?: string) => {
    const query = new URLSearchParams({ id })
    if (cwd) query.set('cwd', cwd)
    return api.get<PluginPrerequisitesResponse>(
      `/api/plugins/prerequisites?${query.toString()}`,
      { timeout: 15_000 },
    )
  },

  enable: (payload: PluginActionPayload) =>
    api.post<{ ok: true; message: string }>('/api/plugins/enable', payload),

  disable: (payload: PluginActionPayload) =>
    api.post<{ ok: true; message: string }>('/api/plugins/disable', payload),

  update: (payload: PluginActionPayload) =>
    api.post<{ ok: true; message: string }>('/api/plugins/update', payload),

  uninstall: (payload: PluginActionPayload) =>
    api.post<{ ok: true; message: string }>('/api/plugins/uninstall', payload),

  reload: (cwd?: string, sessionId?: string) => {
    const query = new URLSearchParams()
    if (cwd) query.set('cwd', cwd)
    if (sessionId) query.set('sessionId', sessionId)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return api.post<{
      ok: true
      summary: PluginReloadSummary
      session?: PluginSessionReloadSummary
    }>(
      `/api/plugins/reload${suffix}`,
      undefined,
      { timeout: 120_000 },
    )
  },

  catalog: () =>
    api.get<{ catalog: CatalogPlugin[] }>(`/api/plugins/catalog`),

  installCatalog: (payload: { id: string; marketplace: string }) =>
    api.post<{ ok: true; message: string; marketplaceAdded: boolean }>(
      `/api/plugins/install`,
      payload,
      { timeout: 120_000 },
    ),

  addMarketplace: (input: string) =>
    api.post<AddMarketplaceResponse>(
      `/api/plugins/marketplace`,
      { input },
      { timeout: 120_000 },
    ),

  languageServers: (refresh?: boolean) =>
    api.get<KnownLanguageServersResponse>(
      `/api/plugins/language-servers${refresh ? '?refresh=1' : ''}`,
      { timeout: 15_000 },
    ),

  getOptions: (id: string) => {
    const query = new URLSearchParams({ id })
    return api.get<{
      pluginId: string
      schema: Record<string, { type: string; title?: string; description?: string; required?: boolean; sensitive?: boolean; default?: unknown }>
      values: Record<string, unknown>
    }>(`/api/plugins/options?${query.toString()}`)
  },

  saveOptions: (id: string, values: Record<string, unknown>) =>
    api.post<{ ok: true; pluginId: string }>('/api/plugins/options', { id, values }),

  getMediaGenConfig: () => api.get<MediaGenConfig>('/api/plugins/media-gen/config'),
  saveMediaGenConfig: (providers: MediaGenProviderUpdate[]) =>
    api.put<MediaGenConfig>('/api/plugins/media-gen/config', { schemaVersion: 3, providers }),
  getMediaGenProviderChoices: () => api.get<{ providers: MediaGenProviderChoice[] }>('/api/plugins/media-gen/provider-choices'),
  fetchMediaGenModels: (input: MediaGenFetchModelsRequest) =>
    api.post<MediaGenModelsPayload>('/api/plugins/media-gen/fetch-models', input),
}
