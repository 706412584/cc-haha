import { randomUUID } from 'node:crypto'
import type {
  TraceIndexDatabase,
  TraceIndexReadOperation,
  TraceIndexWriteOperation,
} from './traceDatabase.js'

export type TraceSourceInput = {
  sessionId: string
  filePath: string
  size: number
  mtimeMs: number
  indexedBytes: number
  fileIdentity?: string | null
  fingerprint?: string | null
  pendingTailBytes?: number
  nextOrdinal?: number
}

export type TraceCallLocator = {
  id: string
  ordinal: number
  /** First physical JSONL ordinal for this call ID; LWW locators keep it stable. */
  firstOrdinal?: number
  byteStart: number
  byteLength: number
  startedAt: string
  completedAt: string | null
  status: string
  source: string
  model: string | null
  durationMs: number | null
  failed: boolean
  inputTokens: number
  outputTokens: number
  revision?: number
}

export type TraceEventLocator = {
  id: string
  ordinal: number
  byteStart: number
  byteLength: number
  timestamp: string
  phase: string
  severity: string
  callId: string | null
  source: string | null
  model: string | null
  revision?: number
}

export type TraceProjectionSummary = {
  apiCalls: number
  failedCalls: number
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  models: Array<{ model: string; calls: number }>
  updatedAt: string | null
}

export type TraceSourceRecord = Required<Pick<
  TraceSourceInput,
  'sessionId' | 'filePath' | 'size' | 'mtimeMs' | 'indexedBytes'
>> & {
  fileIdentity: string | null
  fingerprint: string | null
  pendingTailBytes: number
  nextOrdinal: number
  revision: number
  lastResetRevision: number
  resetToken: string
  state: 'ready' | 'degraded'
  lastErrorCode: string | null
}

export type TraceSessionOverview = TraceSourceRecord & {
  summary: TraceProjectionSummary
}

export type TraceSessionProjection = TraceSessionOverview & {
  calls: TraceCallLocator[]
  events: TraceEventLocator[]
}

export type TraceIndexChanges = {
  sessionId: string
  revision: number
  reset: boolean
  calls: TraceCallLocator[]
  events: TraceEventLocator[]
}

export interface TraceIndex {
  getSource(sessionId: string): TraceSourceRecord | null
  getSummary(sessionId: string): TraceSessionOverview | null
  replaceSession(input: {
    source: TraceSourceInput
    calls: TraceCallLocator[]
    events: TraceEventLocator[]
  }): TraceSourceRecord
  appendEntries(input: {
    source: TraceSourceInput
    calls: TraceCallLocator[]
    events: TraceEventLocator[]
  }): TraceSourceRecord
  appendCall(input: {
    source: TraceSourceInput
    call: TraceCallLocator
  }): TraceSourceRecord
  appendEvent(input: {
    source: TraceSourceInput
    event: TraceEventLocator
  }): TraceSourceRecord
  getSession(sessionId: string): TraceSessionProjection | null
  getCallLocator(sessionId: string, callId: string): {
    source: TraceSourceRecord
    call: TraceCallLocator
  } | null
  getChanges(sessionId: string, sinceRevision: number): TraceIndexChanges | null
  listSessions(options?: {
    sessionIds?: string[]
    limit?: number
    offset?: number
  }): { sessions: TraceSessionOverview[]; total: number }
  markDegraded(sessionId: string, errorCode: string): void
  deleteSession(sessionId: string): void
}

type SourceRow = {
  session_id: string
  file_path: string
  size_bytes: number
  mtime_ms: number
  indexed_bytes: number
  file_identity: string | null
  fingerprint: string | null
  pending_tail_bytes: number
  revision: number
  last_reset_revision: number
  reset_token: string
  next_ordinal: number
  state: 'ready' | 'degraded'
  last_error_code: string | null
}

type SummaryRow = SourceRow & {
  api_calls: number
  failed_calls: number
  total_duration_ms: number
  total_input_tokens: number
  total_output_tokens: number
  summary_updated_at: string | null
}

type CallRow = {
  call_id: string
  ordinal: number
  first_ordinal: number
  byte_start: number
  byte_length: number
  revision: number
  started_at: string
  completed_at: string | null
  status: string
  source: string
  model: string | null
  duration_ms: number | null
  failed: number
  input_tokens: number
  output_tokens: number
}

type EventRow = {
  event_id: string
  ordinal: number
  byte_start: number
  byte_length: number
  revision: number
  timestamp: string
  phase: string
  severity: string
  call_id: string | null
  source: string | null
  model: string | null
}

const SOURCE_COLUMNS = `
  source.session_id,
  source.file_path,
  source.size_bytes,
  source.mtime_ms,
  source.indexed_bytes,
  source.file_identity,
  source.fingerprint,
  source.pending_tail_bytes,
  session.revision,
  session.last_reset_revision,
  session.reset_token,
  session.next_ordinal,
  source.state,
  source.last_error_code
`

const SUMMARY_COLUMNS = `
  ${SOURCE_COLUMNS},
  session.api_calls,
  session.failed_calls,
  session.total_duration_ms,
  session.total_input_tokens,
  session.total_output_tokens,
  session.summary_updated_at
`

const UPSERT_SOURCE_SQL = `
INSERT INTO trace_sources (
  session_id, file_path, size_bytes, mtime_ms, indexed_bytes,
  revision, last_reset_revision, state, last_error_code, updated_at_ms,
  file_identity, fingerprint, pending_tail_bytes
) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  file_path = excluded.file_path,
  size_bytes = excluded.size_bytes,
  mtime_ms = excluded.mtime_ms,
  indexed_bytes = excluded.indexed_bytes,
  revision = excluded.revision,
  last_reset_revision = excluded.last_reset_revision,
  state = 'ready',
  last_error_code = NULL,
  updated_at_ms = excluded.updated_at_ms,
  file_identity = excluded.file_identity,
  fingerprint = excluded.fingerprint,
  pending_tail_bytes = excluded.pending_tail_bytes
`

const UPSERT_SESSION_SQL = `
INSERT INTO trace_sessions (
  session_id, revision, last_reset_revision, reset_token, next_ordinal,
  api_calls, failed_calls, total_duration_ms,
  total_input_tokens, total_output_tokens, summary_updated_at
) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL)
ON CONFLICT(session_id) DO UPDATE SET
  revision = excluded.revision,
  last_reset_revision = excluded.last_reset_revision,
  reset_token = excluded.reset_token,
  next_ordinal = excluded.next_ordinal
`

const UPSERT_CALL_SQL = `
INSERT INTO trace_calls (
  session_id, call_id, ordinal, first_ordinal, byte_start, byte_length, revision,
  started_at, completed_at, status, source, model, duration_ms,
  failed, input_tokens, output_tokens
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, call_id) DO UPDATE SET
  ordinal = excluded.ordinal,
  byte_start = excluded.byte_start,
  byte_length = excluded.byte_length,
  revision = excluded.revision,
  started_at = excluded.started_at,
  completed_at = excluded.completed_at,
  status = excluded.status,
  source = excluded.source,
  model = excluded.model,
  duration_ms = excluded.duration_ms,
  failed = excluded.failed,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens
`

const INSERT_EVENT_SQL = `
INSERT INTO trace_events (
  session_id, ordinal, event_id, byte_start, byte_length, revision,
  timestamp, phase, severity, call_id, source, model
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, ordinal) DO UPDATE SET
  event_id = excluded.event_id,
  byte_start = excluded.byte_start,
  byte_length = excluded.byte_length,
  revision = excluded.revision,
  timestamp = excluded.timestamp,
  phase = excluded.phase,
  severity = excluded.severity,
  call_id = excluded.call_id,
  source = excluded.source,
  model = excluded.model
`

function sourceFromRow(row: SourceRow): TraceSourceRecord {
  return {
    sessionId: row.session_id,
    filePath: row.file_path,
    size: row.size_bytes,
    mtimeMs: row.mtime_ms,
    indexedBytes: row.indexed_bytes,
    fileIdentity: row.file_identity,
    fingerprint: row.fingerprint,
    pendingTailBytes: row.pending_tail_bytes,
    nextOrdinal: row.next_ordinal,
    revision: row.revision,
    lastResetRevision: row.last_reset_revision,
    resetToken: row.reset_token,
    state: row.state,
    lastErrorCode: row.last_error_code,
  }
}

function callFromRow(row: CallRow): TraceCallLocator {
  return {
    id: row.call_id,
    ordinal: row.ordinal,
    byteStart: row.byte_start,
    byteLength: row.byte_length,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    source: row.source,
    model: row.model,
    durationMs: row.duration_ms,
    failed: row.failed === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    revision: row.revision,
  }
}

function eventFromRow(row: EventRow): TraceEventLocator {
  return {
    id: row.event_id,
    ordinal: row.ordinal,
    byteStart: row.byte_start,
    byteLength: row.byte_length,
    timestamp: row.timestamp,
    phase: row.phase,
    severity: row.severity,
    callId: row.call_id,
    source: row.source,
    model: row.model,
    revision: row.revision,
  }
}

function readSource(
  operation: TraceIndexReadOperation,
  sessionId: string,
): TraceSourceRecord | null {
  const row = operation.get<SourceRow>(
    `SELECT ${SOURCE_COLUMNS}
     FROM trace_sources AS source
     JOIN trace_sessions AS session ON session.session_id = source.session_id
     WHERE source.session_id = ?`,
    sessionId,
  )
  return row ? sourceFromRow(row) : null
}

function modelsForSession(
  operation: TraceIndexReadOperation,
  sessionId: string,
): Array<{ model: string; calls: number }> {
  return operation.all<{ model: string; call_count: number }>(
    `SELECT model, call_count
     FROM trace_session_models
     WHERE session_id = ?
     ORDER BY first_started_at, first_ordinal, model`,
    sessionId,
  ).map(row => ({ model: row.model, calls: row.call_count }))
}

function overviewFromRow(
  operation: TraceIndexReadOperation,
  row: SummaryRow,
): TraceSessionOverview {
  return {
    ...sourceFromRow(row),
    summary: {
      apiCalls: row.api_calls,
      failedCalls: row.failed_calls,
      totalDurationMs: row.total_duration_ms,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      models: modelsForSession(operation, row.session_id),
      updatedAt: row.summary_updated_at,
    },
  }
}

function readOverview(
  operation: TraceIndexReadOperation,
  sessionId: string,
): TraceSessionOverview | null {
  const row = operation.get<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS}
     FROM trace_sources AS source
     JOIN trace_sessions AS session ON session.session_id = source.session_id
     WHERE source.session_id = ?`,
    sessionId,
  )
  return row ? overviewFromRow(operation, row) : null
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function resolvedNextOrdinal(
  source: TraceSourceInput,
  calls: TraceCallLocator[],
  events: TraceEventLocator[],
  floor = 0,
): number {
  const derived = Math.max(
    floor,
    ...calls.map(call => call.ordinal + 1),
    ...events.map(event => event.ordinal + 1),
  )
  return source.nextOrdinal ?? derived
}

function normalizeSource(
  source: TraceSourceInput,
  nextOrdinal: number,
): Required<Omit<TraceSourceInput, 'fileIdentity' | 'fingerprint'>> & {
  fileIdentity: string | null
  fingerprint: string | null
} {
  const pendingTailBytes = source.pendingTailBytes ?? source.size - source.indexedBytes
  if (
    !safeInteger(source.size) ||
    !safeInteger(source.indexedBytes) ||
    source.indexedBytes > source.size ||
    !safeInteger(pendingTailBytes) ||
    pendingTailBytes !== source.size - source.indexedBytes ||
    !safeInteger(nextOrdinal) ||
    !Number.isFinite(source.mtimeMs)
  ) {
    throw new Error('Invalid trace source progress')
  }
  return {
    ...source,
    fileIdentity: source.fileIdentity ?? null,
    fingerprint: source.fingerprint ?? null,
    pendingTailBytes,
    nextOrdinal,
  }
}

function validateLocator(
  locator: Pick<TraceCallLocator | TraceEventLocator, 'ordinal' | 'byteStart' | 'byteLength'>,
  source: ReturnType<typeof normalizeSource>,
): void {
  const end = locator.byteStart + locator.byteLength
  if (
    !safeInteger(locator.ordinal) ||
    locator.ordinal >= source.nextOrdinal ||
    !safeInteger(locator.byteStart) ||
    !safeInteger(locator.byteLength) ||
    locator.byteLength < 1 ||
    !Number.isSafeInteger(end) ||
    end > source.indexedBytes
  ) {
    throw new Error('Invalid trace locator')
  }
}

function writeSource(
  operation: TraceIndexWriteOperation,
  sourceInput: TraceSourceInput,
  revision: number,
  lastResetRevision: number,
  resetToken: string,
  nextOrdinal: number,
): ReturnType<typeof normalizeSource> {
  const source = normalizeSource(sourceInput, nextOrdinal)
  operation.run(
    UPSERT_SOURCE_SQL,
    source.sessionId,
    source.filePath,
    source.size,
    source.mtimeMs,
    source.indexedBytes,
    revision,
    lastResetRevision,
    Date.now(),
    source.fileIdentity,
    source.fingerprint,
    source.pendingTailBytes,
  )
  operation.run(
    UPSERT_SESSION_SQL,
    source.sessionId,
    revision,
    lastResetRevision,
    resetToken,
    source.nextOrdinal,
  )
  return source
}

function writeCall(
  operation: TraceIndexWriteOperation,
  sessionId: string,
  call: TraceCallLocator,
  revision: number,
): void {
  const firstOrdinal = call.firstOrdinal ?? call.ordinal
  if (!safeInteger(firstOrdinal) || firstOrdinal > call.ordinal) {
    throw new Error('Invalid trace call insertion order')
  }
  operation.run(
    UPSERT_CALL_SQL,
    sessionId,
    call.id,
    call.ordinal,
    firstOrdinal,
    call.byteStart,
    call.byteLength,
    revision,
    call.startedAt,
    call.completedAt,
    call.status,
    call.source,
    call.model,
    call.durationMs,
    call.failed ? 1 : 0,
    call.inputTokens,
    call.outputTokens,
  )
}

function writeEvent(
  operation: TraceIndexWriteOperation,
  sessionId: string,
  event: TraceEventLocator,
  revision: number,
): void {
  operation.run(
    INSERT_EVENT_SQL,
    sessionId,
    event.ordinal,
    event.id,
    event.byteStart,
    event.byteLength,
    revision,
    event.timestamp,
    event.phase,
    event.severity,
    event.callId,
    event.source,
    event.model,
  )
}

function adjustModelCount(
  operation: TraceIndexWriteOperation,
  sessionId: string,
  model: string | null,
  delta: number,
): void {
  if (!model || delta === 0) return
  if (delta > 0) {
    operation.run(
      `INSERT INTO trace_session_models (
         session_id, model, call_count, first_started_at, first_ordinal
       )
       VALUES (?, ?, ?, '', 0)
       ON CONFLICT(session_id, model) DO UPDATE SET
         call_count = trace_session_models.call_count + excluded.call_count`,
      sessionId,
      model,
      delta,
    )
    return
  }
  operation.run(
    `UPDATE trace_session_models
     SET call_count = call_count + ?
     WHERE session_id = ? AND model = ?`,
    delta,
    sessionId,
    model,
  )
  operation.run(
    `DELETE FROM trace_session_models
     WHERE session_id = ? AND model = ? AND call_count <= 0`,
    sessionId,
    model,
  )
}

function recomputeModelOrder(
  operation: TraceIndexWriteOperation,
  sessionId: string,
  model: string | null,
): void {
  if (!model) return
  operation.run(
    `UPDATE trace_session_models
     SET
       first_started_at = COALESCE((
         SELECT call.started_at
         FROM trace_calls AS call
         WHERE call.session_id = ? AND call.model = ?
         ORDER BY call.started_at, call.first_ordinal
         LIMIT 1
       ), ''),
       first_ordinal = COALESCE((
         SELECT call.first_ordinal
         FROM trace_calls AS call
         WHERE call.session_id = ? AND call.model = ?
         ORDER BY call.started_at, call.first_ordinal
         LIMIT 1
       ), 0)
     WHERE session_id = ? AND model = ?`,
    sessionId,
    model,
    sessionId,
    model,
    sessionId,
    model,
  )
}

function updateSummaryForCall(
  operation: TraceIndexWriteOperation,
  sessionId: string,
  previous: CallRow | null,
  next: TraceCallLocator,
): void {
  operation.run(
    `UPDATE trace_sessions SET
       api_calls = api_calls + ?,
       failed_calls = failed_calls + ?,
       total_duration_ms = total_duration_ms + ?,
       total_input_tokens = total_input_tokens + ?,
       total_output_tokens = total_output_tokens + ?
     WHERE session_id = ?`,
    previous ? 0 : 1,
    (next.failed ? 1 : 0) - (previous?.failed ?? 0),
    (next.durationMs ?? 0) - (previous?.duration_ms ?? 0),
    next.inputTokens - (previous?.input_tokens ?? 0),
    next.outputTokens - (previous?.output_tokens ?? 0),
    sessionId,
  )
  if (previous?.model !== next.model) {
    adjustModelCount(operation, sessionId, previous?.model ?? null, -1)
    adjustModelCount(operation, sessionId, next.model, 1)
  } else if (!previous) {
    adjustModelCount(operation, sessionId, next.model, 1)
  }
  recomputeModelOrder(operation, sessionId, previous?.model ?? null)
  recomputeModelOrder(operation, sessionId, next.model)
  operation.run(
    `UPDATE trace_sessions
     SET summary_updated_at = (
       SELECT COALESCE(completed_at, started_at)
       FROM trace_calls
       WHERE session_id = ?
       ORDER BY started_at DESC, first_ordinal DESC
       LIMIT 1
     )
     WHERE session_id = ?`,
    sessionId,
    sessionId,
  )
}

function resetSummary(operation: TraceIndexWriteOperation, sessionId: string): void {
  operation.run(
    `UPDATE trace_sessions SET
       api_calls = 0,
       failed_calls = 0,
       total_duration_ms = 0,
       total_input_tokens = 0,
       total_output_tokens = 0,
       summary_updated_at = NULL
     WHERE session_id = ?`,
    sessionId,
  )
  operation.run('DELETE FROM trace_session_models WHERE session_id = ?', sessionId)
}

function locatorRows(
  operation: TraceIndexReadOperation,
  sessionId: string,
  revisionFloor?: number,
): { calls: TraceCallLocator[]; events: TraceEventLocator[] } {
  const revisionWhere = revisionFloor === undefined ? '' : ' AND revision > ?'
  const bindings = revisionFloor === undefined
    ? [sessionId] as const
    : [sessionId, revisionFloor] as const
  return {
    calls: operation.all<CallRow>(
      `SELECT * FROM trace_calls
       WHERE session_id = ?${revisionWhere}
       ORDER BY started_at, first_ordinal`,
      ...bindings,
    ).map(callFromRow),
    events: operation.all<EventRow>(
      `SELECT * FROM trace_events WHERE session_id = ?${revisionWhere} ORDER BY timestamp, ordinal`,
      ...bindings,
    ).map(eventFromRow),
  }
}

function replaceProjection(
  database: TraceIndexDatabase,
  input: {
    source: TraceSourceInput
    calls: TraceCallLocator[]
    events: TraceEventLocator[]
  },
): TraceSourceRecord {
  return database.transaction(operation => {
    const current = readSource(operation, input.source.sessionId)
    const revision = (current?.revision ?? 0) + 1
    const nextOrdinal = resolvedNextOrdinal(input.source, input.calls, input.events)
    const source = writeSource(
      operation,
      input.source,
      revision,
      revision,
      randomUUID(),
      nextOrdinal,
    )
    operation.run('DELETE FROM trace_calls WHERE session_id = ?', source.sessionId)
    operation.run('DELETE FROM trace_events WHERE session_id = ?', source.sessionId)
    resetSummary(operation, source.sessionId)
    for (const call of input.calls) {
      validateLocator(call, source)
      writeCall(operation, source.sessionId, call, revision)
      updateSummaryForCall(operation, source.sessionId, null, call)
    }
    for (const event of input.events) {
      validateLocator(event, source)
      writeEvent(operation, source.sessionId, event, revision)
    }
    return readSource(operation, source.sessionId)!
  })
}

function appendProjection(
  database: TraceIndexDatabase,
  input: {
    source: TraceSourceInput
    calls: TraceCallLocator[]
    events: TraceEventLocator[]
  },
): TraceSourceRecord {
  return database.transaction(operation => {
    const current = readSource(operation, input.source.sessionId)
    const revision = (current?.revision ?? 0) + 1
    const nextOrdinal = resolvedNextOrdinal(
      input.source,
      input.calls,
      input.events,
      current?.nextOrdinal ?? 0,
    )
    const source = writeSource(
      operation,
      input.source,
      revision,
      current?.lastResetRevision ?? revision,
      current?.resetToken ?? randomUUID(),
      nextOrdinal,
    )
    for (const call of input.calls) {
      validateLocator(call, source)
      const previous = operation.get<CallRow>(
        'SELECT * FROM trace_calls WHERE session_id = ? AND call_id = ?',
        source.sessionId,
        call.id,
      )
      writeCall(operation, source.sessionId, call, revision)
      updateSummaryForCall(operation, source.sessionId, previous, call)
    }
    for (const event of input.events) {
      validateLocator(event, source)
      writeEvent(operation, source.sessionId, event, revision)
    }
    return readSource(operation, source.sessionId)!
  })
}

export function createTraceIndex(database: TraceIndexDatabase): TraceIndex {
  return {
    getSource(sessionId) {
      return database.read(operation => readSource(operation, sessionId))
    },
    getSummary(sessionId) {
      return database.read(operation => readOverview(operation, sessionId))
    },
    replaceSession(input) {
      return replaceProjection(database, input)
    },
    appendEntries(input) {
      return appendProjection(database, input)
    },
    appendCall(input) {
      return appendProjection(database, {
        source: input.source,
        calls: [input.call],
        events: [],
      })
    },
    appendEvent(input) {
      return appendProjection(database, {
        source: input.source,
        calls: [],
        events: [input.event],
      })
    },
    getSession(sessionId) {
      return database.read(operation => {
        const overview = readOverview(operation, sessionId)
        if (!overview) return null
        return { ...overview, ...locatorRows(operation, sessionId) }
      })
    },
    getCallLocator(sessionId, callId) {
      return database.read(operation => {
        const source = readSource(operation, sessionId)
        if (!source) return null
        const row = operation.get<CallRow>(
          'SELECT * FROM trace_calls WHERE session_id = ? AND call_id = ?',
          sessionId,
          callId,
        )
        return row ? { source, call: callFromRow(row) } : null
      })
    },
    getChanges(sessionId, sinceRevision) {
      return database.read(operation => {
        const source = readSource(operation, sessionId)
        if (!source) return null
        const reset = sinceRevision < source.lastResetRevision
        const rows = locatorRows(operation, sessionId, reset ? undefined : sinceRevision)
        return {
          sessionId,
          revision: source.revision,
          reset,
          ...rows,
        }
      })
    },
    listSessions(options) {
      const offset = Math.max(0, Math.trunc(options?.offset ?? 0))
      const limit = Math.max(0, Math.trunc(options?.limit ?? 50))
      return database.read(operation => {
        const ids = options?.sessionIds ?? []
        const where = ids.length > 0
          ? ` WHERE source.session_id IN (${ids.map(() => '?').join(', ')})`
          : ''
        const count = operation.get<{ total: number }>(
          `SELECT COUNT(*) AS total
           FROM trace_sources AS source
           JOIN trace_sessions AS session ON session.session_id = source.session_id${where}`,
          ...ids,
        )?.total ?? 0
        const rows = operation.all<SummaryRow>(
          `SELECT ${SUMMARY_COLUMNS}
           FROM trace_sources AS source
           JOIN trace_sessions AS session ON session.session_id = source.session_id${where}
           ORDER BY source.mtime_ms DESC, source.session_id
           LIMIT ? OFFSET ?`,
          ...ids,
          limit,
          offset,
        )
        return {
          sessions: rows.map(row => overviewFromRow(operation, row)),
          total: count,
        }
      })
    },
    markDegraded(sessionId, errorCode) {
      database.write(operation => {
        operation.run(
          `UPDATE trace_sources
           SET state = 'degraded', last_error_code = ?, updated_at_ms = ?
           WHERE session_id = ?`,
          errorCode,
          Date.now(),
          sessionId,
        )
      })
    },
    deleteSession(sessionId) {
      database.write(operation => {
        operation.run('DELETE FROM trace_sources WHERE session_id = ?', sessionId)
      })
    },
  }
}
