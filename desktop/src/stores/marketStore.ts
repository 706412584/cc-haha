import { create } from 'zustand'
import { marketApi } from '../api/market'
import { ApiError } from '../api/client'
import type {
  MarketFileContent,
  MarketInstalledFilter,
  MarketSecurityFilter,
  MarketSource,
  MarketSourceFilter,
  NormalizedSkill,
  NormalizedSkillDetail,
  SourceStatusInfo,
} from '../types/market'

export type MarketInstallErrorKind = 'network' | 'checksum' | 'exists' | 'disk' | 'notInstallable' | 'generic'

export type MarketFilters = {
  source: MarketSourceFilter
  security: MarketSecurityFilter
  installed: MarketInstalledFilter
}

const PAGE_SIZE = 24
const SEARCH_DEBOUNCE_MS = 300

export function classifyInstallError(error: unknown): { kind: MarketInstallErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ApiError) {
    const code =
      error.body && typeof error.body === 'object' && 'error' in error.body
        ? String((error.body as { error?: unknown }).error)
        : ''
    if (code === 'MARKET_CHECKSUM_MISMATCH') return { kind: 'checksum', message }
    if (code === 'MARKET_ALREADY_INSTALLED' || code === 'MARKET_INSTALL_IN_PROGRESS') {
      return { kind: 'exists', message }
    }
    if (code === 'MARKET_NOT_INSTALLABLE') return { kind: 'notInstallable', message }
    if (code === 'MARKET_DISK_ERROR') return { kind: 'disk', message }
    if (code.startsWith('MARKET_UPSTREAM')) return { kind: 'network', message }
    return { kind: 'generic', message }
  }
  if (message.toLowerCase().includes('timed out') || message.toLowerCase().includes('fetch')) {
    return { kind: 'network', message }
  }
  return { kind: 'generic', message }
}

type MarketStore = {
  items: NormalizedSkill[]
  nextCursor: string | null
  sources: Partial<Record<MarketSource, SourceStatusInfo>>
  query: string
  filters: MarketFilters
  isLoading: boolean
  isLoadingMore: boolean
  error: string | null

  selectedId: string | null
  detail: NormalizedSkillDetail | null
  isDetailLoading: boolean
  detailError: string | null
  detailCache: Map<string, NormalizedSkillDetail>

  activeFilePath: string | null
  fileCache: Map<string, MarketFileContent>

  installingIds: Set<string>
  installError: { id: string; kind: MarketInstallErrorKind; message: string } | null

  fetchList: (options?: { reset?: boolean }) => Promise<void>
  loadMore: () => Promise<void>
  setQuery: (q: string) => void
  setFilter: <K extends keyof MarketFilters>(key: K, value: MarketFilters[K]) => void
  openDetail: (id: string) => Promise<void>
  refreshDetail: (id: string) => Promise<void>
  /** Fetch a file's content with session-level caching. Throws on failure. */
  fetchFileContent: (id: string, path: string) => Promise<MarketFileContent>
  install: (id: string) => Promise<boolean>
  uninstall: (id: string) => Promise<boolean>
  backToList: () => void
}

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let listRequestSeq = 0

function fileCacheKey(id: string, path: string): string {
  return `${id}:${path}`
}

/** Replace an item in place (list + detail) after install/uninstall state changes. */
function mergeSkillUpdate(state: MarketStore, updated: NormalizedSkill): Partial<MarketStore> {
  const items = state.items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
  const patch: Partial<MarketStore> = { items }
  if (state.detail && state.detail.id === updated.id) {
    const detail = {
      ...state.detail,
      installState: updated.installState,
      notInstallableReason: updated.notInstallableReason,
      installedInfo: updated.installedInfo,
    }
    patch.detail = detail
    const cache = new Map(state.detailCache)
    cache.set(updated.id, detail)
    patch.detailCache = cache
  } else {
    const cached = state.detailCache.get(updated.id)
    if (cached) {
      const cache = new Map(state.detailCache)
      cache.set(updated.id, {
        ...cached,
        installState: updated.installState,
        notInstallableReason: updated.notInstallableReason,
        installedInfo: updated.installedInfo,
      })
      patch.detailCache = cache
    }
  }
  return patch
}

export const useMarketStore = create<MarketStore>((set, get) => ({
  items: [],
  nextCursor: null,
  sources: {},
  query: '',
  filters: { source: 'all', security: 'all', installed: 'all' },
  isLoading: false,
  isLoadingMore: false,
  error: null,

  selectedId: null,
  detail: null,
  isDetailLoading: false,
  detailError: null,
  detailCache: new Map(),

  activeFilePath: null,
  fileCache: new Map(),

  installingIds: new Set(),
  installError: null,

  fetchList: async ({ reset = true } = {}) => {
    const seq = ++listRequestSeq
    const { query, filters } = get()
    set({ isLoading: true, error: null, ...(reset ? { items: [], nextCursor: null } : {}) })
    try {
      const result = await marketApi.list({
        q: query.trim() || undefined,
        source: filters.source,
        security: filters.security,
        installed: filters.installed,
        limit: PAGE_SIZE,
      })
      if (seq !== listRequestSeq) return
      set({
        items: result.items,
        nextCursor: result.nextCursor,
        sources: result.sources,
        isLoading: false,
      })
    } catch (err) {
      if (seq !== listRequestSeq) return
      set({ error: err instanceof Error ? err.message : String(err), isLoading: false })
    }
  },

  loadMore: async () => {
    const { nextCursor, isLoadingMore, isLoading, query, filters, items } = get()
    if (!nextCursor || isLoadingMore || isLoading) return
    const seq = listRequestSeq
    set({ isLoadingMore: true })
    try {
      const result = await marketApi.list({
        q: query.trim() || undefined,
        source: filters.source,
        security: filters.security,
        installed: filters.installed,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      })
      if (seq !== listRequestSeq) return
      const seen = new Set(items.map((i) => i.id))
      const appended = result.items.filter((i) => !seen.has(i.id))
      set({
        items: [...items, ...appended],
        nextCursor: result.nextCursor,
        sources: result.sources,
        isLoadingMore: false,
      })
    } catch (err) {
      if (seq !== listRequestSeq) return
      set({ error: err instanceof Error ? err.message : String(err), isLoadingMore: false })
    }
  },

  setQuery: (q) => {
    set({ query: q })
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
    searchDebounceTimer = setTimeout(() => {
      void get().fetchList({ reset: true })
    }, SEARCH_DEBOUNCE_MS)
  },

  setFilter: (key, value) => {
    set({ filters: { ...get().filters, [key]: value } })
    void get().fetchList({ reset: true })
  },

  openDetail: async (id) => {
    const { detailCache } = get()
    const cached = detailCache.get(id)
    set({ selectedId: id, detailError: null, activeFilePath: null, installError: null })
    if (cached) {
      set({ detail: cached, isDetailLoading: false })
      return
    }
    set({ detail: null, isDetailLoading: true })
    await get().refreshDetail(id)
  },

  refreshDetail: async (id) => {
    const [source, ...slugParts] = id.split(':')
    const slug = slugParts.join(':')
    set({ isDetailLoading: get().detail?.id !== id, detailError: null })
    try {
      const { skill } = await marketApi.detail(source as MarketSource, slug)
      if (get().selectedId !== id) return
      const cache = new Map(get().detailCache)
      cache.set(id, skill)
      set({ detail: skill, detailCache: cache, isDetailLoading: false, detailError: null })
    } catch (err) {
      if (get().selectedId !== id) return
      set({
        detailError: err instanceof Error ? err.message : String(err),
        isDetailLoading: false,
      })
    }
  },

  fetchFileContent: async (id, path) => {
    const key = fileCacheKey(id, path)
    const cached = get().fileCache.get(key)
    if (cached) return cached
    const [source, ...slugParts] = id.split(':')
    const slug = slugParts.join(':')
    const { file } = await marketApi.fileContent(source as MarketSource, slug, path)
    const cache = new Map(get().fileCache)
    cache.set(key, file)
    set({ fileCache: cache })
    return file
  },

  install: async (id) => {
    const { installingIds } = get()
    if (installingIds.has(id)) return false
    set({ installingIds: new Set(installingIds).add(id), installError: null })
    try {
      const result = await marketApi.install(id)
      const state = get()
      const next = new Set(state.installingIds)
      next.delete(id)
      set({ installingIds: next, ...mergeSkillUpdate(state, result.skill) })
      return true
    } catch (err) {
      const state = get()
      const next = new Set(state.installingIds)
      next.delete(id)
      const classified = classifyInstallError(err)
      set({ installingIds: next, installError: { id, ...classified } })
      return false
    }
  },

  uninstall: async (id) => {
    const { installingIds } = get()
    if (installingIds.has(id)) return false
    set({ installingIds: new Set(installingIds).add(id), installError: null })
    try {
      const result = await marketApi.uninstall(id)
      const state = get()
      const next = new Set(state.installingIds)
      next.delete(id)
      if (result.skill) {
        set({ installingIds: next, ...mergeSkillUpdate(state, result.skill) })
      } else {
        // Upstream lookup failed after removal — flip local state manually.
        const fallback: Partial<NormalizedSkill> = {
          installState: 'installable',
          installedInfo: undefined,
          notInstallableReason: undefined,
        }
        const current = state.items.find((i) => i.id === id)
        set({
          installingIds: next,
          ...mergeSkillUpdate(state, { ...(current ?? ({ id } as NormalizedSkill)), ...fallback } as NormalizedSkill),
        })
      }
      return true
    } catch (err) {
      const state = get()
      const next = new Set(state.installingIds)
      next.delete(id)
      const classified = classifyInstallError(err)
      set({ installingIds: next, installError: { id, ...classified } })
      return false
    }
  },

  backToList: () => {
    set({ selectedId: null, detail: null, detailError: null, activeFilePath: null, installError: null })
  },
}))
