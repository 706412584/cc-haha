import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecentProject } from '../api/sessions'
import {
  getCachedRecentProjects,
  invalidateRecentProjectsCache,
  setCachedRecentProjects,
} from './recentProjectsCache'

function makeProject(path: string): RecentProject {
  return {
    projectPath: path,
    realPath: path,
    projectName: path.split('/').filter(Boolean).pop() || path,
    repoName: null,
    branch: null,
    isGit: false,
    modifiedAt: '2026-05-07T00:00:00.000Z',
    sessionCount: 1,
  }
}

describe('recentProjectsCache', () => {
  afterEach(() => {
    vi.useRealTimers()
    invalidateRecentProjectsCache()
  })

  it('returns fresh cached projects until they are invalidated or expire', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-07T00:00:00.000Z'))
    const projects = [makeProject('/workspace/project')]

    setCachedRecentProjects(projects)

    expect(getCachedRecentProjects()).toBe(projects)

    vi.setSystemTime(new Date('2026-05-07T00:00:29.999Z'))
    expect(getCachedRecentProjects()).toBe(projects)

    vi.setSystemTime(new Date('2026-05-07T00:00:30.000Z'))
    expect(getCachedRecentProjects()).toBeNull()

    setCachedRecentProjects(projects)
    invalidateRecentProjectsCache()

    expect(getCachedRecentProjects()).toBeNull()
  })
})
