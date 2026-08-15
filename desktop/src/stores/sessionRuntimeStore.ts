import { create } from 'zustand'
import type { RuntimeSelection } from '../types/runtime'
import type { SessionListItem } from '../types/session'
import {
  GROK_OFFICIAL_DEFAULT_MODEL_ID,
  GROK_OFFICIAL_MODELS,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'
import { normalizeRuntimeSelection } from '../lib/runtimeSelection'

const STORAGE_KEY = 'cc-haha-session-runtime'
const COORDINATOR_STORAGE_KEY = 'cc-haha-session-coordinator'
const SOLO_PIPELINE_STORAGE_KEY = 'cc-haha-session-solo-pipeline'
/** Persisted pipeline flavor map (non-normal only). Migrates old boolean map. */
const PIPELINE_MODE_STORAGE_KEY = 'cc-haha-session-pipeline-mode'

export type PipelineModeFlavor = 'solo' | 're' | 'normal'
const HANDOFF_STORAGE_KEY = 'cc-haha-session-handoff'
const RETIRED_GROK_MODEL_IDS = new Set([
  'grok-build',
  'grok-build-0.1',
  'grok-4.3',
  'grok-4.20-reasoning',
  'grok-4.20-non-reasoning',
])

export const DRAFT_RUNTIME_SELECTION_KEY = '__draft__'

/**
 * Per-session record of where the hand-off context came from. Set by the
 * "Continue from here" flow when it succeeds in attaching a previous
 * session's summary to this session's CLI launch. Used to render a small
 * "↗ continued from..." chip in the chat header so the user remembers
 * (and trusts) that the AI has prior context.
 *
 * `approxTokens` is a frontend-side estimate (chars / 4) — not authoritative,
 * but enough to give the user a feel for how big the hand-off addendum is.
 * The exact tokens are also counted server-side as part of the system
 * prompt category in ContextUsageIndicator.
 */
export type SessionHandoffInfo = {
  previousSessionId: string
  /** Title of the previous session at hand-off time (snapshotted, may drift). */
  previousSessionTitle: string
  approxTokens: number
  /** ISO timestamp from the SessionSummary, for staleness display. */
  generatedAt: string
}

type SessionRuntimeStore = {
  selections: Record<string, RuntimeSelection>
  /** Per-session orchestration ("协调") mode toggle. Absent/false = off. */
  coordinatorModes: Record<string, boolean>
  /**
   * Per-session pipeline flavor. Absent / missing = `'normal'` (off).
   * Values are only `'solo' | 're'` when enabled. Mutually exclusive with
   * `coordinatorModes` at the chatStore action layer; the raw runtime
   * store stays orthogonal for simple persistence.
   */
  pipelineModes: Record<string, Exclude<PipelineModeFlavor, 'normal'>>
  /**
   * @deprecated Derived convenience: `pipelineModes[id] === 'solo'`.
   * Prefer `pipelineModes` / `getPipelineMode`.
   */
  soloPipelineModes: Record<string, boolean>
  /** Per-session hand-off context info. Absent = no hand-off attached. */
  handoffInfo: Record<string, SessionHandoffInfo>
  setSelection: (key: string, selection: RuntimeSelection) => void
  clearSelection: (key: string) => void
  moveSelection: (fromKey: string, toKey: string) => void
  setCoordinatorMode: (key: string, enabled: boolean) => void
  setPipelineMode: (key: string, flavor: PipelineModeFlavor) => void
  setSoloPipelineMode: (key: string, enabled: boolean) => void
  setHandoffInfo: (key: string, info: SessionHandoffInfo) => void
  clearHandoffInfo: (key: string) => void
  syncFromSessions: (sessions: SessionListItem[]) => void
}

function toSoloBooleanMap(
  modes: Record<string, Exclude<PipelineModeFlavor, 'normal'>>,
  previousSolo: Record<string, boolean> = {},
): Record<string, boolean> {
  // Preserve keys that were previously tracked as Solo so callers that read
  // `soloPipelineModes[id] === false` (legacy off) keep working. Keys that
  // never existed stay absent (normal default).
  const out: Record<string, boolean> = {}
  for (const key of Object.keys(previousSolo)) {
    out[key] = false
  }
  for (const [key, flavor] of Object.entries(modes)) {
    if (flavor === 'solo') out[key] = true
    else if (key in out) out[key] = false
  }
  return out
}

function normalizeSelection(selection: RuntimeSelection): RuntimeSelection | null {
  const normalizedSelection = normalizeRuntimeSelection(selection)
  if (
    normalizedSelection.providerId === null &&
    normalizedSelection.modelId.trim().toLowerCase() === 'opus[1m]'
  ) {
    // Older builds persisted the dynamic Claude default as an explicit model.
    // Drop only that Claude Official sentinel so the OAuth subscription tier
    // can resolve the current default. Third-party `[1m]` model ids stay intact.
    return null
  }
  if (
    normalizedSelection.providerId !== GROK_OFFICIAL_PROVIDER_ID ||
    !RETIRED_GROK_MODEL_IDS.has(normalizedSelection.modelId)
  ) {
    return normalizedSelection
  }

  const fallback = GROK_OFFICIAL_MODELS.find(
    (model) => model.id === GROK_OFFICIAL_DEFAULT_MODEL_ID,
  )
  return {
    providerId: GROK_OFFICIAL_PROVIDER_ID,
    modelId: GROK_OFFICIAL_DEFAULT_MODEL_ID,
    ...(fallback?.defaultReasoningEffort
      ? { effortLevel: fallback.defaultReasoningEffort }
      : {}),
  }
}

function normalizeSelections(
  selections: Record<string, RuntimeSelection>,
): { selections: Record<string, RuntimeSelection>; changed: boolean } {
  let changed = false
  const normalized: Record<string, RuntimeSelection> = {}
  for (const [key, selection] of Object.entries(selections)) {
    const next = normalizeSelection(selection)
    if (!next) {
      changed = true
      continue
    }
    if (next !== selection) changed = true
    normalized[key] = next
  }
  return { selections: normalized, changed }
}

function loadSelections(): Record<string, RuntimeSelection> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, RuntimeSelection>
    if (!parsed || typeof parsed !== 'object') return {}
    const normalized = normalizeSelections(parsed)
    if (normalized.changed) persistSelections(normalized.selections)
    return normalized.selections
  } catch {
    return {}
  }
}

function persistSelections(selections: Record<string, RuntimeSelection>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selections))
  } catch {
    // noop
  }
}

function loadCoordinatorModes(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(COORDINATOR_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, boolean>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persistCoordinatorModes(modes: Record<string, boolean>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(COORDINATOR_STORAGE_KEY, JSON.stringify(modes))
  } catch {
    // noop
  }
}

function loadPipelineModes(): Record<string, Exclude<PipelineModeFlavor, 'normal'>> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const rawNew = localStorage.getItem(PIPELINE_MODE_STORAGE_KEY)
    if (rawNew) {
      const parsed = JSON.parse(rawNew) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object') return {}
      const out: Record<string, Exclude<PipelineModeFlavor, 'normal'>> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (value === 'solo' || value === 're') out[key] = value
      }
      return out
    }
    // Migrate legacy boolean Solo map → flavor map
    const rawLegacy = localStorage.getItem(SOLO_PIPELINE_STORAGE_KEY)
    if (!rawLegacy) return {}
    const parsed = JSON.parse(rawLegacy) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, Exclude<PipelineModeFlavor, 'normal'>> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true) out[key] = 'solo'
    }
    if (Object.keys(out).length > 0) persistPipelineModes(out)
    return out
  } catch {
    return {}
  }
}

function persistPipelineModes(
  modes: Record<string, Exclude<PipelineModeFlavor, 'normal'>>,
) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PIPELINE_MODE_STORAGE_KEY, JSON.stringify(modes))
    // Keep legacy key in sync for older builds during rollout.
    localStorage.setItem(
      SOLO_PIPELINE_STORAGE_KEY,
      JSON.stringify(toSoloBooleanMap(modes)),
    )
  } catch {
    // noop
  }
}

function loadHandoffInfo(): Record<string, SessionHandoffInfo> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(HANDOFF_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, SessionHandoffInfo>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persistHandoffInfo(info: Record<string, SessionHandoffInfo>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(info))
  } catch {
    // noop
  }
}

export const useSessionRuntimeStore = create<SessionRuntimeStore>((set) => {
  const initialPipelineModes = loadPipelineModes()
  return {
  selections: loadSelections(),
  coordinatorModes: loadCoordinatorModes(),
  pipelineModes: initialPipelineModes,
  soloPipelineModes: toSoloBooleanMap(initialPipelineModes),
  handoffInfo: loadHandoffInfo(),

  setSelection: (key, selection) =>
    set((state) => {
      const normalized = normalizeSelection(selection)
      const selections = { ...state.selections }
      if (normalized) selections[key] = normalized
      else delete selections[key]
      persistSelections(selections)
      return { selections }
    }),

  clearSelection: (key) =>
    set((state) => {
      const hadSelection = key in state.selections
      const hadCoordinator = key in state.coordinatorModes
      const hadPipeline = key in state.pipelineModes
      const hadHandoff = key in state.handoffInfo
      if (!hadSelection && !hadCoordinator && !hadPipeline && !hadHandoff) return state

      const next: Partial<SessionRuntimeStore> = {}
      if (hadSelection) {
        const { [key]: _removed, ...rest } = state.selections
        persistSelections(rest)
        next.selections = rest
      }
      if (hadCoordinator) {
        const { [key]: _removed, ...rest } = state.coordinatorModes
        persistCoordinatorModes(rest)
        next.coordinatorModes = rest
      }
      if (hadPipeline) {
        const { [key]: _removed, ...rest } = state.pipelineModes
        persistPipelineModes(rest)
        next.pipelineModes = rest
        next.soloPipelineModes = toSoloBooleanMap(rest)
      }
      if (hadHandoff) {
        const { [key]: _removed, ...rest } = state.handoffInfo
        persistHandoffInfo(rest)
        next.handoffInfo = rest
      }
      return next
    }),

  moveSelection: (fromKey, toKey) =>
    set((state) => {
      const selection = state.selections[fromKey]
      const coordinator = state.coordinatorModes[fromKey]
      const pipeline = state.pipelineModes[fromKey]
      const handoff = state.handoffInfo[fromKey]
      if (!selection && coordinator === undefined && pipeline === undefined && !handoff) return state

      const next: Partial<SessionRuntimeStore> = {}
      if (selection) {
        const { [fromKey]: _removed, ...rest } = state.selections
        next.selections = { ...rest, [toKey]: selection }
        persistSelections(next.selections)
      }
      if (coordinator !== undefined) {
        const { [fromKey]: _removed, ...rest } = state.coordinatorModes
        next.coordinatorModes = { ...rest, [toKey]: coordinator }
        persistCoordinatorModes(next.coordinatorModes)
      }
      if (pipeline !== undefined) {
        const { [fromKey]: _removed, ...rest } = state.pipelineModes
        next.pipelineModes = { ...rest, [toKey]: pipeline }
        persistPipelineModes(next.pipelineModes)
        next.soloPipelineModes = toSoloBooleanMap(next.pipelineModes)
      }
      if (handoff) {
        const { [fromKey]: _removed, ...rest } = state.handoffInfo
        next.handoffInfo = { ...rest, [toKey]: handoff }
        persistHandoffInfo(next.handoffInfo)
      }
      return next
    }),

  setCoordinatorMode: (key, enabled) =>
    set((state) => {
      if ((state.coordinatorModes[key] ?? false) === enabled) return state
      const coordinatorModes = { ...state.coordinatorModes, [key]: enabled }
      persistCoordinatorModes(coordinatorModes)
      return { coordinatorModes }
    }),

  setPipelineMode: (key, flavor) =>
    set((state) => {
      const current = state.pipelineModes[key]
      const currentFlavor: PipelineModeFlavor = current ?? 'normal'
      if (currentFlavor === flavor) return state
      const pipelineModes = { ...state.pipelineModes }
      if (flavor === 'normal') {
        delete pipelineModes[key]
      } else {
        pipelineModes[key] = flavor
      }
      persistPipelineModes(pipelineModes)
      const previousSolo = { ...state.soloPipelineModes }
      if (flavor === 'normal' || flavor === 're') {
        // Explicitly mark this key as non-solo for legacy boolean readers.
        previousSolo[key] = false
      }
      return {
        pipelineModes,
        soloPipelineModes: toSoloBooleanMap(pipelineModes, previousSolo),
      }
    }),

  setSoloPipelineMode: (key, enabled) =>
    set((state) => {
      const nextFlavor: PipelineModeFlavor = enabled ? 'solo' : 'normal'
      const current = state.pipelineModes[key]
      const currentFlavor: PipelineModeFlavor = current ?? 'normal'
      if (currentFlavor === nextFlavor) return state
      const pipelineModes = { ...state.pipelineModes }
      if (nextFlavor === 'normal') {
        delete pipelineModes[key]
      } else {
        pipelineModes[key] = nextFlavor
      }
      persistPipelineModes(pipelineModes)
      const previousSolo = { ...state.soloPipelineModes, [key]: enabled }
      return {
        pipelineModes,
        soloPipelineModes: toSoloBooleanMap(pipelineModes, previousSolo),
      }
    }),

  setHandoffInfo: (key, info) =>
    set((state) => {
      const handoffInfo = { ...state.handoffInfo, [key]: info }
      persistHandoffInfo(handoffInfo)
      return { handoffInfo }
    }),

  clearHandoffInfo: (key) =>
    set((state) => {
      if (!(key in state.handoffInfo)) return state
      const { [key]: _removed, ...handoffInfo } = state.handoffInfo
      persistHandoffInfo(handoffInfo)
      return { handoffInfo }
    }),

  syncFromSessions: (sessions) =>
    set((state) => {
      let selections = state.selections
      for (const session of sessions) {
        if (!session.runtimeModelId || session.runtimeProviderId === undefined) continue
        const selection = normalizeSelection({
          providerId: session.runtimeProviderId,
          modelId: session.runtimeModelId,
          ...(session.effortLevel ? { effortLevel: session.effortLevel } : {}),
          ...(session.thinkingEnabled !== undefined
            ? { thinkingEnabled: session.thinkingEnabled }
            : {}),
        })
        if (!selection) {
          if (!(session.id in selections)) continue
          if (selections === state.selections) selections = { ...state.selections }
          delete selections[session.id]
          continue
        }
        const current = selections[session.id]
        if (
          current?.providerId === selection.providerId &&
          current.modelId === selection.modelId &&
          current.effortLevel === selection.effortLevel &&
          current.thinkingEnabled === selection.thinkingEnabled
        ) {
          continue
        }
        if (selections === state.selections) selections = { ...state.selections }
        selections[session.id] = selection
      }
      if (selections === state.selections) return state
      persistSelections(selections)
      return { selections }
    }),
  }
})
