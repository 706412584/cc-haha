import { create } from 'zustand'
import { marketApi } from '../api/market'
import { ApiError } from '../api/client'
import type {
  MarketCategory,
  MarketFileContent,
  MarketInstalledFilter,
  MarketScope,
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
  /**
   * `catalog` is the curated snapshot the server ships (no network); `market`
   * searches both registries live. The home page opens on the catalog, and the
   * live search is only ever entered on purpose.
   */
  scope: MarketScope
  /** Catalog category key, or `'all'`. Only sent in catalog scope. */
  category: string
  /** Catalog scope: matches across all pages. `null` when the server sent none. */
  total: number | null
  /** Catalog category bar, kept across scope switches so it never flickers. */
  categories: MarketCategory[]
  catalogGeneratedAt: number | null
  /** What the search box holds right now. */
  query: string
  /**
   * The query a live search was last *submitted* with. Live search runs on
   * Enter only, so the box may already hold something else — and the next
   * page must keep paging the search the reader actually asked for.
   */
  liveQuery: string
  filters: MarketFilters
  isLoading: boolean
  isLoadingMore: boolean
  error: string | null
  /**
   * Kept apart from `error`: the list is scrolled by an observer now, so a
   * failed page must not blank the catalogue behind a full-region error, and
   * must not leave the observer re-firing into the same failure forever. The
   * next page is only retried when the user asks for it.
   */
  loadMoreError: string | null

  selectedId: string | null
  /** ClawHub owner the open detail is pinned to; refreshes and file reads reuse it. */
  selectedOwner: string | null
  detail: NormalizedSkillDetail | null
  isDetailLoading: boolean
  detailError: string | null
  /** Keyed by `marketSkillKey(id, owner)`, never by bare id for a ClawHub skill. */
  detailCache: Map<string, NormalizedSkillDetail>

  activeFilePath: string | null
  fileCache: Map<string, MarketFileContent>

  installingIds: Set<string>
  installError: { id: string; kind: MarketInstallErrorKind; message: string } | null

  fetchList: (options?: { reset?: boolean }) => Promise<void>
  loadMore: () => Promise<void>
  /**
   * Catalog scope searches as the reader types (debounced, local server only).
   * Live scope never does: each keystroke would be two upstream requests.
   * An emptied box always returns to the catalog at once.
   */
  setQuery: (q: string) => void
  /** Enter in the search box: flushes the catalog debounce, or runs the live search. */
  submitQuery: () => void
  /** The explicit "search all markets for q" action. */
  searchAllMarkets: () => void
  backToCatalog: () => void
  setCategory: (category: string) => void
  setFilter: <K extends keyof MarketFilters>(key: K, value: MarketFilters[K]) => void
  /** `owner` comes from the clicked card (see `marketOwnerOf`). */
  openDetail: (id: string, owner?: string) => Promise<void>
  /** Re-reads the open detail, pinned to the owner it was opened with. */
  refreshDetail: (id: string) => Promise<void>
  /** Fetch a file's content with session-level caching. Throws on failure. */
  fetchFileContent: (id: string, path: string, owner?: string) => Promise<MarketFileContent>
  install: (id: string, owner?: string) => Promise<boolean>
  uninstall: (id: string) => Promise<boolean>
  backToList: () => void
}

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let listRequestSeq = 0
let detailRequestSeq = 0

function listParams(state: MarketStore) {
  const catalog = state.scope === 'catalog'
  const q = (catalog ? state.query : state.liveQuery).trim()
  return {
    scope: state.scope,
    category: catalog ? state.category : undefined,
    q: q || undefined,
    source: state.filters.source,
    security: state.filters.security,
    installed: state.filters.installed,
    limit: PAGE_SIZE,
  }
}

function cancelSearchDebounce() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  searchDebounceTimer = null
}

/**
 * The publisher a ClawHub read has to be pinned to. ClawHub slugs are not
 * unique — two owners can both publish `pdf` — so `id` alone can open, preview
 * or install a different skill than the card the reader clicked. SkillHub ids
 * are unique and never carry one.
 */
export function marketOwnerOf(skill: Pick<NormalizedSkill, 'source' | 'author'> | null | undefined): string | undefined {
  if (!skill || skill.source !== 'clawhub') return undefined
  return skill.author?.handle || undefined
}

/** Cache identity of one skill: the id, narrowed by owner when there is one. */
export function marketSkillKey(id: string, owner?: string | null): string {
  return owner ? `${id}@${owner}` : id
}

function fileCacheKey(id: string, owner: string | null | undefined, path: string): string {
  return `${marketSkillKey(id, owner)}:${path}`
}

/** Same skill: same id, and the same owner whenever both sides name one. */
function sameSkill(a: NormalizedSkill, b: NormalizedSkill): boolean {
  if (a.id !== b.id) return false
  const ownerA = marketOwnerOf(a)
  const ownerB = marketOwnerOf(b)
  return !ownerA || !ownerB || ownerA === ownerB
}

/** Replace an item in place (list + detail) after install/uninstall state changes. */
function mergeSkillUpdate(state: MarketStore, updated: NormalizedSkill): Partial<MarketStore> {
  const installPatch = {
    installState: updated.installState,
    notInstallableReason: updated.notInstallableReason,
    installedInfo: updated.installedInfo,
  }
  const items = state.items
    .map((item) => (sameSkill(item, updated) ? { ...item, ...updated } : item))
    .filter((item) => {
      if (state.filters.installed === 'installed') return item.installState === 'installed'
      if (state.filters.installed === 'installable') return item.installState !== 'installed'
      return true
    })
  const patch: Partial<MarketStore> = { items }
  if (state.detail && sameSkill(state.detail, updated)) {
    patch.detail = { ...state.detail, ...installPatch }
  }
  let cache: Map<string, NormalizedSkillDetail> | null = null
  for (const [key, cached] of state.detailCache) {
    if (!sameSkill(cached, updated)) continue
    cache ??= new Map(state.detailCache)
    cache.set(key, { ...cached, ...installPatch })
  }
  if (cache) patch.detailCache = cache
  return patch
}

export const useMarketStore = create<MarketStore>((set, get) => ({
  items: [],
  nextCursor: null,
  sources: {},
  scope: 'catalog',
  category: 'all',
  total: null,
  categories: [],
  catalogGeneratedAt: null,
  query: '',
  liveQuery: '',
  filters: { source: 'all', security: 'all', installed: 'all' },
  isLoading: false,
  isLoadingMore: false,
  error: null,
  loadMoreError: null,

  selectedId: null,
  selectedOwner: null,
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
    const params = listParams(get())
    set({
      isLoading: true,
      isLoadingMore: false,
      error: null,
      loadMoreError: null,
      ...(reset ? { items: [], nextCursor: null } : {}),
    })
    try {
      const result = await marketApi.list(params)
      if (seq !== listRequestSeq) return
      set({
        items: result.items,
        nextCursor: result.nextCursor,
        sources: result.sources,
        total: result.total ?? null,
        // Live results carry no category list; keep the catalog's so going
        // back does not rebuild the chip row from nothing.
        ...(result.categories ? { categories: result.categories } : {}),
        ...(result.catalogGeneratedAt !== undefined ? { catalogGeneratedAt: result.catalogGeneratedAt } : {}),
        isLoading: false,
      })
    } catch (err) {
      if (seq !== listRequestSeq) return
      set({ error: err instanceof Error ? err.message : String(err), isLoading: false })
    }
  },

  loadMore: async () => {
    const { nextCursor, isLoadingMore, isLoading } = get()
    if (!nextCursor || isLoadingMore || isLoading) return
    const seq = listRequestSeq
    set({ isLoadingMore: true, loadMoreError: null })
    try {
      const result = await marketApi.list({ ...listParams(get()), cursor: nextCursor })
      if (seq !== listRequestSeq) return
      const currentItems = get().items
      const seen = new Set(currentItems.map((i) => i.id))
      const appended = result.items.filter((i) => !seen.has(i.id))
      set({
        items: [...currentItems, ...appended],
        nextCursor: result.nextCursor,
        sources: result.sources,
        isLoadingMore: false,
        loadMoreError: null,
      })
    } catch (err) {
      if (seq !== listRequestSeq) return
      set({ loadMoreError: err instanceof Error ? err.message : String(err), isLoadingMore: false })
    }
  },

  setQuery: (q) => {
    cancelSearchDebounce()
    if (q.trim() === '') {
      const wasEmpty = get().scope === 'catalog' && get().query.trim() === ''
      set({ query: q, scope: 'catalog', liveQuery: '' })
      if (!wasEmpty) void get().fetchList({ reset: true })
      return
    }
    set({ query: q })
    if (get().scope !== 'catalog') return
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null
      void get().fetchList({ reset: true })
    }, SEARCH_DEBOUNCE_MS)
  },

  submitQuery: () => {
    const { scope, query } = get()
    if (scope === 'catalog') {
      // Nothing pending means the list already reflects the box.
      if (!searchDebounceTimer) return
      cancelSearchDebounce()
      void get().fetchList({ reset: true })
      return
    }
    const q = query.trim()
    if (q === '') {
      get().backToCatalog()
      return
    }
    set({ liveQuery: q })
    void get().fetchList({ reset: true })
  },

  searchAllMarkets: () => {
    const q = get().query.trim()
    if (q === '') return
    cancelSearchDebounce()
    set({ scope: 'market', liveQuery: q })
    void get().fetchList({ reset: true })
  },

  backToCatalog: () => {
    cancelSearchDebounce()
    set({ scope: 'catalog', liveQuery: '' })
    void get().fetchList({ reset: true })
  },

  setCategory: (category) => {
    if (category === get().category) return
    set({ category })
    void get().fetchList({ reset: true })
  },

  setFilter: (key, value) => {
    set({ filters: { ...get().filters, [key]: value } })
    void get().fetchList({ reset: true })
  },

  openDetail: async (id, owner) => {
    const selectedOwner = owner || null
    const cached = get().detailCache.get(marketSkillKey(id, selectedOwner))
    set({ selectedId: id, selectedOwner, detailError: null, activeFilePath: null, installError: null })
    if (cached) {
      set({ detail: cached, isDetailLoading: false })
      return
    }
    set({ detail: null, isDetailLoading: true })
    await get().refreshDetail(id)
  },

  refreshDetail: async (id) => {
    const seq = ++detailRequestSeq
    const [source, ...slugParts] = id.split(':')
    const slug = slugParts.join(':')
    // Only the open detail has a known owner; a refresh of anything else is unpinned.
    const owner = get().selectedId === id ? get().selectedOwner : null
    const isCurrent = () =>
      seq === detailRequestSeq && get().selectedId === id && get().selectedOwner === owner
    set({ isDetailLoading: get().detail?.id !== id, detailError: null })
    try {
      const { skill } = await marketApi.detail(source as MarketSource, slug, owner ? { owner } : {})
      if (!isCurrent()) return
      const cache = new Map(get().detailCache)
      cache.set(marketSkillKey(id, owner), skill)
      set({ detail: skill, detailCache: cache, isDetailLoading: false, detailError: null })
    } catch (err) {
      if (!isCurrent()) return
      set({
        detailError: err instanceof Error ? err.message : String(err),
        isDetailLoading: false,
      })
    }
  },

  fetchFileContent: async (id, path, owner) => {
    const key = fileCacheKey(id, owner, path)
    const cached = get().fileCache.get(key)
    if (cached) return cached
    const [source, ...slugParts] = id.split(':')
    const slug = slugParts.join(':')
    const { file } = await marketApi.fileContent(source as MarketSource, slug, path, owner || undefined)
    const cache = new Map(get().fileCache)
    cache.set(key, file)
    set({ fileCache: cache })
    return file
  },

  install: async (id, owner) => {
    const { installingIds } = get()
    if (installingIds.has(id)) return false
    set({ installingIds: new Set(installingIds).add(id), installError: null })
    try {
      const result = await marketApi.install(id, owner || undefined)
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
    detailRequestSeq += 1
    set({
      selectedId: null,
      selectedOwner: null,
      detail: null,
      detailError: null,
      activeFilePath: null,
      installError: null,
    })
  },
}))
