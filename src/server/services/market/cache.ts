/**
 * Skills Market — in-memory TTL cache with stale-while-error support,
 * plus per-source health tracking.
 *
 * The cache stores normalized upstream data only. Install state is computed
 * per-request on top of cached data and is never cached here.
 */

import type { MarketSource, SourceHealthStatus, SourceStatusInfo } from './types.js'

type CacheEntry = {
  value: unknown
  expiresAt: number
  storedAt: number
}

const MAX_ENTRIES = 500

export const MARKET_TTL = {
  list: 5 * 60_000,
  search: 2 * 60_000,
  detail: 10 * 60_000,
  files: 10 * 60_000,
  fileContent: 30 * 60_000,
} as const

class MarketCache {
  private entries = new Map<string, CacheEntry>()

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) return undefined
    // LRU touch
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value as T
  }

  /** Returns the entry even when expired — used for stale-while-error fallback. */
  getStale<T>(key: string): { value: T; storedAt: number } | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    return { value: entry.value as T, storedAt: entry.storedAt }
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs, storedAt: Date.now() })
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

export const marketCache = new MarketCache()

// ─── Source health ───────────────────────────────────────────────────────────

type HealthRecord = {
  status: SourceHealthStatus
  lastOkAt?: number
  lastError?: string
}

const sourceHealth: Record<MarketSource, HealthRecord> = {
  clawhub: { status: 'ok' },
  skillhub: { status: 'ok' },
}

export function recordSourceSuccess(source: MarketSource): void {
  sourceHealth[source] = { status: 'ok', lastOkAt: Date.now() }
}

export function recordSourceFailure(source: MarketSource, error: string): void {
  const prev = sourceHealth[source]
  sourceHealth[source] = {
    // Recent success + fresh failure = degraded; repeated failure = failed
    status: prev.status === 'ok' && prev.lastOkAt ? 'degraded' : 'failed',
    lastOkAt: prev.lastOkAt,
    lastError: error,
  }
}

export function getSourceHealth(source: MarketSource): SourceStatusInfo {
  const record = sourceHealth[source]
  return {
    status: record.status,
    fetchedAt: record.lastOkAt,
    error: record.lastError,
  }
}

export function resetMarketCacheForTests(): void {
  marketCache.clear()
  sourceHealth.clawhub = { status: 'ok' }
  sourceHealth.skillhub = { status: 'ok' }
}
