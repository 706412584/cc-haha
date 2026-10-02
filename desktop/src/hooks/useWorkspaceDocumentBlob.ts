import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '@/api/client'
import { sessionsApi } from '@/api/sessions'
import {
  documentBlobKey,
  fetchDocumentBlob,
  peekDocumentBlob,
} from '@/lib/workspace/documentBlobCache'
import { workspaceFileKey } from '@/stores/workspaceContentStore'

export type WorkspaceDocumentBlob = {
  /** The newest bytes held. While a newer version loads, this is still the previous one. */
  blob: Blob | null
  /** Which version `blob` is; undefined until the first load completes. */
  blobVersion: string | undefined
  /** A version this hook does not hold yet is being fetched. */
  loading: boolean
  /** The latest fetch failed. `blob` is still the last good one, if there was one. */
  error: string | null
  /** HTTP status of that failure, when it was one (403 outside workspace, 413 too large…). */
  errorStatus: number | null
  retry: () => void
}

type State = Omit<WorkspaceDocumentBlob, 'retry'> & {
  /** Which file this state describes; state for another file is not this file's. */
  identity: string
}

/**
 * The bytes of a workspace document, for a viewer to render.
 *
 * Keyed by `version`, not by a reload: a watcher reload that finds the same
 * version costs nothing, and a new version is fetched while the previous bytes
 * stay available, so the viewer can swap renders instead of blanking. Tab
 * switches are served from a small shared cache (see `documentBlobCache`).
 *
 * `version === undefined` means the file's metadata has not loaded yet; nothing
 * is fetched until it does.
 *
 * "Previous bytes stay available" holds across versions of one file only. Point
 * the hook at another file and the old file's bytes are gone at once — a viewer
 * must never draw a different document's pages under the new file's name.
 */
export function useWorkspaceDocumentBlob(
  sessionId: string,
  path: string,
  version: string | undefined,
): WorkspaceDocumentBlob {
  const identity = workspaceFileKey(sessionId, path)
  const [state, setState] = useState<State>(() => {
    const cached = version === undefined
      ? undefined
      : peekDocumentBlob(documentBlobKey(sessionId, path, version))
    return {
      identity,
      blob: cached ?? null,
      blobVersion: cached ? version : undefined,
      loading: !cached && version !== undefined,
      error: null,
      errorStatus: null,
    }
  })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (version === undefined) return

    const cached = peekDocumentBlob(documentBlobKey(sessionId, path, version))
    if (cached) {
      setState({ identity, blob: cached, blobVersion: version, loading: false, error: null, errorStatus: null })
      return
    }

    const controller = new AbortController()
    setState((current) => (
      current.identity === identity
        ? { ...current, loading: true, error: null, errorStatus: null }
        : { identity, blob: null, blobVersion: undefined, loading: true, error: null, errorStatus: null }
    ))
    fetchDocumentBlob(
      sessionId,
      path,
      version,
      (signal) => sessionsApi.getWorkspaceRaw(sessionId, path, signal),
      controller.signal,
    ).then(
      (blob) => {
        if (controller.signal.aborted) return
        setState({ identity, blob, blobVersion: version, loading: false, error: null, errorStatus: null })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState((current) => ({
          ...current,
          identity,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          errorStatus: error instanceof ApiError ? error.status : null,
        }))
      },
    )
    return () => controller.abort()
  }, [sessionId, path, version, attempt, identity])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  // The effect above runs after the render in which the file changed. Until it
  // does, state still describes the previous file: report it as empty rather than
  // hand its bytes to a viewer for the new one.
  if (state.identity !== identity) {
    return {
      blob: null,
      blobVersion: undefined,
      loading: version !== undefined,
      error: null,
      errorStatus: null,
      retry,
    }
  }

  const { identity: _identity, ...visible } = state
  return { ...visible, retry }
}
