import { api } from './client'

export type RecentSessionDerived = {
  sessionId: string
  title: string
  modifiedAt: string
  messageCount: number
  lastUserMessageExcerpt?: string
  filesEditedCount: number
  filesEditedSample: string[]
}

export type RecentGitActivity = {
  branch: string | null
  defaultBranch: string | null
  aheadCount: number
  behindCount: number
  dirtyCount: number
  /** Up to ~20 repo-relative paths with uncommitted changes, most-recently-edited first. */
  dirtyFiles: string[]
}

export type RecentActivityResult = {
  hasActivity: boolean
  workDir: string
  lastSession?: RecentSessionDerived
  git?: RecentGitActivity
}

/**
 * Two-layer summary returned by /api/sessions/:id/summary. Generated
 * server-side via the user's active provider; cached on disk. Token
 * accounting fields are best-effort (some providers don't return them).
 */
export type SessionSummary = {
  sessionId: string
  generatedAt: string
  baseMessageCount: number
  modelUsed: string
  main: string
  recent: string
  tokensIn?: number
  tokensOut?: number
}

export const projectsApi = {
  recentActivity(
    workDir: string,
    options?: { excludeSessionId?: string },
  ): Promise<RecentActivityResult> {
    const params = new URLSearchParams({ workDir })
    if (options?.excludeSessionId) {
      params.set('excludeSessionId', options.excludeSessionId)
    }
    return api.get<RecentActivityResult>(
      `/api/projects/recent-activity?${params.toString()}`,
    )
  },

  /**
   * Read-only — returns cached summary, or null if none exists. Pass
   * `staleAt` to require regeneration if the live message count is higher
   * than the cached `baseMessageCount` (i.e. session continued).
   */
  getSessionSummary(
    sessionId: string,
    options?: { staleAt?: number },
  ): Promise<{ summary: SessionSummary | null }> {
    const params = new URLSearchParams()
    if (typeof options?.staleAt === 'number' && Number.isFinite(options.staleAt)) {
      params.set('staleAt', String(options.staleAt))
    }
    const query = params.toString()
    return api.get<{ summary: SessionSummary | null }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/summary${query ? `?${query}` : ''}`,
    )
  },

  /**
   * Generate (or fetch cached) summary. Pass `force: true` to bypass cache.
   * Throws on 5xx (e.g. provider not configured / generation failed).
   * Uses a generous 90s timeout — first generation against a long
   * transcript can take 30-60s with a slow upstream.
   */
  generateSessionSummary(
    sessionId: string,
    options?: { force?: boolean; staleAt?: number },
  ): Promise<{ summary: SessionSummary }> {
    const params = new URLSearchParams()
    if (options?.force) params.set('force', '1')
    if (typeof options?.staleAt === 'number' && Number.isFinite(options.staleAt)) {
      params.set('staleAt', String(options.staleAt))
    }
    const query = params.toString()
    return api.post<{ summary: SessionSummary }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/summary${query ? `?${query}` : ''}`,
      undefined,
      { timeout: 90_000 },
    )
  },

  /**
   * Resolve the best-available summary: try cached GET first (fast — never
   * blocks on the LLM), then fall back to POST generation. Used by the
   * "Continue from here" button to give the user instant resume when a
   * cached summary is on disk and only pay the LLM round-trip on first hit.
   */
  async resolveSessionSummaryForHandoff(
    sessionId: string,
  ): Promise<SessionSummary | null> {
    try {
      const cached = await this.getSessionSummary(sessionId)
      if (cached.summary) return cached.summary
    } catch {
      // Fall through to generation path on any GET error.
    }
    try {
      const fresh = await this.generateSessionSummary(sessionId)
      return fresh.summary
    } catch {
      return null
    }
  },
}
