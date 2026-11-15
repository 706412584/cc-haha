/**
 * TEMPORARY diagnostic probe for the "another session's messages appear in this
 * session" report. It records a bounded ring of session-attributed events so a
 * single reproduction can say which session's `messages` array received the
 * foreign rows — and from where (WebSocket intake, history apply, paging,
 * collaboration replay, or a tab-switch restore).
 *
 * Read it back in DevTools with:
 *   __ccSessionTrace            (live array)
 *   copy(dumpSessionTrace())    (JSON string, paste-ready)
 *   clearSessionTrace()
 *
 * Remove this file and its call sites once the bug is fixed.
 */

export type SessionTraceEntry = {
  t: number
  kind: string
  sessionId: string
  detail?: Record<string, unknown>
}

const MAX_ENTRIES = 2000
const entries: SessionTraceEntry[] = []
type LayoutMetric =
  | 'rowObserverCallbacks'
  | 'rowObserverEntries'
  | 'listWidthObserverCallbacks'
  | 'contentObserverCallbacks'
  | 'touchViewportObserverCallbacks'
  | 'heightCacheChanges'
  | 'flushSyncCount'
  | 'flushSyncTotalMs'
  | 'flushSyncMaxMs'
type PendingLayoutFrame = {
  sessionId: string
  detail: Partial<Record<LayoutMetric, number>>
}
const pendingLayoutFrames = new Map<string, PendingLayoutFrame>()
const MAX_PENDING_LAYOUT_SESSIONS = 32
let layoutFrameRequest: number | null = null

type TraceGlobal = typeof globalThis & {
  __ccSessionTrace?: SessionTraceEntry[]
  dumpSessionTrace?: () => string
  clearSessionTrace?: () => void
}

function installGlobals() {
  if (typeof window === 'undefined') return
  const target = window as TraceGlobal
  target.__ccSessionTrace = entries
  target.dumpSessionTrace = () => JSON.stringify(entries, null, 1)
  target.clearSessionTrace = resetSessionTrace
}

installGlobals()

/** First ~60 chars of a UI message's visible text, for eyeballing provenance. */
export function messageSnippet(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const record = message as { type?: string; content?: unknown; toolName?: string }
  const text = typeof record.content === 'string' ? record.content : ''
  const prefix = record.toolName ? `[${record.toolName}] ` : ''
  return (prefix + text).replace(/\s+/g, ' ').slice(0, 60)
}

function flushLayoutFrames(): void {
  layoutFrameRequest = null
  for (const frame of pendingLayoutFrames.values()) {
    traceSession('layout.frame', frame.sessionId, frame.detail)
  }
  pendingLayoutFrames.clear()
}

export function traceLayoutMetric(
  sessionId: string | null | undefined,
  metric: LayoutMetric,
  value = 1,
): void {
  if (typeof window === 'undefined') return
  const resolvedSessionId = sessionId ?? '(none)'
  if (!pendingLayoutFrames.has(resolvedSessionId) && pendingLayoutFrames.size >= MAX_PENDING_LAYOUT_SESSIONS) return
  const frame = pendingLayoutFrames.get(resolvedSessionId) ?? {
    sessionId: resolvedSessionId,
    detail: {},
  }
  frame.detail[metric] = metric === 'flushSyncMaxMs'
    ? Math.max(frame.detail[metric] ?? 0, value)
    : (frame.detail[metric] ?? 0) + value
  pendingLayoutFrames.set(resolvedSessionId, frame)
  if (layoutFrameRequest === null) {
    layoutFrameRequest = window.requestAnimationFrame(flushLayoutFrames)
  }
}

export function traceSession(
  kind: string,
  sessionId: string | null | undefined,
  detail?: Record<string, unknown>,
): void {
  if (typeof window === 'undefined') return
  if (entries.length >= MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES + 1)
  entries.push({ t: Date.now(), kind, sessionId: sessionId ?? '(none)', detail })
}

/** Test seam: module-level state would otherwise leak between cases. */
export function resetSessionTrace(): void {
  entries.length = 0
  pendingLayoutFrames.clear()
  if (layoutFrameRequest !== null) {
    window.cancelAnimationFrame(layoutFrameRequest)
    layoutFrameRequest = null
  }
}
