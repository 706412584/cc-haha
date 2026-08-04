import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogSkill, SkillDetail, SkillMeta } from '../types/skill'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  catalog: vi.fn(),
  install: vi.fn(),
}))

vi.mock('../api/skills', () => ({
  skillsApi: mocks,
}))

import { useSkillStore } from './skillStore'

const catalogEntry: CatalogSkill = {
  name: 'coderabbit-review',
  displayName: 'CodeRabbit Review',
  description: 'Run CodeRabbit review',
  category: 'Code Review',
  source: 'openai/plugins (MIT)',
  installed: false,
}

const installedMeta: SkillMeta = {
  name: 'coderabbit-review',
  description: 'Run CodeRabbit review',
  source: 'user',
  userInvocable: true,
  contentLength: 100,
  hasDirectory: true,
}

function makeSkill(name: string): SkillMeta {
  return {
    name,
    description: `${name} description`,
    source: 'project',
    userInvocable: true,
    contentLength: 100,
    hasDirectory: true,
  }
}

function makeDetail(name: string): SkillDetail {
  return {
    meta: makeSkill(name),
    tree: [],
    files: [],
    skillRoot: `/workspace/${name}`,
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

describe('skillStore', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    useSkillStore.setState({
      skills: [],
      skillsContext: null,
      selectedSkill: null,
      selectedSkillReturnTab: 'skills',
      selectedSkillContext: null,
      isLoading: false,
      isDetailLoading: false,
      error: null,
      catalog: [],
      isCatalogLoading: false,
      installingName: null,
    })
  })

  it('fetchCatalog populates the catalog', async () => {
    mocks.catalog.mockResolvedValue({ catalog: [catalogEntry] })

    await useSkillStore.getState().fetchCatalog()

    expect(mocks.catalog).toHaveBeenCalledTimes(1)
    expect(useSkillStore.getState().catalog).toEqual([catalogEntry])
    expect(useSkillStore.getState().isCatalogLoading).toBe(false)
  })

  it('installs then refreshes catalog and installed skills', async () => {
    mocks.install.mockResolvedValue({ ok: true, installed: true })
    mocks.catalog.mockResolvedValue({ catalog: [{ ...catalogEntry, installed: true }] })
    mocks.list.mockResolvedValue({ skills: [installedMeta] })

    await useSkillStore.getState().installSkill('coderabbit-review', '/work/dir')

    expect(mocks.install).toHaveBeenCalledWith('coderabbit-review')
    expect(mocks.catalog).toHaveBeenCalledTimes(1)
    expect(mocks.list).toHaveBeenCalledWith('/work/dir')
    expect(useSkillStore.getState()).toMatchObject({
      installingName: null,
      catalog: [{ ...catalogEntry, installed: true }],
      skills: [installedMeta],
    })
  })

  it('records an install error and clears installingName', async () => {
    mocks.install.mockRejectedValue(new Error('disk full'))

    await useSkillStore.getState().installSkill('coderabbit-review')

    expect(useSkillStore.getState()).toMatchObject({
      error: 'disk full',
      installingName: null,
    })
    expect(mocks.catalog).not.toHaveBeenCalled()
  })

  it('ignores a slower skill list from the previous project', async () => {
    const oldRequest = deferred<{ skills: SkillMeta[] }>()
    const newRequest = deferred<{ skills: SkillMeta[] }>()
    mocks.list.mockImplementation((cwd: string) =>
      cwd.endsWith('old') ? oldRequest.promise : newRequest.promise,
    )

    const oldFetch = useSkillStore.getState().fetchSkills('/workspace/old')
    const newFetch = useSkillStore.getState().fetchSkills('/workspace/new')
    newRequest.resolve({ skills: [makeSkill('new-skill')] })
    await newFetch
    oldRequest.resolve({ skills: [makeSkill('old-skill')] })
    await oldFetch

    expect(useSkillStore.getState()).toMatchObject({
      skills: [makeSkill('new-skill')],
      skillsContext: '/workspace/new',
      isLoading: false,
      error: null,
    })
  })

  it('hides the previous project list while the next context loads', async () => {
    const nextRequest = deferred<{ skills: SkillMeta[] }>()
    useSkillStore.setState({
      skills: [makeSkill('old-skill')],
      skillsContext: '/workspace/old',
    })
    mocks.list.mockReturnValue(nextRequest.promise)

    const fetch = useSkillStore.getState().fetchSkills('/workspace/new')

    expect(useSkillStore.getState()).toMatchObject({
      skills: [],
      skillsContext: '/workspace/old',
      isLoading: true,
    })

    nextRequest.resolve({ skills: [makeSkill('new-skill')] })
    await fetch
  })

  it('keeps the newest detail when an older request resolves last', async () => {
    const oldRequest = deferred<{ detail: SkillDetail }>()
    const newRequest = deferred<{ detail: SkillDetail }>()
    mocks.detail.mockImplementation((_source: string, name: string) =>
      name === 'old-skill' ? oldRequest.promise : newRequest.promise,
    )

    const oldFetch = useSkillStore.getState().fetchSkillDetail(
      'project',
      'old-skill',
      '/workspace/old',
    )
    const newFetch = useSkillStore.getState().fetchSkillDetail(
      'project',
      'new-skill',
      '/workspace/new',
    )
    newRequest.resolve({ detail: makeDetail('new-skill') })
    await newFetch
    oldRequest.resolve({ detail: makeDetail('old-skill') })
    await oldFetch

    expect(useSkillStore.getState()).toMatchObject({
      selectedSkill: makeDetail('new-skill'),
      selectedSkillContext: '/workspace/new',
      isDetailLoading: false,
      error: null,
    })
  })

  it('does not reopen a detail after the user returns to the list', async () => {
    const request = deferred<{ detail: SkillDetail }>()
    mocks.detail.mockReturnValue(request.promise)

    const fetch = useSkillStore.getState().fetchSkillDetail(
      'user',
      'slow-skill',
      '/workspace/current',
    )
    useSkillStore.getState().clearSelection()
    request.resolve({ detail: makeDetail('slow-skill') })
    await fetch

    expect(useSkillStore.getState()).toMatchObject({
      selectedSkill: null,
      selectedSkillContext: null,
      isDetailLoading: false,
    })
  })
})
