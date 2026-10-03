import { ApiError, api, getApiUrl, getAuthToken } from './client'

/**
 * Wire types mirror `src/server/services/voice/types.ts`. Keep them in sync;
 * the server's `contractParity.test.ts` pins them against each other.
 */
export type VoiceLanguage = 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'

export type VoiceDownloadSource = 'auto' | 'official' | 'mirror'

export type VoicePreparationPhase = 'unprepared' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'cancelled'
export type VoicePreparationStep = 'runtime' | 'model' | 'vad' | 'verify'
export type VoiceFailureReason =
  | 'network'
  | 'dns'
  | 'timeout'
  | 'certificate'
  | 'http'
  | 'integrity'
  | 'storage'
  | 'unsupported-platform'
  | 'unknown'

export type VoiceFailure = {
  reason: VoiceFailureReason
  source?: string
  status?: number
  resource?: string
  message: string
}

export type VoicePreparationState = {
  phase: VoicePreparationPhase
  step?: VoicePreparationStep
  resource?: string
  completedBytes?: number
  totalBytes?: number
  resumedFromBytes?: number
  source?: string
  error?: VoiceFailure
}

export type VoiceProviderInfo = {
  id: string
  name: string
  location: 'local' | 'cloud'
  languages: VoiceLanguage[]
  downloadBytes?: number
}

export type VoiceProviderStatus = {
  info: VoiceProviderInfo
  preparation: VoicePreparationState
}

export type VoicePreferences = {
  enabled: boolean
  providerId: string
  language: VoiceLanguage
  downloadSource: VoiceDownloadSource
}

export type VoiceLimits = {
  maxAudioSeconds: number
  maxAudioBytes: number
}

export type VoiceCatalog = {
  supported: boolean
  providers: VoiceProviderStatus[]
  preferences: VoicePreferences
  limits: VoiceLimits
}

export type VoiceTranscript = {
  text: string
  audioSeconds: number
  inferenceSeconds: number
}

export type VoiceErrorCode = 'voice/invalid-audio' | 'voice/not-ready' | 'voice/failed' | 'voice/unknown-provider'

export const voiceApi = {
  catalog: () => api.get<VoiceCatalog>('/api/voice/catalog'),

  updatePreferences: (patch: Partial<VoicePreferences>) =>
    api.put<{ preferences: VoicePreferences }>('/api/voice/preferences', patch),

  /** Starts (or joins) the download for a provider; poll `providerStatus` for progress. */
  prepare: (providerId: string) =>
    api.post<VoiceProviderStatus>(`/api/voice/providers/${encodeURIComponent(providerId)}/prepare`),

  cancelPrepare: (providerId: string) =>
    api.post<VoiceProviderStatus>(`/api/voice/providers/${encodeURIComponent(providerId)}/cancel`),

  providerStatus: (providerId: string) =>
    api.get<VoiceProviderStatus>(`/api/voice/providers/${encodeURIComponent(providerId)}/status`),

  /** Deletes downloaded runtime and models for a provider. */
  removeAssets: (providerId: string) =>
    api.delete<VoiceProviderStatus>(`/api/voice/providers/${encodeURIComponent(providerId)}/assets`),

  /** Uploads a 16 kHz mono PCM16 WAV as the raw request body. */
  async transcribe(
    wav: Blob,
    options: { providerId: string; language: VoiceLanguage; signal?: AbortSignal },
  ): Promise<VoiceTranscript> {
    const headers: Record<string, string> = { 'Content-Type': 'audio/wav' }
    const token = getAuthToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const query = new URLSearchParams({ provider: options.providerId, language: options.language })
    const res = await fetch(getApiUrl(`/api/voice/transcribe?${query}`), {
      method: 'POST',
      headers,
      body: wav,
      signal: options.signal,
    })
    if (!res.ok) {
      // Read the body once: a proxy error page is not JSON, and a second read would throw.
      const text = await res.text().catch(() => '')
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // Keep the raw text.
      }
      throw new ApiError(res.status, body)
    }
    return res.json() as Promise<VoiceTranscript>
  },
}
