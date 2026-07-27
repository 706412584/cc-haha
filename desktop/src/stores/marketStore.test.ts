import { describe, it, expect, vi, beforeEach } from 'vitest'

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
import { useMarketStore, classifyInstallError } from './marketStore'
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
    query: '',
    filters: { source: 'all', security: 'all', installed: 'all' },
    isLoading: false,
    isLoadingMore: false,
    error: null,
    loadMoreError: null,
    selectedId: null,
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
