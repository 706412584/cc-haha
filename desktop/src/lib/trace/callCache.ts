import { sessionsApi } from '../../api/sessions'
import { getBaseUrl } from '../../api/client'
import type { TraceCallRecord } from '../../types/trace'

const callCache = new Map<string, TraceCallRecord>()
const TRACE_CALL_CACHE_MAX_ENTRIES = 32

export async function fetchTraceCallDetail(
  sessionId: string,
  callId: string,
  revisionKey?: string,
): Promise<TraceCallRecord | null> {
  const prefix = `${getBaseUrl()}\0${sessionId}\0${callId}\0`
  const key = `${prefix}${revisionKey ?? 'legacy'}`
  const cached = callCache.get(key)
  if (cached) {
    callCache.delete(key)
    callCache.set(key, cached)
    return cached
  }
  for (const existingKey of callCache.keys()) {
    if (existingKey.startsWith(prefix)) callCache.delete(existingKey)
  }
  try {
    const result = await sessionsApi.getTraceCall(sessionId, callId)
    const call = result?.call
    if (!call) return null
    if (isTerminalCall(call)) {
      callCache.set(key, call)
      while (callCache.size > TRACE_CALL_CACHE_MAX_ENTRIES) {
        const oldestKey = callCache.keys().next().value
        if (oldestKey === undefined) break
        callCache.delete(oldestKey)
      }
    }
    return call
  } catch {
    return null
  }
}

export function clearTraceCallCache(): void {
  callCache.clear()
}

function isTerminalCall(call: TraceCallRecord): boolean {
  if (call.status === 'ok' || call.status === 'error') return true
  if (call.status === 'pending') return false
  return Boolean(call.response || call.error)
}
