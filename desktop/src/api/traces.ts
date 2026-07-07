import { api } from './client'
import type { TraceCaptureSettings, TraceSessionDeleteResult, TraceSessionList } from '../types/trace'

export const tracesApi = {
  list(options?: { limit?: number; offset?: number; query?: string }) {
    const params = new URLSearchParams()
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    if (options?.offset !== undefined) params.set('offset', String(options.offset))
    if (options?.query) params.set('q', options.query)
    const suffix = params.toString() ? `?${params}` : ''
    return api.get<TraceSessionList>(`/api/traces${suffix}`)
  },

  getSettings() {
    return api.get<TraceCaptureSettings>('/api/traces/settings')
  },

  updateSettings(settings: Partial<Pick<TraceCaptureSettings, 'enabled'>>) {
    return api.put<TraceCaptureSettings>('/api/traces/settings', settings)
  },

  deleteSession(sessionId: string) {
    return api.delete<TraceSessionDeleteResult>(`/api/traces/${encodeURIComponent(sessionId)}`)
  },
}
