import { feature } from 'bun:bundle'
import type { ModelUsage } from '../../../entrypoints/agentSdkTypes.js'
import {
  processedStatsToClaudeCodeStats,
  resolveStatsDateRange,
  type ClaudeCodeStats,
  type DailyActivity,
  type DailyModelTokens,
  type ProcessedStats,
  type SessionStats,
  type StatsDateRange,
} from '../../../utils/stats.js'
import type {
  LocalIndexDatabase,
  LocalIndexWriteOperation,
} from './database.js'
import type { SourceFingerprint } from './sourceFingerprint.js'
import type { TranscriptActivityProjection } from './types.js'

export type ActivitySourceRecord = {
  path: string
  parentSessionId: string
  projectPath: string
  isSubagent: boolean
  size: number
  mtimeMs: number
  fileIdentity: string | null
  fingerprint: string
  indexedBytes: number
  parserVersion: number
  state: 'ready' | 'pending' | 'degraded'
}

export type ActivitySourceDescriptor = {
  path: string
  parentSessionId: string
  projectPath: string
  isSubagent: boolean
  fingerprint: SourceFingerprint
  fingerprintJson: string
  indexedBytes: number
  parserVersion: number
  state: 'ready' | 'pending'
  updatedAtMs: number
}

export type ActivityBackfillState = {
  scope: string
  state: string
  discovered: number
  indexed: number
  degraded: number
  lastErrorCode: string | null
  updatedAtMs: number
}

export interface ActivityIndex {
  getActivitySource(path: string): ActivitySourceRecord | null
  listActivitySources(): ActivitySourceRecord[]
  countActivitySources(): number
  getActivityBackfillState(scope: string): ActivityBackfillState | null
  aggregateActivity(range: StatsDateRange, now?: Date): ClaudeCodeStats
  explainAggregatePlan(range: StatsDateRange, now?: Date): string[]
}

type ActivitySourceRow = {
  path: string
  parent_session_id: string
  project_path: string
  is_subagent: number
  size_bytes: number
  mtime_ms: number
  file_identity: string | null
  prefix_hash: string
  indexed_bytes: number
  parser_version: number
  state: ActivitySourceRecord['state']
}

function sourceFromRow(row: ActivitySourceRow): ActivitySourceRecord {
  return {
    path: row.path,
    parentSessionId: row.parent_session_id,
    projectPath: row.project_path,
    isSubagent: row.is_subagent === 1,
    size: row.size_bytes,
    mtimeMs: row.mtime_ms,
    fileIdentity: row.file_identity,
    fingerprint: row.prefix_hash,
    indexedBytes: row.indexed_bytes,
    parserVersion: row.parser_version,
    state: row.state,
  }
}

function rangePredicate(
  range: StatsDateRange,
  now: Date,
  column: string,
  sourceMtimeColumn?: string,
): { sql: string; bindings: Array<string | number> } {
  const resolved = resolveStatsDateRange(range, now)
  if (!resolved.fromDate || !resolved.toDate) {
    const { today, yesterday, todayStartMs } = freshAllTimeBounds(now)
    return sourceMtimeColumn
      ? {
          // A fresh canonical all-time read builds historical data through
          // yesterday, then adds today's rows only from sources whose mtime is
          // today-or-newer. Future event dates are excluded.
          sql: ` WHERE (${column} <= ? OR (${column} = ? AND ${sourceMtimeColumn} >= ?))`,
          bindings: [yesterday, today, todayStartMs],
        }
      : { sql: ` WHERE ${column} <= ?`, bindings: [today] }
  }
  return {
    // The canonical bounded reader skips an entire source when its UTC mtime
    // predates the lower bound, even if that source contains newer timestamps.
    sql: ` WHERE ${column} >= ? AND ${column} <= ?${
      sourceMtimeColumn ? ` AND ${sourceMtimeColumn} >= ?` : ''
    }`,
    bindings: [
      resolved.fromDate,
      resolved.toDate,
      ...(sourceMtimeColumn
        ? [Date.parse(`${resolved.fromDate}T00:00:00.000Z`)]
        : []),
    ],
  }
}

function freshAllTimeBounds(now: Date): {
  today: string
  yesterday: string
  todayStartMs: number
} {
  const today = now.toISOString().slice(0, 10)
  const previous = new Date(now)
  previous.setDate(previous.getDate() - 1)
  return {
    today,
    yesterday: previous.toISOString().slice(0, 10),
    todayStartMs: Date.parse(`${today}T00:00:00.000Z`),
  }
}

function sourceMtimePredicate(
  range: StatsDateRange,
  now: Date,
  column: string,
): { sql: string; bindings: number[] } {
  const resolved = resolveStatsDateRange(range, now)
  if (!resolved.fromDate) return { sql: '', bindings: [] }
  return {
    // Canonical bounded stats skip a whole source only when its UTC mtime date
    // predates the lower bound. Once selected, source-wide values are included
    // in full; there is intentionally no upper-bound predicate here.
    sql: ` WHERE ${column} >= ?`,
    bindings: [Date.parse(`${resolved.fromDate}T00:00:00.000Z`)],
  }
}

function emptyModelUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }
}

export function writeActivityProjection(
  operation: LocalIndexWriteOperation,
  source: ActivitySourceDescriptor,
  activity: TranscriptActivityProjection,
): void {
  operation.run(`
    INSERT INTO activity_sources (
      path, parent_session_id, project_path, is_subagent, size_bytes, mtime_ms,
      file_identity, prefix_hash, indexed_bytes, parser_version, state,
      last_error_code, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(path) DO UPDATE SET
      parent_session_id = excluded.parent_session_id,
      project_path = excluded.project_path,
      is_subagent = excluded.is_subagent,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      file_identity = excluded.file_identity,
      prefix_hash = excluded.prefix_hash,
      indexed_bytes = excluded.indexed_bytes,
      parser_version = excluded.parser_version,
      state = excluded.state,
      last_error_code = NULL,
      updated_at_ms = excluded.updated_at_ms
  `,
  source.path,
  source.parentSessionId,
  source.projectPath,
  source.isSubagent ? 1 : 0,
  source.fingerprint.size,
  source.fingerprint.mtimeMs,
  source.fingerprint.fileIdentity,
  source.fingerprintJson,
  source.indexedBytes,
  source.parserVersion,
  source.state,
  source.updatedAtMs)

  operation.run('DELETE FROM activity_sessions WHERE transcript_path = ?', source.path)
  operation.run('DELETE FROM activity_daily WHERE transcript_path = ?', source.path)
  operation.run('DELETE FROM activity_daily_models WHERE transcript_path = ?', source.path)
  operation.run('DELETE FROM activity_daily_tools WHERE transcript_path = ?', source.path)
  operation.run('DELETE FROM activity_daily_skills WHERE transcript_path = ?', source.path)

  const firstTime = activity.firstTimestamp
    ? Date.parse(activity.firstTimestamp)
    : Number.NaN
  const lastTime = activity.lastTimestamp
    ? Date.parse(activity.lastTimestamp)
    : Number.NaN
  const duration = Number.isFinite(firstTime) && Number.isFinite(lastTime)
    ? lastTime - firstTime
    : 0
  operation.run(`
    INSERT INTO activity_sessions (
      transcript_path, session_id, first_timestamp, last_timestamp,
      duration_ms, message_count, start_hour, speculation_time_saved_ms,
      shot_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  source.path,
  source.parentSessionId,
  activity.firstTimestamp,
  activity.lastTimestamp,
  duration,
  activity.messageCount,
  activity.startHour,
  activity.speculationTimeSavedMs,
  activity.shotCount)

  for (const day of activity.daily) {
    operation.run(`
      INSERT INTO activity_daily (
        transcript_path, date, message_count, tool_call_count
      ) VALUES (?, ?, ?, ?)
    `, source.path, day.date, day.messageCount, day.toolCallCount)
  }
  for (const model of activity.models) {
    operation.run(`
      INSERT INTO activity_daily_models (
        transcript_path, date, model, input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens,
        web_search_requests, cost_usd, context_window, max_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    source.path,
    model.date,
    model.model,
    model.inputTokens,
    model.outputTokens,
    model.cacheReadInputTokens,
    model.cacheCreationInputTokens,
    model.webSearchRequests,
    model.costUSD,
    model.contextWindow,
    model.maxOutputTokens)
  }
  for (const tool of activity.tools) {
    operation.run(`
      INSERT INTO activity_daily_tools (
        transcript_path, date, tool_name, call_count
      ) VALUES (?, ?, ?, ?)
    `, source.path, tool.date, tool.name, tool.count)
  }
  for (const skill of activity.skills) {
    operation.run(`
      INSERT INTO activity_daily_skills (
        transcript_path, date, skill_name, call_count
      ) VALUES (?, ?, ?, ?)
    `, source.path, skill.date, skill.name, skill.count)
  }
}

export function writeActivityBackfillState(
  operation: LocalIndexWriteOperation,
  state: ActivityBackfillState & { watermark?: string | null },
): void {
  operation.run(`
    INSERT INTO activity_backfill_state (
      scope, state, watermark, discovered, indexed, degraded,
      last_error_code, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      state = excluded.state,
      watermark = excluded.watermark,
      discovered = excluded.discovered,
      indexed = excluded.indexed,
      degraded = excluded.degraded,
      last_error_code = excluded.last_error_code,
      updated_at_ms = excluded.updated_at_ms
  `,
  state.scope,
  state.state,
  state.watermark ?? null,
  state.discovered,
  state.indexed,
  state.degraded,
  state.lastErrorCode,
  state.updatedAtMs)
}

export function createActivityIndex(
  database: LocalIndexDatabase,
  options: { shotStatsEnabled?: boolean } = {},
): ActivityIndex {
  let shotStatsEnabled = options.shotStatsEnabled === true
  if (options.shotStatsEnabled === undefined && feature('SHOT_STATS')) {
    shotStatsEnabled = true
  }
  return {
    getActivitySource(path): ActivitySourceRecord | null {
      return database.read(operation => {
        const row = operation.get<ActivitySourceRow>(`
          SELECT path, parent_session_id, project_path, is_subagent, size_bytes,
            mtime_ms, file_identity, prefix_hash, indexed_bytes, parser_version,
            state
          FROM activity_sources
          WHERE path = ?
        `, path)
        return row ? sourceFromRow(row) : null
      })
    },

    listActivitySources(): ActivitySourceRecord[] {
      return database.read(operation => operation.all<ActivitySourceRow>(`
        SELECT path, parent_session_id, project_path, is_subagent, size_bytes,
          mtime_ms, file_identity, prefix_hash, indexed_bytes, parser_version,
          state
        FROM activity_sources
        ORDER BY path ASC
      `).map(sourceFromRow))
    },

    countActivitySources(): number {
      return database.read(operation => operation.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM activity_sources',
      )?.count ?? 0)
    },

    getActivityBackfillState(scope): ActivityBackfillState | null {
      return database.read(operation => {
        const row = operation.get<{
          scope: string
          state: string
          discovered: number
          indexed: number
          degraded: number
          last_error_code: string | null
          updated_at_ms: number
        }>(`
          SELECT scope, state, discovered, indexed, degraded,
            last_error_code, updated_at_ms
          FROM activity_backfill_state
          WHERE scope = ?
        `, scope)
        return row
          ? {
              scope: row.scope,
              state: row.state,
              discovered: row.discovered,
              indexed: row.indexed,
              degraded: row.degraded,
              lastErrorCode: row.last_error_code,
              updatedAtMs: row.updated_at_ms,
            }
          : null
      })
    },

    aggregateActivity(range, now = new Date()): ClaudeCodeStats {
      const allTimeBounds = freshAllTimeBounds(now)
      const dailyRange = rangePredicate(
        range,
        now,
        'activity_daily.date',
        'activity_sources.mtime_ms',
      )
      const modelRange = rangePredicate(
        range,
        now,
        'activity_daily_models.date',
        'activity_sources.mtime_ms',
      )
      const sessionRange = rangePredicate(
        range,
        now,
        'date(activity_sessions.first_timestamp)',
        'activity_sources.mtime_ms',
      )
      const sourceMtimeRange = sourceMtimePredicate(
        range,
        now,
        'activity_sources.mtime_ms',
      )
      return database.read(operation => {
        const dailyActivity = operation.all<{
          date: string
          message_count: number
          session_count: number
          tool_call_count: number
        }>(`
          SELECT activity_daily.date AS date,
            SUM(activity_daily.message_count) AS message_count,
            COUNT(DISTINCT activity_sources.parent_session_id) AS session_count,
            SUM(activity_daily.tool_call_count) AS tool_call_count
          FROM activity_daily
          JOIN activity_sources ON activity_sources.path = activity_daily.transcript_path
          ${dailyRange.sql}
          GROUP BY activity_daily.date
          ORDER BY activity_daily.date ASC
        `, ...dailyRange.bindings).map<DailyActivity>(row => ({
          date: row.date,
          messageCount: row.message_count,
          sessionCount: row.session_count,
          toolCallCount: row.tool_call_count,
        }))

        const modelRows = operation.all<{
          date: string
          model: string
          input_tokens: number
          output_tokens: number
          cache_read_input_tokens: number
          cache_creation_input_tokens: number
          web_search_requests: number
          cost_usd: number
          context_window: number
          max_output_tokens: number
        }>(`
          SELECT activity_daily_models.date AS date,
            activity_daily_models.model AS model,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_input_tokens) AS cache_read_input_tokens,
            SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
            SUM(web_search_requests) AS web_search_requests,
            SUM(cost_usd) AS cost_usd,
            MAX(context_window) AS context_window,
            MAX(max_output_tokens) AS max_output_tokens
          FROM activity_daily_models
          JOIN activity_sources
            ON activity_sources.path = activity_daily_models.transcript_path
          ${modelRange.sql}
          GROUP BY activity_daily_models.date, activity_daily_models.model
          ORDER BY activity_daily_models.date ASC, activity_daily_models.model ASC
        `, ...modelRange.bindings)
        const dailyTokensMap = new Map<string, Record<string, number>>()
        const modelUsage: Record<string, ModelUsage> = {}
        for (const row of modelRows) {
          const tokens = row.input_tokens + row.output_tokens +
            row.cache_read_input_tokens + row.cache_creation_input_tokens
          if (tokens > 0) {
            const day = dailyTokensMap.get(row.date) ?? {}
            day[row.model] = tokens
            dailyTokensMap.set(row.date, day)
          }
          const aggregate = modelUsage[row.model] ?? emptyModelUsage()
          aggregate.inputTokens += row.input_tokens
          aggregate.outputTokens += row.output_tokens
          aggregate.cacheReadInputTokens += row.cache_read_input_tokens
          aggregate.cacheCreationInputTokens += row.cache_creation_input_tokens
          aggregate.webSearchRequests += row.web_search_requests
          aggregate.costUSD += row.cost_usd
          aggregate.contextWindow = Math.max(aggregate.contextWindow, row.context_window)
          aggregate.maxOutputTokens = Math.max(aggregate.maxOutputTokens, row.max_output_tokens)
          modelUsage[row.model] = aggregate
        }
        const dailyModelTokens: DailyModelTokens[] = [...dailyTokensMap]
          .map(([date, tokensByModel]) => ({ date, tokensByModel }))

        const toolRange = rangePredicate(
          range,
          now,
          'activity_daily_tools.date',
          'activity_sources.mtime_ms',
        )
        const toolUsage = Object.fromEntries(operation.all<{
          name: string
          count: number
        }>(`
          SELECT tool_name AS name, SUM(call_count) AS count
          FROM activity_daily_tools
          JOIN activity_sources
            ON activity_sources.path = activity_daily_tools.transcript_path
          ${toolRange.sql}
          GROUP BY tool_name
        `, ...toolRange.bindings).map(row => [row.name, row.count]))
        const skillRange = rangePredicate(
          range,
          now,
          'activity_daily_skills.date',
          'activity_sources.mtime_ms',
        )
        const skillUsage = Object.fromEntries(operation.all<{
          name: string
          count: number
        }>(`
          SELECT skill_name AS name, SUM(call_count) AS count
          FROM activity_daily_skills
          JOIN activity_sources
            ON activity_sources.path = activity_daily_skills.transcript_path
          ${skillRange.sql}
          GROUP BY skill_name
        `, ...skillRange.bindings).map(row => [row.name, row.count]))

        const sessionStats = operation.all<{
          session_id: string
          duration_ms: number
          message_count: number
          first_timestamp: string
          start_hour: number | null
          source_mtime_ms: number
        }>(`
          SELECT activity_sessions.session_id, activity_sessions.duration_ms,
            activity_sessions.message_count, activity_sessions.first_timestamp,
            activity_sessions.start_hour,
            activity_sources.mtime_ms AS source_mtime_ms
          FROM activity_sessions
          JOIN activity_sources
            ON activity_sources.path = activity_sessions.transcript_path
          ${sessionRange.sql}${sessionRange.sql ? ' AND' : ' WHERE'}
            activity_sources.is_subagent = 0
            AND activity_sessions.first_timestamp IS NOT NULL
          ORDER BY activity_sessions.first_timestamp ASC,
            activity_sessions.session_id ASC
        `, ...sessionRange.bindings)
        const sessions: SessionStats[] = sessionStats.map(row => ({
          sessionId: row.session_id,
          duration: row.duration_ms,
          messageCount: row.message_count,
          timestamp: row.first_timestamp,
        }))
        const hourCounts: Record<number, number> = {}
        for (const row of sessionStats) {
          if (row.start_hour === null) continue
          hourCounts[row.start_hour] = (hourCounts[row.start_hour] ?? 0) + 1
        }
        const sumSpeculation = (sql: string, bindings: number[] = []): number =>
          operation.get<{ total: number }>(`
            SELECT COALESCE(SUM(speculation_time_saved_ms), 0) AS total
            FROM activity_sessions
            JOIN activity_sources
              ON activity_sources.path = activity_sessions.transcript_path
            ${sql}
          `, ...bindings)?.total ?? 0
        const hasHistoricalActivity = range === 'all' &&
          (operation.get<{ present: number }>(`
            SELECT EXISTS(
              SELECT 1 FROM activity_daily WHERE date <= ? LIMIT 1
            ) AS present
          `, allTimeBounds.yesterday)?.present ?? 0) === 1
        const totalSpeculationTimeSavedMs = range === 'all'
          ? (hasHistoricalActivity ? sumSpeculation('') : 0) +
            sumSpeculation(
              'WHERE activity_sources.mtime_ms >= ?',
              [allTimeBounds.todayStartMs],
            )
          : sumSpeculation(sourceMtimeRange.sql, sourceMtimeRange.bindings)

        const readShotDistribution = (
          predicateSql: string,
          bindings: number[] = [],
        ): Record<number, number> => Object.fromEntries(operation.all<{
              shot_count: number
              session_count: number
            }>(`
              WITH ranked_shots AS (
                SELECT activity_sources.parent_session_id,
                  activity_sessions.shot_count,
                  ROW_NUMBER() OVER (
                    PARTITION BY activity_sources.parent_session_id
                    ORDER BY activity_sources.is_subagent ASC,
                      activity_sources.path ASC
                  ) AS source_rank
                FROM activity_sessions
                JOIN activity_sources
                  ON activity_sources.path = activity_sessions.transcript_path
                ${predicateSql}${predicateSql ? ' AND' : ' WHERE'}
                  activity_sessions.shot_count IS NOT NULL
              )
              SELECT shot_count, COUNT(*) AS session_count
              FROM ranked_shots
              WHERE source_rank = 1
              GROUP BY shot_count
              ORDER BY shot_count ASC
            `, ...bindings).map(row => [
              row.shot_count,
              row.session_count,
            ]))
        const shotDistribution = shotStatsEnabled
          ? range === 'all'
            ? (() => {
                const merged: Record<number, number> = hasHistoricalActivity
                  ? readShotDistribution('')
                  : {}
                for (const [shotCount, count] of Object.entries(
                  readShotDistribution(
                    'WHERE activity_sources.mtime_ms >= ?',
                    [allTimeBounds.todayStartMs],
                  ),
                )) {
                  const key = Number.parseInt(shotCount, 10)
                  merged[key] = (merged[key] ?? 0) + count
                }
                return merged
              })()
            : readShotDistribution(
                sourceMtimeRange.sql,
                sourceMtimeRange.bindings,
              )
          : undefined

        const processed: ProcessedStats = {
          dailyActivity,
          dailyModelTokens,
          modelUsage,
          toolUsage,
          skillUsage,
          sessionStats: sessions,
          hourCounts,
          totalMessages: sessions.reduce((sum, session) => sum + session.messageCount, 0),
          totalSpeculationTimeSavedMs,
          ...(shotDistribution ? { shotDistribution } : {}),
        }
        const result = processedStatsToClaudeCodeStats(processed, now, { shotStatsEnabled })
        if (range === 'all') {
          const todaySessions = sessionStats.filter(row =>
            row.source_mtime_ms >= allTimeBounds.todayStartMs &&
            new Date(row.first_timestamp).toISOString().slice(0, 10) ===
              allTimeBounds.today)
          result.lastSessionDate = todaySessions.reduce<string | null>(
            (latest, row) => !latest || row.first_timestamp > latest
              ? row.first_timestamp
              : latest,
            null,
          ) ?? dailyActivity.at(-1)?.date ?? null
          result.totalDays = result.firstSessionDate && result.lastSessionDate
            ? Math.ceil(
                (new Date(result.lastSessionDate).getTime() -
                  new Date(result.firstSessionDate).getTime()) /
                  (1000 * 60 * 60 * 24),
              ) + 1
            : 0
        }
        if (
          shotStatsEnabled &&
          (operation.get<{ present: number }>(`
            SELECT EXISTS(SELECT 1 FROM activity_sources LIMIT 1) AS present
          `)?.present ?? 0) === 0
        ) {
          delete result.shotDistribution
          delete result.oneShotRate
        }
        return result
      })
    },

    explainAggregatePlan(range, now = new Date()): string[] {
      const predicate = rangePredicate(
        range,
        now,
        'activity_daily.date',
        'activity_sources.mtime_ms',
      )
      return database.read(operation => operation.all<{ detail: string }>(`
        EXPLAIN QUERY PLAN
        SELECT activity_daily.date, SUM(activity_daily.message_count),
          COUNT(DISTINCT activity_sources.parent_session_id)
        FROM activity_daily
        JOIN activity_sources ON activity_sources.path = activity_daily.transcript_path
        ${predicate.sql}
        GROUP BY activity_daily.date
      `, ...predicate.bindings).map(row => row.detail))
    },
  }
}
