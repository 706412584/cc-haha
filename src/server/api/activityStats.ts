import { resolve } from 'node:path'
import {
  aggregateClaudeCodeStatsForRange,
  type ClaudeCodeStats,
  type StatsDateRange,
} from '../../utils/stats.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { loadStatsCache } from '../../utils/statsCache.js'
import { logForDebugging } from '../../utils/debug.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { localIndexCoordinator } from '../services/localIndex/coordinator.js'
import type { LocalIndexGateway } from '../services/localIndex/sessionIndex.js'

const VALID_RANGES = new Set<StatsDateRange>(['7d', '30d', 'all'])
const fallbackInFlight = new Map<string, Promise<ClaudeCodeStats>>()

async function hasComputedStatsCache(): Promise<boolean> {
  return (await loadStatsCache()).lastComputedDate !== null
}

function normalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForComparison)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeForComparison(entry)]),
  )
}

async function aggregateFileStats(
  range: StatsDateRange,
  now: Date,
): Promise<ClaudeCodeStats> {
  const scope = resolve(getClaudeConfigHomeDir())
  const key = `${scope}\0${range}\0${now.toISOString().slice(0, 10)}`
  const existing = fallbackInFlight.get(key)
  if (existing) return existing
  const operation = aggregateClaudeCodeStatsForRange(range, { now })
  fallbackInFlight.set(key, operation)
  try {
    return await operation
  } finally {
    if (fallbackInFlight.get(key) === operation) fallbackInFlight.delete(key)
  }
}

export async function aggregateActivityStatsForMode(
  range: StatsDateRange,
  now: Date,
  gateway: LocalIndexGateway = localIndexCoordinator,
  cacheProbe: () => Promise<boolean> = hasComputedStatsCache,
): Promise<ClaudeCodeStats> {
  const mode = gateway.getMode()
  const ready = gateway.isActivityScopeReady?.() === true
  let indexedCompatible = true
  if (range === 'all' && ready && (mode === 'on' || mode === 'shadow')) {
    try {
      // A non-empty canonical cache can intentionally contain historical
      // snapshots that no longer match current source rows. Until that cache
      // participates in the projection, preserve its user-visible result.
      indexedCompatible = !await cacheProbe()
    } catch {
      indexedCompatible = false
    }
  }

  if (mode === 'on' && ready && indexedCompatible) {
    const indexed = gateway.getActivityStats?.(range, now)
    if (indexed) return indexed
  }

  const fileStats = await aggregateFileStats(range, now)
  if (mode === 'shadow' && ready && indexedCompatible) {
    const indexed = gateway.getActivityStats?.(range, now)
    if (
      indexed &&
      JSON.stringify(normalizeForComparison(indexed)) !==
        JSON.stringify(normalizeForComparison(fileStats))
    ) {
      logForDebugging(`Local activity index parity mismatch for range ${range}`)
    }
  }
  return fileStats
}

export async function handleActivityStatsApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    if (req.method !== 'GET') {
      throw methodNotAllowed(req.method)
    }

    const requestedRange = segments[2]
    const range: StatsDateRange = requestedRange === undefined ? 'all' : parseRange(requestedRange)
    const now = new Date()
    const stats = await aggregateActivityStatsForMode(range, now)

    return Response.json({
      stats,
      range,
      generatedAt: now.toISOString(),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

function parseRange(range: string): StatsDateRange {
  if (VALID_RANGES.has(range as StatsDateRange)) {
    return range as StatsDateRange
  }

  throw ApiError.badRequest(`Unknown activity stats range: ${range}`)
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
