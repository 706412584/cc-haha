import { api } from './client'
import type {
  MarketFileContent,
  MarketInstalledFilter,
  MarketListResponse,
  MarketSecurityFilter,
  MarketSource,
  MarketSourceFilter,
  NormalizedSkill,
  NormalizedSkillDetail,
  SourceStatusInfo,
} from '../types/market'

export type MarketListParams = {
  q?: string
  source?: MarketSourceFilter
  security?: MarketSecurityFilter
  installed?: MarketInstalledFilter
  cursor?: string
  limit?: number
}

export const marketApi = {
  list: (params: MarketListParams = {}) => {
    const search = new URLSearchParams()
    if (params.q) search.set('q', params.q)
    if (params.source && params.source !== 'all') search.set('source', params.source)
    if (params.security && params.security !== 'all') search.set('security', params.security)
    if (params.installed && params.installed !== 'all') search.set('installed', params.installed)
    if (params.cursor) search.set('cursor', params.cursor)
    if (params.limit) search.set('limit', String(params.limit))
    const query = search.toString()
    return api.get<MarketListResponse>(`/api/market/skills${query ? `?${query}` : ''}`, { timeout: 30_000 })
  },

  detail: (source: MarketSource, slug: string) =>
    api.get<{ skill: NormalizedSkillDetail; sourceStatus: SourceStatusInfo }>(
      `/api/market/skills/${source}/${encodeURIComponent(slug)}`,
      { timeout: 30_000 },
    ),

  fileContent: (source: MarketSource, slug: string, path: string) =>
    api.get<{ file: MarketFileContent }>(
      `/api/market/skills/${source}/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`,
      { timeout: 30_000 },
    ),

  install: (id: string) =>
    api.post<{ ok: boolean; installedPath: string; skill: NormalizedSkill }>(
      '/api/market/install',
      { id },
      { timeout: 120_000 },
    ),

  uninstall: (id: string) =>
    api.post<{ ok: boolean; removedPath: string; skill: NormalizedSkill | null }>(
      '/api/market/uninstall',
      { id },
      { timeout: 30_000 },
    ),

  status: () =>
    api.get<{ sources: Record<MarketSource, SourceStatusInfo> }>('/api/market/status'),
}
