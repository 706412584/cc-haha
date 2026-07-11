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

  it('passes filters to the api', async () => {
    mockedApi.list.mockResolvedValue(listResponse([]))
    useMarketStore.setState({ filters: { source: 'skillhub', security: 'benign', installed: 'installed' } })

    await useMarketStore.getState().fetchList({ reset: true })

    expect(mockedApi.list).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'skillhub', security: 'benign', installed: 'installed' }),
    )
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
