import { beforeEach, describe, expect, it, vi } from 'vitest'

const listMock = vi.hoisted(() => vi.fn())
const detailMock = vi.hoisted(() => vi.fn())

vi.mock('../api/skills', () => ({
  skillsApi: {
    list: listMock,
    detail: detailMock,
  },
}))

import type { SkillDetail, SkillMeta } from '../types/skill'
import { useSkillStore } from './skillStore'

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
    })
  })

  it('ignores a slower skill list from the previous project', async () => {
    const oldRequest = deferred<{ skills: SkillMeta[] }>()
    const newRequest = deferred<{ skills: SkillMeta[] }>()
    listMock.mockImplementation((cwd: string) =>
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
    listMock.mockReturnValue(nextRequest.promise)

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
    detailMock.mockImplementation((_source: string, name: string) =>
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
    detailMock.mockReturnValue(request.promise)

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
