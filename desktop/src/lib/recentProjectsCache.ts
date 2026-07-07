import type { RecentProject } from '../api/sessions'

let cachedProjects: RecentProject[] | null = null
let cacheTimestamp = 0
const CACHE_TTL = 30_000

export function getCachedRecentProjects(): RecentProject[] | null {
  if (!cachedProjects || Date.now() - cacheTimestamp >= CACHE_TTL) return null
  return cachedProjects
}

export function setCachedRecentProjects(projects: RecentProject[]): void {
  cachedProjects = projects
  cacheTimestamp = Date.now()
}

export function invalidateRecentProjectsCache(): void {
  cachedProjects = null
  cacheTimestamp = 0
}
