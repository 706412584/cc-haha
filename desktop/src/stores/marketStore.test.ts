import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../api/market', () => ({
  marketApi: {
    list: vi.fn(),
    detail: vi.fn(),
    fileContent: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    status: vi.fn(),
  },
}))

import { marketApi } from '../api/market'
import { useMarketStore, classifyInstallError, marketOwnerOf, marketSkillKey } from './marketStore'
import { ApiError } from '../api/client'
import type { MarketListResponse, NormalizedSkill, NormalizedSkillDetail } from '../types/market'

const mockedApi = vi.mocked(marketApi)

function makeSkill(overrides: Partial<NormalizedSkill> = {}): NormalizedSkill {
  return {
    id: 'clawhub:demo',
    source: 'clawhub',
    slug: 'demo',
    name: 'Demo',
    summary: 'A demo skill',
    author: { handle: 'alice' },
    stats: { downloads: 10 },
    tags: [],
    securityStatus: 'unknown',
    installState: 'installable',
    ...overrides,
  }
}

function makeDetail(overrides: Partial<NormalizedSkillDetail> = {}): NormalizedSkillDetail {
  return {
    ...makeSkill(),
    description: '# Demo',
    files: [{ path: 'SKILL.md', size: 10, language: 'markdown', tooBig: false }],
    totalSize: 10,
    ...overrides,
  }
}

function listResponse(items: NormalizedSkill[], nextCursor: string | null = null): MarketListResponse {
  return {
    items,
    nextCursor,
    sources: {
      clawhub: { status: 'ok' },
      skillhub: { status: 'ok' },
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  useMarketStore.setState({
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
  })
})

describe('marketStore list', () => {
  it('fetches and stores items with source statuses', async () => {
    mockedApi.list.mockResolvedValue(listResponse([makeSkill()], 'cursor-1'))

    await useMarketStore.getState().fetchList({ reset: true })

    const state = useMarketStore.getState()
    expect(state.items).toHaveLength(1)
    expect(state.nextCursor).toBe('cursor-1')
    expect(state.sources.clawhub?.status).toBe('ok')
    expect(state.isLoading).toBe(false)
  })

  it('stores the error message when the request fails', async () => {
    mockedApi.list.mockRejectedValue(new Error('boom'))

    await useMarketStore.getState().fetchList({ reset: true })

    expect(useMarketStore.getState().error).toBe('boom')
    expect(useMarketStore.getState().isLoading).toBe(false)
  })

  it('appends deduplicated items on loadMore', async () => {
    const first = makeSkill({ id: 'clawhub:a', slug: 'a' })
    const dupe = makeSkill({ id: 'clawhub:a', slug: 'a' })
    const fresh = makeSkill({ id: 'skillhub:b', slug: 'b', source: 'skillhub' })
    useMarketStore.setState({ items: [first], nextCursor: 'next' })
    mockedApi.list.mockResolvedValue(listResponse([dupe, fresh], null))

    await useMarketStore.getState().loadMore()

    const state = useMarketStore.getState()
    expect(state.items.map((i) => i.id)).toEqual(['clawhub:a', 'skillhub:b'])
    expect(state.nextCursor).toBeNull()
  })

  it('does not loadMore without a cursor', async () => {
    await useMarketStore.getState().loadMore()
    expect(mockedApi.list).not.toHaveBeenCalled()
  })

  it('keeps a failed page out of the list-level error and off the catalogue', async () => {
    useMarketStore.setState({ items: [makeSkill()], nextCursor: 'next' })
    mockedApi.list.mockRejectedValue(new Error('page boom'))

    await useMarketStore.getState().loadMore()

    const state = useMarketStore.getState()
    // `error` blanks the catalogue behind a full-region failure panel; a page
    // that did not arrive must not do that to the pages that did.
    expect(state.loadMoreError).toBe('page boom')
    expect(state.error).toBeNull()
    expect(state.items).toHaveLength(1)
    expect(state.nextCursor).toBe('next')
    expect(state.isLoadingMore).toBe(false)
  })

  it('clears the load-more failure on a successful retry', async () => {
    useMarketStore.setState({ items: [makeSkill()], nextCursor: 'next', loadMoreError: 'page boom' })
    mockedApi.list.mockResolvedValue(listResponse([makeSkill({ id: 'skillhub:b', source: 'skillhub' })], null))

    await useMarketStore.getState().loadMore()

    expect(useMarketStore.getState().loadMoreError).toBeNull()
    expect(useMarketStore.getState().items).toHaveLength(2)
  })

  it('clears the load-more failure when the list is refetched', async () => {
    useMarketStore.setState({ items: [makeSkill()], nextCursor: 'next', loadMoreError: 'page boom' })
    mockedApi.list.mockResolvedValue(listResponse([makeSkill()]))

    await useMarketStore.getState().fetchList({ reset: true })

    expect(useMarketStore.getState().loadMoreError).toBeNull()
  })

  it('passes filters to the api', async () => {
    mockedApi.list.mockResolvedValue(listResponse([]))
    useMarketStore.setState({ filters: { source: 'skillhub', security: 'benign', installed: 'installed' } })

    await useMarketStore.getState().fetchList({ reset: true })

    expect(mockedApi.list).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'skillhub', security: 'benign', installed: 'installed' }),
    )
  })

  it('clears stale load-more state when a fresh list request starts', async () => {
    const stalePage = deferred<MarketListResponse>()
    useMarketStore.setState({ items: [makeSkill()], nextCursor: 'next' })
    mockedApi.list
      .mockImplementationOnce(() => stalePage.promise)
      .mockResolvedValueOnce(listResponse([makeSkill({ id: 'skillhub:fresh', source: 'skillhub' })]))

    const loadMorePromise = useMarketStore.getState().loadMore()
    await Promise.resolve()
    expect(useMarketStore.getState().isLoadingMore).toBe(true)

    const refreshPromise = useMarketStore.getState().fetchList({ reset: true })
    expect(useMarketStore.getState().isLoadingMore).toBe(false)
    await refreshPromise
    stalePage.resolve(listResponse([makeSkill({ id: 'clawhub:stale' })]))
    await loadMorePromise

    expect(useMarketStore.getState().isLoadingMore).toBe(false)
    expect(useMarketStore.getState().items.map((item) => item.id)).toEqual(['skillhub:fresh'])
  })

  it('does not let a late load-more response roll back a completed install', async () => {
    const page = deferred<MarketListResponse>()
    useMarketStore.setState({ items: [makeSkill()], nextCursor: 'next' })
    mockedApi.list.mockImplementationOnce(() => page.promise)
    mockedApi.install.mockResolvedValue({
      ok: true,
      installedPath: '/tmp/skills/demo',
      skill: makeSkill({ installState: 'installed', installedInfo: { dirName: 'demo' } }),
    })

    const loadMorePromise = useMarketStore.getState().loadMore()
    await useMarketStore.getState().install('clawhub:demo')
    page.resolve(listResponse([makeSkill(), makeSkill({ id: 'skillhub:new', source: 'skillhub' })]))
    await loadMorePromise

    expect(useMarketStore.getState().items.find((item) => item.id === 'clawhub:demo')?.installState).toBe('installed')
    expect(useMarketStore.getState().items.map((item) => item.id)).toContain('skillhub:new')
  })
})

describe('marketStore catalog and live scope', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockedApi.list.mockResolvedValue(listResponse([]))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens on the curated catalog and passes scope and category through', async () => {
    mockedApi.list.mockResolvedValue({
      ...listResponse([makeSkill({ curated: true, category: 'dev' })]),
      scope: 'catalog',
      total: 398,
      categories: [{ key: 'dev', name: '开发编程', nameEn: 'Development', count: 40 }],
      catalogGeneratedAt: 1_780_000_000_000,
    })

    await useMarketStore.getState().fetchList({ reset: true })

    expect(mockedApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'catalog', category: 'all' }))
    const state = useMarketStore.getState()
    expect(state.total).toBe(398)
    expect(state.categories.map((c) => c.key)).toEqual(['dev'])
    expect(state.catalogGeneratedAt).toBe(1_780_000_000_000)

    useMarketStore.getState().setCategory('dev')
    expect(mockedApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'catalog', category: 'dev' }))
  })

  it('debounces catalog search and flushes it on Enter', async () => {
    useMarketStore.getState().setQuery('pdf')
    expect(mockedApi.list).not.toHaveBeenCalled()

    useMarketStore.getState().submitQuery()
    expect(mockedApi.list).toHaveBeenCalledTimes(1)
    expect(mockedApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'catalog', q: 'pdf' }))

    // The flushed debounce must not fire a second time.
    await vi.advanceTimersByTimeAsync(400)
    expect(mockedApi.list).toHaveBeenCalledTimes(1)
  })

  it('runs a typed catalog search after the debounce window', async () => {
    useMarketStore.getState().setQuery('p')
    useMarketStore.getState().setQuery('pd')
    await vi.advanceTimersByTimeAsync(300)

    expect(mockedApi.list).toHaveBeenCalledTimes(1)
    expect(mockedApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'pd' }))
  })

  it('switches to the live market explicitly, without the catalog category', () => {
    useMarketStore.setState({ query: 'pdf', category: 'dev' })

    useMarketStore.getState().searchAllMarkets()

    expect(useMarketStore.getState().scope).toBe('market')
    expect(useMarketStore.getState().liveQuery).toBe('pdf')
    expect(mockedApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'market', q: 'pdf', category: undefined }),
    )
  })

  it('does not request while typing in live scope, only on Enter', async () => {
    useMarketStore.setState({ scope: 'market', query: 'pdf', liveQuery: 'pdf' })

    useMarketStore.getState().setQuery('pdf tools')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mockedApi.list).not.toHaveBeenCalled()

    useMarketStore.getState().submitQuery()
    expect(mockedApi.list).toHaveBeenCalledTimes(1)
    expect(mockedApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'market', q: 'pdf tools' }))
  })

  it('keeps paging the submitted live query, not the one still being typed', async () => {
    useMarketStore.setState({ scope: 'market', query: 'pdf edits', liveQuery: 'pdf', nextCursor: 'next' })

    await useMarketStore.getState().loadMore()

    expect(mockedApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'market', q: 'pdf', cursor: 'next' }),
    )
  })

  it('returns to the catalog at once when the query is cleared', () => {
    useMarketStore.setState({ scope: 'market', query: 'pdf', liveQuery: 'pdf' })

    useMarketStore.getState().setQuery('')

    expect(useMarketStore.getState().scope).toBe('catalog')
    expect(useMarketStore.getState().liveQuery).toBe('')
    expect(mockedApi.list).toHaveBeenCalledTimes(1)
    expect(mockedApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'catalog', q: undefined }))
  })

  it('goes back to the catalog with the same query', () => {
    useMarketStore.setState({ scope: 'market', query: 'pdf', liveQuery: 'pdf', category: 'dev' })

    useMarketStore.getState().backToCatalog()

    expect(useMarketStore.getState().scope).toBe('catalog')
    expect(mockedApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'catalog', q: 'pdf', category: 'dev' }))
  })

  it('drops a catalog response that lands after switching to the live market', async () => {
    const catalogPage = deferred<MarketListResponse>()
    mockedApi.list
      .mockImplementationOnce(() => catalogPage.promise)
      .mockResolvedValueOnce({ ...listResponse([makeSkill({ id: 'skillhub:live', source: 'skillhub' })]), scope: 'market' })
    useMarketStore.setState({ query: 'pdf' })

    const catalogRequest = useMarketStore.getState().fetchList({ reset: true })
    useMarketStore.getState().searchAllMarkets()
    await vi.waitFor(() => expect(useMarketStore.getState().isLoading).toBe(false))
    catalogPage.resolve({ ...listResponse([makeSkill({ id: 'clawhub:stale' })]), scope: 'catalog', total: 1 })
    await catalogRequest

    expect(useMarketStore.getState().items.map((item) => item.id)).toEqual(['skillhub:live'])
    expect(useMarketStore.getState().total).toBeNull()
  })

  it('keeps the known category list when live results carry none', async () => {
    const categories = [{ key: 'dev', name: '开发编程', nameEn: 'Development', count: 40 }]
    useMarketStore.setState({ query: 'pdf', categories })

    useMarketStore.getState().searchAllMarkets()
    await vi.waitFor(() => expect(useMarketStore.getState().isLoading).toBe(false))

    expect(useMarketStore.getState().categories).toEqual(categories)
  })
})

describe('marketStore ClawHub owner pinning', () => {
  // ClawHub slugs are not unique: two publishers can both ship `pdf`.
  const fromAlice = makeDetail({ id: 'clawhub:pdf', slug: 'pdf', author: { handle: 'alice' }, summary: 'Alice pdf' })
  const fromBob = makeDetail({ id: 'clawhub:pdf', slug: 'pdf', author: { handle: 'bob' }, summary: 'Bob pdf' })

  it('opens a ClawHub result pinned to the clicked card\'s owner', async () => {
    mockedApi.detail.mockResolvedValue({ skill: fromAlice, sourceStatus: { status: 'ok' } })

    await useMarketStore.getState().openDetail('clawhub:pdf', 'alice')

    expect(mockedApi.detail).toHaveBeenCalledWith('clawhub', 'pdf', { owner: 'alice' })
    expect(useMarketStore.getState().selectedOwner).toBe('alice')
  })

  it('never serves one owner\'s cached detail for the other owner\'s card', async () => {
    mockedApi.detail
      .mockResolvedValueOnce({ skill: fromAlice, sourceStatus: { status: 'ok' } })
      .mockResolvedValueOnce({ skill: fromBob, sourceStatus: { status: 'ok' } })

    await useMarketStore.getState().openDetail('clawhub:pdf', 'alice')
    useMarketStore.getState().backToList()
    await useMarketStore.getState().openDetail('clawhub:pdf', 'bob')

    expect(mockedApi.detail).toHaveBeenCalledTimes(2)
    expect(mockedApi.detail).toHaveBeenLastCalledWith('clawhub', 'pdf', { owner: 'bob' })
    expect(useMarketStore.getState().detail?.summary).toBe('Bob pdf')

    // Each owner keeps its own cache entry.
    useMarketStore.getState().backToList()
    await useMarketStore.getState().openDetail('clawhub:pdf', 'alice')
    expect(mockedApi.detail).toHaveBeenCalledTimes(2)
    expect(useMarketStore.getState().detail?.summary).toBe('Alice pdf')
  })

  it('keeps the owner when the open detail is refreshed', async () => {
    mockedApi.detail.mockResolvedValue({ skill: fromBob, sourceStatus: { status: 'ok' } })
    await useMarketStore.getState().openDetail('clawhub:pdf', 'bob')

    await useMarketStore.getState().refreshDetail('clawhub:pdf')

    expect(mockedApi.detail).toHaveBeenCalledTimes(2)
    expect(mockedApi.detail).toHaveBeenLastCalledWith('clawhub', 'pdf', { owner: 'bob' })
  })

  it('caches file contents per owner and passes the owner through', async () => {
    mockedApi.fileContent.mockImplementation(async (_source, _slug, path, owner) => ({
      file: { path, content: `# ${owner}`, language: 'markdown', size: 3, truncated: false },
    }))

    const alice = await useMarketStore.getState().fetchFileContent('clawhub:pdf', 'SKILL.md', 'alice')
    const bob = await useMarketStore.getState().fetchFileContent('clawhub:pdf', 'SKILL.md', 'bob')

    expect(alice.content).toBe('# alice')
    expect(bob.content).toBe('# bob')
    expect(mockedApi.fileContent).toHaveBeenCalledWith('clawhub', 'pdf', 'SKILL.md', 'alice')
    expect(mockedApi.fileContent).toHaveBeenCalledWith('clawhub', 'pdf', 'SKILL.md', 'bob')
  })

  it('installs the owner\'s skill, and only that card flips to installed', async () => {
    useMarketStore.setState({
      items: [
        makeSkill({ id: 'clawhub:pdf', slug: 'pdf', author: { handle: 'alice' } }),
        makeSkill({ id: 'clawhub:pdf', slug: 'pdf', author: { handle: 'bob' } }),
      ],
    })
    mockedApi.install.mockResolvedValue({
      ok: true,
      installedPath: '/tmp/skills/pdf',
      skill: makeSkill({ id: 'clawhub:pdf', slug: 'pdf', author: { handle: 'bob' }, installState: 'installed' }),
    })

    await useMarketStore.getState().install('clawhub:pdf', 'bob')

    expect(mockedApi.install).toHaveBeenCalledWith('clawhub:pdf', 'bob')
    expect(useMarketStore.getState().items.map((item) => [item.author.handle, item.installState])).toEqual([
      ['alice', 'installable'],
      ['bob', 'installed'],
    ])
  })

  it('sends no owner for SkillHub, whose ids are unique', async () => {
    const skillhub = makeDetail({ id: 'skillhub:pdf', slug: 'pdf', source: 'skillhub', author: { handle: 'carol' } })
    mockedApi.detail.mockResolvedValue({ skill: skillhub, sourceStatus: { status: 'ok' } })

    expect(marketOwnerOf(skillhub)).toBeUndefined()
    await useMarketStore.getState().openDetail('skillhub:pdf', marketOwnerOf(skillhub))

    expect(mockedApi.detail).toHaveBeenCalledWith('skillhub', 'pdf', {})
    expect(useMarketStore.getState().selectedOwner).toBeNull()
  })

  it('takes the owner only from a ClawHub card with a handle', () => {
    expect(marketOwnerOf(makeSkill({ author: { handle: 'alice' } }))).toBe('alice')
    expect(marketOwnerOf(makeSkill({ author: { handle: '' } }))).toBeUndefined()
    expect(marketSkillKey('clawhub:pdf', 'alice')).toBe('clawhub:pdf@alice')
    expect(marketSkillKey('skillhub:pdf')).toBe('skillhub:pdf')
  })
})

describe('marketStore detail cache', () => {
  it('fetches detail once and serves the second open from cache', async () => {
    mockedApi.detail.mockResolvedValue({ skill: makeDetail(), sourceStatus: { status: 'ok' } })

    await useMarketStore.getState().openDetail('clawhub:demo')
    expect(useMarketStore.getState().detail?.id).toBe('clawhub:demo')

    useMarketStore.getState().backToList()
    await useMarketStore.getState().openDetail('clawhub:demo')

    expect(mockedApi.detail).toHaveBeenCalledTimes(1)
    expect(useMarketStore.getState().detail?.id).toBe('clawhub:demo')
  })

  it('records detailError on failure', async () => {
    mockedApi.detail.mockRejectedValue(new Error('down'))

    await useMarketStore.getState().openDetail('clawhub:demo')

    expect(useMarketStore.getState().detailError).toBe('down')
    expect(useMarketStore.getState().isDetailLoading).toBe(false)
  })

  it('ignores an old detail response after backing out and reopening the same skill', async () => {
    const first = deferred<{ skill: NormalizedSkillDetail; sourceStatus: { status: 'ok' } }>()
    const second = deferred<{ skill: NormalizedSkillDetail; sourceStatus: { status: 'ok' } }>()
    mockedApi.detail
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const firstOpen = useMarketStore.getState().openDetail('clawhub:demo')
    useMarketStore.getState().backToList()
    const secondOpen = useMarketStore.getState().openDetail('clawhub:demo')

    second.resolve({
      skill: makeDetail({ description: '# New' }),
      sourceStatus: { status: 'ok' },
    })
    await secondOpen
    first.resolve({
      skill: makeDetail({ description: '# Old' }),
      sourceStatus: { status: 'ok' },
    })
    await firstOpen

    expect(useMarketStore.getState().detail?.description).toBe('# New')
  })
})

describe('marketStore file cache', () => {
  it('caches file content per skill+path', async () => {
    mockedApi.fileContent.mockResolvedValue({
      file: { path: 'SKILL.md', content: '# x', language: 'markdown', size: 3, truncated: false },
    })

    const first = await useMarketStore.getState().fetchFileContent('clawhub:demo', 'SKILL.md')
    const second = await useMarketStore.getState().fetchFileContent('clawhub:demo', 'SKILL.md')

    expect(first.content).toBe('# x')
    expect(second).toBe(first)
    expect(mockedApi.fileContent).toHaveBeenCalledTimes(1)
  })
})

describe('marketStore install/uninstall', () => {
  it('marks the item installed in list and detail after install', async () => {
    const detail = makeDetail()
    useMarketStore.setState({
      items: [makeSkill()],
      detail,
      selectedId: detail.id,
      detailCache: new Map([[detail.id, detail]]),
    })
    mockedApi.install.mockResolvedValue({
      ok: true,
      installedPath: '/tmp/skills/demo',
      skill: makeSkill({ installState: 'installed', installedInfo: { dirName: 'demo' } }),
    })

    const ok = await useMarketStore.getState().install('clawhub:demo')

    expect(ok).toBe(true)
    const state = useMarketStore.getState()
    expect(state.items[0]!.installState).toBe('installed')
    expect(state.detail?.installState).toBe('installed')
    expect(state.detailCache.get('clawhub:demo')?.installState).toBe('installed')
    expect(state.installingIds.has('clawhub:demo')).toBe(false)
  })

  it('prevents concurrent installs of the same skill', async () => {
    useMarketStore.setState({ installingIds: new Set(['clawhub:demo']) })

    const ok = await useMarketStore.getState().install('clawhub:demo')

    expect(ok).toBe(false)
    expect(mockedApi.install).not.toHaveBeenCalled()
  })

  it('classifies install errors and clears the installing flag', async () => {
    useMarketStore.setState({ items: [makeSkill()] })
    mockedApi.install.mockRejectedValue(new ApiError(502, { error: 'MARKET_CHECKSUM_MISMATCH', message: 'bad hash' }))

    const ok = await useMarketStore.getState().install('clawhub:demo')

    expect(ok).toBe(false)
    const state = useMarketStore.getState()
    expect(state.installError?.kind).toBe('checksum')
    expect(state.installingIds.has('clawhub:demo')).toBe(false)
  })

  it('flips state back to installable after uninstall', async () => {
    useMarketStore.setState({ items: [makeSkill({ installState: 'installed' })] })
    mockedApi.uninstall.mockResolvedValue({
      ok: true,
      removedPath: '/tmp/skills/demo',
      skill: makeSkill({ installState: 'installable' }),
    })

    const ok = await useMarketStore.getState().uninstall('clawhub:demo')

    expect(ok).toBe(true)
    expect(useMarketStore.getState().items[0]!.installState).toBe('installable')
  })

  it('keeps installed-state filters consistent after install and uninstall', async () => {
    useMarketStore.setState({
      items: [makeSkill()],
      filters: { source: 'all', security: 'all', installed: 'installable' },
    })
    mockedApi.install.mockResolvedValue({
      ok: true,
      installedPath: '/tmp/skills/demo',
      skill: makeSkill({ installState: 'installed', installedInfo: { dirName: 'demo' } }),
    })

    await useMarketStore.getState().install('clawhub:demo')
    expect(useMarketStore.getState().items).toEqual([])

    useMarketStore.setState({
      items: [makeSkill({ installState: 'installed', installedInfo: { dirName: 'demo' } })],
      filters: { source: 'all', security: 'all', installed: 'installed' },
    })
    mockedApi.uninstall.mockResolvedValue({
      ok: true,
      removedPath: '/tmp/skills/demo',
      skill: makeSkill({ installState: 'installable' }),
    })

    await useMarketStore.getState().uninstall('clawhub:demo')
    expect(useMarketStore.getState().items).toEqual([])
  })
})

describe('classifyInstallError', () => {
  it('maps API error codes to error kinds', () => {
    expect(classifyInstallError(new ApiError(409, { error: 'MARKET_ALREADY_INSTALLED', message: 'x' })).kind).toBe('exists')
    expect(classifyInstallError(new ApiError(409, { error: 'MARKET_INSTALL_IN_PROGRESS', message: 'x' })).kind).toBe('exists')
    expect(classifyInstallError(new ApiError(422, { error: 'MARKET_NOT_INSTALLABLE', message: 'x' })).kind).toBe('notInstallable')
    expect(classifyInstallError(new ApiError(500, { error: 'MARKET_DISK_ERROR', message: 'x' })).kind).toBe('disk')
    expect(classifyInstallError(new ApiError(502, { error: 'MARKET_UPSTREAM_TIMEOUT', message: 'x' })).kind).toBe('network')
    expect(classifyInstallError(new Error('Request timed out after 120s')).kind).toBe('network')
    expect(classifyInstallError(new Error('weird')).kind).toBe('generic')
  })
})
