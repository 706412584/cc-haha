import { api } from './client'

/**
 * The main system-prompt override in all its states: the user's replacement
 * (null while the built-in is in effect), the built-in static snapshot offered
 * as a starting point, and the server ceiling for a stored override.
 *
 * Distinct from the orchestration prompts endpoint: those three are per-mode
 * ADDENDA, this one REPLACES the base system prompt via `--system-prompt-file`.
 */
export type SystemPromptResponse = {
  custom: string | null
  isCustom: boolean
  /**
   * The built-in prompt's STATIC sections (intro, rules, tools, tone), for the
   * "load built-in default" button. Empty when the server could not build it.
   * It excludes the dynamic sections (environment, memory, skills, language) —
   * those are recomputed per session and cannot be snapshotted.
   */
  default: string
  maxChars: number
}

export type SystemPromptSaveResponse = {
  ok: true
  /** The state that actually resulted; a whitespace-only body resets it. */
  isCustom: boolean
}

export const systemPromptApi = {
  get() {
    return api.get<SystemPromptResponse>('/api/system-prompt')
  },

  save(text: string) {
    return api.put<SystemPromptSaveResponse>('/api/system-prompt', { text })
  },

  /** Drop the override so the session falls back to the built-in prompt. */
  reset() {
    return api.delete<SystemPromptSaveResponse>('/api/system-prompt')
  },
}
