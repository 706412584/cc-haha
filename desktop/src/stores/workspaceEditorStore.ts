import { create } from 'zustand'
import {
  sessionsApi,
  type WorkspaceLspConfigInput,
  type WorkspaceLspDiagnosticsResult,
  type WorkspaceLspSyncInput,
} from '../api/sessions'
import type { WorkspaceLspState } from '../types/lsp'
import { useSettingsStore } from './settingsStore'

/**
 * Layer 2b of the workspace: the editable-buffer and LSP slices.
 *
 * `workspaceContentStore` owns what the server sent; this store owns what the
 * user has typed on top of it, plus the language-server state that only exists
 * while a file is open in the editor. Keeping the two apart is what lets a
 * read-only surface (`CodeSurface`) render straight from the content cache
 * while the editor rebases against its own baseline.
 *
 * Everything is keyed by `sessionId::path`, the same identity the content
 * cache uses, so a tab id never leaks into a buffer and a file reopened from
 * another entry point finds its edits again.
 */

export type WorkspaceFileEncoding = 'utf-8' | 'utf-8-bom'
export type WorkspaceFileLineEnding = 'LF' | 'CRLF' | 'CR'

export type WorkspaceConflictSource = 'user' | 'agent'

export type WorkspaceBufferConflict = {
  source: WorkspaceConflictSource
  hash: string
  timestamp: number
  actor?: string
}

/**
 * Editable-buffer state for one open file.
 *
 * `baseHash` / `baseContent` capture the snapshot the editor opened with.
 * `currentContent` tracks the in-memory edits. `conflict` is set when the file
 * changed underneath us — a save from another window (`source: 'user'`) or an
 * agent edit observed on the chat tool stream (`source: 'agent'`).
 */
export type WorkspaceBufferState = {
  key: string
  path: string
  baseHash: string
  baseContent: string
  currentContent: string
  isDirty: boolean
  encoding: WorkspaceFileEncoding
  lineEnding: WorkspaceFileLineEnding
  conflict: WorkspaceBufferConflict | null
}

export type WorkspaceBufferInit = Omit<
  WorkspaceBufferState,
  'currentContent' | 'isDirty' | 'conflict'
>

export type WorkspaceExternalSavePayload = {
  source: WorkspaceConflictSource
  hash: string
  timestamp: number
  actor?: string
  content?: string
}

/**
 * Sentinel hash for agent edits. Agent writes arrive through the chat tool
 * stream with no content hash, so this value can never equal a real base hash
 * and the conflict banner is guaranteed to surface.
 */
export const AGENT_EDIT_SENTINEL_HASH = 'agent-edit'

type WorkspaceEditorStore = {
  buffersByKey: Record<string, WorkspaceBufferState | undefined>
  /** Files the editor cannot open (non-UTF-8 family); the tab stays read-only. */
  unsupportedKeys: Record<string, true | undefined>
  lspStateBySession: Record<string, WorkspaceLspState | undefined>
  lspDiagnosticsBySessionPath: Record<string, WorkspaceLspDiagnosticsResult | undefined>

  bufferKey: (sessionId: string, path: string) => string
  getBuffer: (sessionId: string, path: string) => WorkspaceBufferState | undefined
  isUnsupported: (sessionId: string, path: string) => boolean
  markUnsupported: (sessionId: string, path: string) => void

  initBuffer: (init: WorkspaceBufferInit) => void
  setBufferState: (key: string, content: string) => void
  applyExternalSave: (key: string, event: WorkspaceExternalSavePayload) => void
  acknowledgeConflict: (key: string, action: 'reload' | 'keepMine' | 'openConflict') => void
  dropBuffer: (key: string) => void
  clearSession: (sessionId: string) => void

  /** React to an agent file edit observed on the chat tool stream. */
  notifyAgentFileEdit: (sessionId: string, absolutePath: string) => void

  syncLsp: (sessionId: string, input: WorkspaceLspSyncInput) => Promise<void>
  loadLspState: (sessionId: string, path?: string) => Promise<void>
  loadLspDiagnostics: (sessionId: string, path: string, refresh?: boolean) => Promise<void>
  restartLsp: (sessionId: string, path: string) => Promise<void>
}

const lspStateRequests = new Map<string, number>()
const lspDiagnosticRequests = new Map<string, number>()

function nextRequest(store: Map<string, number>, key: string) {
  const requestId = (store.get(key) ?? 0) + 1
  store.set(key, requestId)
  return requestId
}

function isLatestRequest(store: Map<string, number>, key: string, requestId: number) {
  return store.get(key) === requestId
}

export function workspaceBufferKey(sessionId: string, path: string) {
  return `${sessionId}::${path}`
}

/** Normalize for agent-edit suffix matching: forward slashes, no trailing slash. */
function normalizeAgentEditPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Whether an agent's (absolute) edited path refers to the same file as an open
 * buffer's (workspace-relative) path. Matching is by suffix on a normalized
 * segment boundary so `foo/bar.ts` never matches `otherbar.ts`.
 */
function agentEditMatchesBufferPath(normalizedAbs: string, bufferPath: string): boolean {
  const normalizedBuffer = normalizeAgentEditPath(bufferPath)
  if (normalizedAbs === normalizedBuffer) return true
  return normalizedAbs.endsWith(`/${normalizedBuffer}`)
}

function resolveWorkspaceLspConfig(): WorkspaceLspConfigInput | undefined {
  try {
    const config = useSettingsStore.getState().workspaceLsp
    return config.server ? config : undefined
  } catch {
    return undefined
  }
}

function withoutPrefix<T>(record: Record<string, T>, prefix: string) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith(prefix)),
  ) as Record<string, T>
}

export const useWorkspaceEditorStore = create<WorkspaceEditorStore>()((set, get) => ({
  buffersByKey: {},
  unsupportedKeys: {},
  lspStateBySession: {},
  lspDiagnosticsBySessionPath: {},

  bufferKey: (sessionId, path) => workspaceBufferKey(sessionId, path),
  getBuffer: (sessionId, path) => get().buffersByKey[workspaceBufferKey(sessionId, path)],
  isUnsupported: (sessionId, path) => Boolean(get().unsupportedKeys[workspaceBufferKey(sessionId, path)]),
  markUnsupported: (sessionId, path) =>
    set((state) => ({
      unsupportedKeys: { ...state.unsupportedKeys, [workspaceBufferKey(sessionId, path)]: true },
    })),

  initBuffer: (init) =>
    set((state) => ({
      buffersByKey: {
        ...state.buffersByKey,
        [init.key]: {
          ...init,
          currentContent: init.baseContent,
          isDirty: false,
          conflict: null,
        },
      },
    })),

  setBufferState: (key, content) =>
    set((state) => {
      const existing = state.buffersByKey[key]
      if (!existing) return state
      return {
        buffersByKey: {
          ...state.buffersByKey,
          [key]: {
            ...existing,
            currentContent: content,
            isDirty: content !== existing.baseContent,
          },
        },
      }
    }),

  applyExternalSave: (key, event) =>
    set((state) => {
      const existing = state.buffersByKey[key]
      if (!existing) return state
      // Same hash as our base — an echo of our own save, nothing to do.
      if (event.hash === existing.baseHash) return state

      // Clean buffer: silently rebase when the new content came along.
      if (!existing.isDirty && typeof event.content === 'string') {
        return {
          buffersByKey: {
            ...state.buffersByKey,
            [key]: {
              ...existing,
              baseHash: event.hash,
              baseContent: event.content,
              currentContent: event.content,
              isDirty: false,
              conflict: null,
            },
          },
        }
      }

      // Dirty buffer, or a clean one with no content to rebase onto.
      return {
        buffersByKey: {
          ...state.buffersByKey,
          [key]: {
            ...existing,
            conflict: {
              source: event.source,
              hash: event.hash,
              timestamp: event.timestamp,
              ...(event.actor ? { actor: event.actor } : {}),
            },
          },
        },
      }
    }),

  acknowledgeConflict: (key, action) =>
    set((state) => {
      const existing = state.buffersByKey[key]
      if (!existing?.conflict) return state

      // 'reload' clears the conflict and the dirty marker; the caller refetches
      // and re-inits the buffer with fresh base content.
      // 'keepMine' clears the conflict but keeps the buffer dirty so the next
      // save overwrites (accepting a stale-base 409).
      // 'openConflict' is a UI-routing action: the store only dismisses the
      // banner so the caller can drive a side-by-side view.
      if (action === 'reload') {
        return {
          buffersByKey: {
            ...state.buffersByKey,
            [key]: {
              ...existing,
              currentContent: existing.baseContent,
              isDirty: false,
              conflict: null,
            },
          },
        }
      }

      return {
        buffersByKey: { ...state.buffersByKey, [key]: { ...existing, conflict: null } },
      }
    }),

  dropBuffer: (key) =>
    set((state) => {
      if (!(key in state.buffersByKey)) return state
      const buffersByKey = { ...state.buffersByKey }
      delete buffersByKey[key]
      return { buffersByKey }
    }),

  clearSession: (sessionId) =>
    set((state) => ({
      buffersByKey: withoutPrefix(state.buffersByKey, `${sessionId}::`),
      unsupportedKeys: withoutPrefix(state.unsupportedKeys, `${sessionId}::`),
      lspStateBySession: withoutPrefix(state.lspStateBySession, `${sessionId}::`),
      lspDiagnosticsBySessionPath: withoutPrefix(state.lspDiagnosticsBySessionPath, `${sessionId}::`),
    })),

  notifyAgentFileEdit: (sessionId, absolutePath) => {
    const normalizedAbs = normalizeAgentEditPath(absolutePath)
    set((state) => {
      let changed = false
      const buffersByKey = { ...state.buffersByKey }
      for (const [key, buffer] of Object.entries(state.buffersByKey)) {
        if (!buffer) continue
        if (!key.startsWith(`${sessionId}::`)) continue
        if (!agentEditMatchesBufferPath(normalizedAbs, buffer.path)) continue
        // Already showing a conflict — never clobber the one on screen.
        if (buffer.conflict) continue
        changed = true
        buffersByKey[key] = {
          ...buffer,
          conflict: {
            source: 'agent',
            hash: AGENT_EDIT_SENTINEL_HASH,
            timestamp: Date.now(),
          },
        }
      }
      return changed ? { buffersByKey } : state
    })
  },

  loadLspState: async (sessionId, path) => {
    const requestKey = path ? `${sessionId}::${path}` : sessionId
    const requestId = nextRequest(lspStateRequests, requestKey)
    try {
      const result = await sessionsApi.getWorkspaceLspState(sessionId, path, resolveWorkspaceLspConfig())
      if (!isLatestRequest(lspStateRequests, requestKey, requestId)) return
      set((state) => ({
        lspStateBySession: { ...state.lspStateBySession, [sessionId]: result.state },
      }))
    } catch (error) {
      if (!isLatestRequest(lspStateRequests, requestKey, requestId)) return
      set((state) => ({
        lspStateBySession: {
          ...state.lspStateBySession,
          [sessionId]: {
            state: 'unavailable',
            path: path ?? null,
            serverName: null,
            command: null,
            reason: 'init-failed',
            error: error instanceof Error ? error.message : 'Failed to load LSP state',
          },
        },
      }))
    }
  },

  loadLspDiagnostics: async (sessionId, path, refresh = false) => {
    const requestKey = `${sessionId}::${path}`
    const requestId = nextRequest(lspDiagnosticRequests, requestKey)
    try {
      const result = await sessionsApi.getWorkspaceLspDiagnostics(sessionId, path, {
        refresh,
        config: resolveWorkspaceLspConfig(),
      })
      if (!isLatestRequest(lspDiagnosticRequests, requestKey, requestId)) return
      set((state) => ({
        lspDiagnosticsBySessionPath: {
          ...state.lspDiagnosticsBySessionPath,
          [requestKey]: result,
        },
      }))
    } catch (error) {
      if (!isLatestRequest(lspDiagnosticRequests, requestKey, requestId)) return
      set((state) => ({
        lspDiagnosticsBySessionPath: {
          ...state.lspDiagnosticsBySessionPath,
          [requestKey]: {
            state: 'unavailable',
            diagnostics: [],
            diagnosticsTotal: 0,
            diagnosticsTruncated: false,
            error: error instanceof Error ? error.message : 'Failed to load LSP diagnostics',
          },
        },
      }))
    }
  },

  syncLsp: async (sessionId, input) => {
    try {
      const result = await sessionsApi.syncWorkspaceLsp(sessionId, {
        ...input,
        ...resolveWorkspaceLspConfig(),
      })
      set((state) => ({
        lspStateBySession: { ...state.lspStateBySession, [sessionId]: result.state },
      }))
      if (input.path) void get().loadLspDiagnostics(sessionId, input.path, false)
    } catch (error) {
      set((state) => ({
        lspStateBySession: {
          ...state.lspStateBySession,
          [sessionId]: {
            state: 'unavailable',
            path: input.path,
            serverName: null,
            command: null,
            reason: 'init-failed',
            error: error instanceof Error ? error.message : 'Failed to sync LSP document',
          },
        },
      }))
    }
  },

  restartLsp: async (sessionId, path) => {
    await sessionsApi.restartWorkspaceLsp(sessionId, { path, ...resolveWorkspaceLspConfig() })
    await get().loadLspState(sessionId, path)
    await get().loadLspDiagnostics(sessionId, path, true)
  },
}))
