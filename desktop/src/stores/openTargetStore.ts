import { create } from 'zustand'
import { openTargetsApi, type OpenTarget } from '../api/openTargets'

export type { OpenTarget } from '../api/openTargets'

const CLIENT_CACHE_TTL_MS = 60_000

const OPEN_TARGET_PREFERENCES_STORAGE_KEY = 'cc-haha-open-target-preferences'

/**
 * Stored as an object from the first version even though it holds one field.
 * Losing it costs nothing — the menu falls back to the first detected editor —
 * but writing a bare string would force a migration the day a second preference
 * shows up, and this shape absorbs that for free.
 */
type OpenTargetPreferences = {
  version: 1
  editorTargetId: string | null
}

const DEFAULT_PREFERENCES: OpenTargetPreferences = { version: 1, editorTargetId: null }

export function readOpenTargetPreferences(): OpenTargetPreferences {
  try {
    const raw = localStorage.getItem(OPEN_TARGET_PREFERENCES_STORAGE_KEY)
    if (!raw) return DEFAULT_PREFERENCES
    const parsed = JSON.parse(raw) as Partial<OpenTargetPreferences>
    return {
      version: 1,
      editorTargetId: typeof parsed?.editorTargetId === 'string' ? parsed.editorTargetId : null,
    }
  } catch {
    // Unavailable, or written by a shape we no longer understand. Either way the
    // preference is regenerable, so a bad read is not worth surfacing.
    return DEFAULT_PREFERENCES
  }
}

function writeOpenTargetPreferences(preferences: OpenTargetPreferences): void {
  try {
    localStorage.setItem(OPEN_TARGET_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch { /* localStorage unavailable */ }
}

type OpenTargetState = {
  targets: OpenTarget[]
  platform: string | null
  primaryTargetId: string | null
  lastSuccessfulTargetId: string | null
  /**
   * Which editor gets the single slot in the open-with menu. Null means "the
   * first one detected" — a stable answer, unlike the last one used.
   */
  editorTargetId: string | null
  loading: boolean
  error: string | null
  fetchedAt: number
  ensureTargets: () => Promise<void>
  refreshTargets: () => Promise<void>
  getTargetsForPath: (path: string) => Promise<OpenTarget[]>
  openTarget: (targetId: string, path: string) => Promise<void>
  setEditorTargetId: (targetId: string | null) => void
}

function choosePrimaryTarget(targets: OpenTarget[], apiPrimary: string | null, lastSuccessful: string | null) {
  if (lastSuccessful && targets.some((target) => target.id === lastSuccessful)) return lastSuccessful
  if (apiPrimary && targets.some((target) => target.id === apiPrimary)) return apiPrimary
  return targets[0]?.id ?? null
}

export const useOpenTargetStore = create<OpenTargetState>((set, get) => ({
  targets: [],
  platform: null,
  primaryTargetId: null,
  lastSuccessfulTargetId: null,
  editorTargetId: readOpenTargetPreferences().editorTargetId,
  loading: false,
  error: null,
  fetchedAt: 0,

  setEditorTargetId: (targetId) => {
    writeOpenTargetPreferences({ version: 1, editorTargetId: targetId })
    set({ editorTargetId: targetId })
  },

  ensureTargets: async () => {
    const state = get()
    if (state.loading) return
    if (state.fetchedAt > 0 && Date.now() - state.fetchedAt < CLIENT_CACHE_TTL_MS) return
    await get().refreshTargets()
  },

  refreshTargets: async () => {
    set({ loading: true, error: null })
    try {
      const result = await openTargetsApi.list()
      const primaryTargetId = choosePrimaryTarget(
        result.targets,
        result.primaryTargetId,
        get().lastSuccessfulTargetId,
      )
      set({
        targets: result.targets,
        platform: result.platform,
        primaryTargetId,
        fetchedAt: Date.now(),
        loading: false,
        error: null,
      })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  getTargetsForPath: async (path) => {
    const result = await openTargetsApi.listForPath(path)
    return result.targets
  },

  openTarget: async (targetId, path) => {
    try {
      await openTargetsApi.open(targetId, path)
      set({ lastSuccessfulTargetId: targetId, primaryTargetId: targetId, error: null })
    } catch (error) {
      await get().refreshTargets()
      set({ error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  },
}))
