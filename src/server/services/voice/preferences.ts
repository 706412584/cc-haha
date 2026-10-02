import {
  DEFAULT_VOICE_PREFERENCES,
  type VoiceDownloadSource,
  type VoiceLanguage,
  type VoicePreferences,
} from './types.js'

export const VOICE_LANGUAGES: readonly VoiceLanguage[] = ['auto', 'zh', 'en', 'ja', 'ko', 'yue']
export const VOICE_DOWNLOAD_SOURCES: readonly VoiceDownloadSource[] = ['auto', 'official', 'mirror']

const MAX_PROVIDER_ID_LENGTH = 80

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return typeof value === 'string' && (VOICE_LANGUAGES as readonly string[]).includes(value)
}

/**
 * Lenient read-side normalization for the `voiceInput` section of
 * desktop-ui.json. Unknown fields are kept so a newer build's data survives a
 * round trip through an older one.
 */
export function isVoiceDownloadSource(value: unknown): value is VoiceDownloadSource {
  return typeof value === 'string' && (VOICE_DOWNLOAD_SOURCES as readonly string[]).includes(value)
}

export function normalizeVoicePreferences(value: unknown): VoicePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_VOICE_PREFERENCES }
  }
  const record = value as Record<string, unknown>
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
  return {
    ...record,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_VOICE_PREFERENCES.enabled,
    providerId: providerId.length > 0 && providerId.length <= MAX_PROVIDER_ID_LENGTH
      ? providerId
      : DEFAULT_VOICE_PREFERENCES.providerId,
    language: isVoiceLanguage(record.language) ? record.language : DEFAULT_VOICE_PREFERENCES.language,
    // Absent in files written before the source picker existed: those read as `auto`.
    downloadSource: isVoiceDownloadSource(record.downloadSource)
      ? record.downloadSource
      : DEFAULT_VOICE_PREFERENCES.downloadSource,
  }
}
