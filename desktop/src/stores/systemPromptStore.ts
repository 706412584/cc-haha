import { create } from 'zustand'
import { systemPromptApi, type SystemPromptResponse } from '../api/systemPrompt'

/**
 * Ownership counters for in-flight requests.
 *
 * Same shape as `orchestrationPromptStore`: every fetch and every mutation
 * takes a ticket, and a response only lands while its ticket is still the
 * newest one. Without this a slow GET that resolves after the user already
 * saved would repaint the editor with the pre-save text.
 */
let fetchRequest = 0
let mutationRequest = 0

export type SystemPromptState = {
  /** Null until the first successful load — also how the UI tells load from save failures. */
  data: SystemPromptResponse | null
  /** The text in the editor, before any save. */
  draft: string
  isLoading: boolean
  isSaving: boolean
  error: string | null
  lastSavedAt: string | null

  fetch: () => Promise<void>
  updateDraft: (text: string) => void
  save: () => Promise<boolean>
  resetToDefault: () => Promise<boolean>
}

export const useSystemPromptStore = create<SystemPromptState>((set, get) => ({
  data: null,
  draft: '',
  isLoading: false,
  isSaving: false,
  error: null,
  lastSavedAt: null,

  fetch: async () => {
    const request = ++fetchRequest
    set({ isLoading: true, error: null })
    try {
      const data = await systemPromptApi.get()
      if (request !== fetchRequest) return
      const current = get()
      // A refresh must not throw away text the user has typed but not saved.
      const wasDirty = current.data
        ? current.draft !== (current.data.custom ?? current.data.default)
        : false
      set({
        data,
        isLoading: false,
        // With no override the editor seeds from the built-in snapshot so the
        // user has a starting point; if the server could not build one it stays
        // empty rather than clobbering a draft.
        ...(wasDirty
          ? {}
          : { draft: data.custom ?? data.default }),
      })
    } catch (err) {
      if (request !== fetchRequest) return
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  updateDraft: (text) => set({ draft: text }),

  save: async () => {
    const { data, draft, isSaving } = get()
    if (!data || isSaving) return false
    // Mirrors the server's 400s so an invalid save never leaves the client.
    if (draft.trim().length === 0 || draft.length > data.maxChars) return false
    const request = ++mutationRequest
    set({ isSaving: true, error: null })
    try {
      const result = await systemPromptApi.save(draft)
      // A newer mutation owns `isSaving` now; this response is stale.
      if (request !== mutationRequest) return false
      set((state) => {
        if (!state.data) return { isSaving: false }
        return {
          // `custom` takes the saved text while `draft` is left alone, so an
          // editor that kept receiving keystrokes stays dirty against the server.
          data: {
            ...state.data,
            custom: result.isCustom ? draft : null,
            isCustom: result.isCustom,
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
    const { data, isSaving } = get()
    if (!data || isSaving) return false
    const request = ++mutationRequest
    set({ isSaving: true, error: null })
    try {
      await systemPromptApi.reset()
      if (request !== mutationRequest) return false
      set((state) => {
        if (!state.data) return { isSaving: false }
        // The editor follows back to the built-in snapshot so the panel never
        // shows an override the server no longer has.
        return {
          data: { ...state.data, custom: null, isCustom: false },
          draft: state.data.default,
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
 * Whether the editor holds text that differs from what the server has.
 *
 * Derived rather than stored: `draft` and `data` are already in state, and a
 * third field kept in sync by hand is one more place to forget.
 */
export function selectIsDirty(state: SystemPromptState): boolean {
  if (!state.data) return false
  return state.draft !== (state.data.custom ?? state.data.default)
}
