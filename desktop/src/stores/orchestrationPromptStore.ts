import { create } from 'zustand'
import {
  orchestrationPromptsApi,
  type OrchestrationMode,
  type OrchestrationPromptEntry,
} from '../api/orchestrationPrompts'

/** The three orchestration switches, in the order the composer `+` menu lists them. */
export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = ['coordinator', 'solo', 're']

/** Matches the server ceiling so an unloaded store still blocks absurd input. */
const DEFAULT_MAX_CHARS = 200_000

/**
 * Ownership counters for in-flight requests.
 *
 * Same shape as `memoryStore`: every fetch and every mutation takes a ticket,
 * and a response only lands while its ticket is still the newest one. Without
 * this a slow GET that resolves after the user already saved would repaint the
 * editor with the pre-save text.
 */
let fetchRequest = 0
let mutationRequest = 0

export type OrchestrationPromptState = {
  /** Null until the first successful load — also how the UI tells load from save failures. */
  prompts: Record<OrchestrationMode, OrchestrationPromptEntry> | null
  selectedMode: OrchestrationMode
  /** The text in the editor for `selectedMode`, before any save. */
  draft: string
  maxChars: number
  isLoading: boolean
  isSaving: boolean
  error: string | null
  lastSavedAt: string | null

  fetch: () => Promise<void>
  selectMode: (mode: OrchestrationMode) => void
  updateDraft: (text: string) => void
  save: () => Promise<boolean>
  resetToDefault: () => Promise<boolean>
}

export const useOrchestrationPromptStore = create<OrchestrationPromptState>((set, get) => ({
  prompts: null,
  selectedMode: 'coordinator',
  draft: '',
  maxChars: DEFAULT_MAX_CHARS,
  isLoading: false,
  isSaving: false,
  error: null,
  lastSavedAt: null,

  fetch: async () => {
    const request = ++fetchRequest
    set({ isLoading: true, error: null })
    try {
      const { prompts, maxChars } = await orchestrationPromptsApi.get()
      if (request !== fetchRequest) return
      const current = get()
      const mode = current.selectedMode
      // A refresh must not throw away text the user has typed but not saved.
      const wasDirty = current.prompts
        ? current.draft !== current.prompts[mode].effective
        : false
      set({
        prompts,
        maxChars,
        isLoading: false,
        ...(wasDirty ? {} : { draft: prompts[mode].effective }),
      })
    } catch (err) {
      if (request !== fetchRequest) return
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  selectMode: (mode) => {
    if (get().selectedMode === mode) return
    const { prompts } = get()
    set({
      selectedMode: mode,
      // One editor at a time: switching loads that mode's effective text, which
      // discards an unsaved draft of the previous mode.
      draft: prompts ? prompts[mode].effective : '',
      error: null,
      lastSavedAt: null,
    })
  },

  updateDraft: (text) => set({ draft: text }),

  save: async () => {
    const { prompts, selectedMode, draft, isSaving, maxChars } = get()
    if (!prompts || isSaving) return false
    // Mirrors the server's 400s so an invalid save never leaves the client.
    if (draft.trim().length === 0 || draft.length > maxChars) return false
    const request = ++mutationRequest
    const mode = selectedMode
    const text = draft
    set({ isSaving: true, error: null })
    try {
      const result = await orchestrationPromptsApi.save(mode, text)
      // A newer mutation owns `isSaving` now; this response is stale.
      if (request !== mutationRequest) return false
      set((state) => {
        if (!state.prompts) return { isSaving: false }
        const entry = state.prompts[mode]
        // `isCustom` comes from the server, which treats a whitespace-only body
        // as a reset — so the echoed value is what decides, not the request.
        return {
          // Applied to the mode that was saved, not the one on screen: the write
          // landed, so the badge has to reflect it even if the user moved on.
          // `effective` takes the saved text while `draft` is left alone, so an
          // editor that kept receiving keystrokes stays dirty against the server.
          prompts: {
            ...state.prompts,
            [mode]: result.isCustom
              ? { ...entry, custom: text, effective: text, isCustom: true }
              : { ...entry, custom: null, effective: entry.default, isCustom: false },
          },
          isSaving: false,
          lastSavedAt: new Date().toISOString(),
        }
      })
      return true
    } catch (err) {
      if (request !== mutationRequest) return false
      set({ error: (err as Error).message, isSaving: false })
      return false
    }
  },

  resetToDefault: async () => {
    const { prompts, selectedMode, isSaving } = get()
    if (!prompts || isSaving) return false
    const request = ++mutationRequest
    const mode = selectedMode
    set({ isSaving: true, error: null })
    try {
      await orchestrationPromptsApi.reset(mode)
      if (request !== mutationRequest) return false
      set((state) => {
        if (!state.prompts) return { isSaving: false }
        const entry = state.prompts[mode]
        return {
          prompts: {
            ...state.prompts,
            [mode]: { ...entry, custom: null, effective: entry.default, isCustom: false },
          },
          // The editor follows the mode back to its built-in text, so the panel
          // never shows an override the server no longer has — but only when the
          // user is still looking at that mode.
          ...(state.selectedMode === mode ? { draft: entry.default } : {}),
          isSaving: false,
          lastSavedAt: new Date().toISOString(),
        }
      })
      return true
    } catch (err) {
      if (request !== mutationRequest) return false
      set({ error: (err as Error).message, isSaving: false })
      return false
    }
  },
}))

/**
 * Whether the editor holds text that differs from the mode's effective prompt.
 *
 * Derived rather than stored: `draft` and `prompts` are already in state, and a
 * third field kept in sync by hand is one more place to forget.
 */
export function selectIsDirty(state: OrchestrationPromptState): boolean {
  if (!state.prompts) return false
  return state.draft !== state.prompts[state.selectedMode].effective
}
