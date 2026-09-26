import { api } from './client'

/** The three per-session orchestration switches exposed in the composer `+` menu. */
export type OrchestrationMode = 'coordinator' | 'solo' | 're'

/**
 * One mode's prompt in all three states: the built-in text, the user's override
 * (null while none is stored) and whichever of the two the runtime will use.
 */
export type OrchestrationPromptEntry = {
  default: string
  custom: string | null
  effective: string
  isCustom: boolean
}

export type OrchestrationPromptsResponse = {
  prompts: Record<OrchestrationMode, OrchestrationPromptEntry>
  /** Server-side ceiling for a stored override, in characters. */
  maxChars: number
}

/**
 * The server reports the state that actually resulted rather than echoing the
 * request: a whitespace-only body is treated as a reset, so `isCustom` can come
 * back false even from a PUT.
 */
export type OrchestrationPromptSaveResponse = {
  ok: true
  mode: OrchestrationMode
  isCustom: boolean
}

export type OrchestrationPromptResetResponse = {
  ok: true
  mode: OrchestrationMode
  isCustom: false
}

export const orchestrationPromptsApi = {
  get() {
    return api.get<OrchestrationPromptsResponse>('/api/orchestration-prompts')
  },

  save(mode: OrchestrationMode, text: string) {
    return api.put<OrchestrationPromptSaveResponse>(`/api/orchestration-prompts/${mode}`, { text })
  },

  /** Drop the override so the mode falls back to its built-in prompt. */
  reset(mode: OrchestrationMode) {
    return api.delete<OrchestrationPromptResetResponse>(`/api/orchestration-prompts/${mode}`)
  },
}
