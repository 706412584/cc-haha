import { api } from './client'
import type {
  MarketFileContent,
  MarketInstalledFilter,
  MarketListResponse,
  MarketScope,
  MarketSecurityFilter,
  MarketSource,
  MarketSourceFilter,
  NormalizedSkill,
  NormalizedSkillDetail,
  SourceStatusInfo,
} from '../types/market'

export type MarketListParams = {
  scope?: MarketScope
  /** Catalog category key; ignored by the server in `market` scope. */
  category?: string
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
    if (params.scope) search.set('scope', params.scope)
    if (params.category && params.category !== 'all') search.set('category', params.category)
    if (params.q) search.set('q', params.q)
    if (params.source && params.source !== 'all') search.set('source', params.source)
    if (params.security && params.security !== 'all') search.set('security', params.security)
    if (params.installed && params.installed !== 'all') search.set('installed', params.installed)
    if (params.cursor) search.set('cursor', params.cursor)
    if (params.limit) search.set('limit', String(params.limit))
    const query = search.toString()
    return api.get<MarketListResponse>(`/api/market/skills${query ? `?${query}` : ''}`, { timeout: 30_000 })
  },

  /**
   * `owner` pins a ClawHub read to one publisher: ClawHub slugs are not unique,
   * so the slug alone can resolve to a different skill than the card showed.
   */
  detail: (source: MarketSource, slug: string, options: { owner?: string } = {}) =>
    api.get<{ skill: NormalizedSkillDetail; sourceStatus: SourceStatusInfo }>(
      `/api/market/skills/${source}/${encodeURIComponent(slug)}${
        options.owner ? `?owner=${encodeURIComponent(options.owner)}` : ''
      }`,
      { timeout: 30_000 },
    ),

  fileContent: (source: MarketSource, slug: string, path: string, owner?: string) =>
    api.get<{ file: MarketFileContent }>(
      `/api/market/skills/${source}/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}${
        owner ? `&owner=${encodeURIComponent(owner)}` : ''
      }`,
      { timeout: 30_000 },
    ),

  install: (id: string, owner?: string) =>
    api.post<{ ok: boolean; installedPath: string; skill: NormalizedSkill }>(
      '/api/market/install',
      owner ? { id, owner } : { id },
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
