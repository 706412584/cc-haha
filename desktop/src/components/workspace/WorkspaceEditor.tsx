import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'

import { loadEditorLanguage } from './editorLanguage'

import { sessionsApi, type SaveWorkspaceFileInput } from '../../api/sessions'
import {
  useWorkspaceEditorStore,
  workspaceBufferKey,
  type WorkspaceBufferInit,
  type WorkspaceBufferState,
} from '../../stores/workspaceEditorStore'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { detectEncoding, detectLineEnding } from './encodingDetect'
import { ConflictBanner } from './ConflictBanner'
import { UnsavedChangesModal } from './UnsavedChangesModal'

/**
 * In-app code editor for the workspace panel.
 *
 * Wraps a CodeMirror 6 EditorView, hands its dirty state through
 * `useWorkspaceEditorStore.buffersByKey`, and saves through the atomic-write
 * endpoint via `sessionsApi.saveWorkspaceFile`.
 *
 * Encoding detection runs on the loaded buffer; an `'unsupported'` result
 * blocks editor mounting and falls back to the read-only preview surface (the
 * parent decides what to render once `unsupportedEncoding` fires through
 * `onUnsupportedEncoding`).
 */

const SAVE_TIMEOUT_MS = 30_000

const workspaceHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, class: 'workspace-syntax-comment' },
  { tag: tags.string, class: 'workspace-syntax-string' },
  { tag: tags.keyword, class: 'workspace-syntax-keyword' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: 'workspace-syntax-function',
  },
  { tag: tags.number, class: 'workspace-syntax-number' },
  { tag: tags.bool, class: 'workspace-syntax-bool' },
  { tag: tags.propertyName, class: 'workspace-syntax-property' },
  { tag: [tags.typeName, tags.className], class: 'workspace-syntax-type' },
  { tag: tags.punctuation, class: 'workspace-syntax-punctuation' },
])

const workspaceEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--color-code-bg)',
    color: 'var(--color-code-fg)',
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
  },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--color-code-fg)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-code-fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-selection-bg)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-code-bg)',
    color: 'var(--color-text-tertiary)',
    borderRightColor: 'var(--color-border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'var(--color-surface-hover-a34)',
  },
})

/**
 * Holds the grammar, which arrives asynchronously so a language chunk is only
 * fetched when a file of that type is opened. The view is created immediately
 * and reconfigured once the grammar lands, rather than waiting for it: blocking
 * the first paint on a network chunk would make every file open feel slower to
 * fix colour that is not needed to read or edit the text.
 */
const languageCompartment = new Compartment()

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export type SaveWorkspaceBufferResult =
  | { ok: true }
  | { ok: false; message: string }

export async function saveWorkspaceBuffer(
  sessionId: string,
  buffer: WorkspaceBufferState,
  initBuffer: (init: WorkspaceBufferInit) => void,
): Promise<SaveWorkspaceBufferResult> {
  const payload: SaveWorkspaceFileInput = {
    path: buffer.path,
    content: buffer.currentContent,
    expectedBaseHash: buffer.baseHash,
    bom: buffer.encoding === 'utf-8-bom' ? 'utf-8' : 'none',
    lineEnding: buffer.lineEnding,
  }

  try {
    const result = await sessionsApi.saveWorkspaceFile(sessionId, payload)
    if (!result.ok) {
      return { ok: false, message: result.message }
    }

    initBuffer({
      key: buffer.key,
      path: buffer.path,
      baseHash: result.hash,
      baseContent: buffer.currentContent,
      encoding: buffer.encoding,
      lineEnding: buffer.lineEnding,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to save' }
  }
}

export type WorkspaceEditorProps = {
  sessionId: string
  path: string
  /** Content the tab was loaded with; the baseline the buffer initializes from. */
  content: string
  /** Called when the file's encoding is unsupported so the parent can fall
   *  back to the read-only preview surface. */
  onUnsupportedEncoding?: (path: string) => void
  onSaved?: (path: string) => void
  /** Called when the user explicitly closes the tab (caller manages tab
   *  lifecycle through the store). */
  onClose?: () => void
}

export function WorkspaceEditor(props: WorkspaceEditorProps) {
  const { sessionId, path, content, onUnsupportedEncoding, onSaved, onClose } = props

  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lspDebounceRef = useRef<number | undefined>(undefined)

  const key = workspaceBufferKey(sessionId, path)
  const buffer = useWorkspaceEditorStore((s) => s.buffersByKey[key])
  const unsupported = useWorkspaceEditorStore((s) => Boolean(s.unsupportedKeys[key]))
  const initBuffer = useWorkspaceEditorStore((s) => s.initBuffer)
  const setBufferState = useWorkspaceEditorStore((s) => s.setBufferState)
  const acknowledgeConflict = useWorkspaceEditorStore((s) => s.acknowledgeConflict)
  const markUnsupported = useWorkspaceEditorStore((s) => s.markUnsupported)
  const syncLsp = useWorkspaceEditorStore((s) => s.syncLsp)
  const loadLspState = useWorkspaceEditorStore((s) => s.loadLspState)

  const [saving, setSaving] = useState(false)
  const [closeRequested, setCloseRequested] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // -- Initialize the buffer state from the loaded tab content. ------------
  useEffect(() => {
    if (buffer) return // already initialized
    if (typeof content !== 'string') return
    let cancelled = false
    ;(async () => {
      const bytes = new TextEncoder().encode(content)
      const encoding = detectEncoding(bytes)
      if (encoding === 'unsupported') {
        if (cancelled) return
        markUnsupported(sessionId, path)
        onUnsupportedEncoding?.(path)
        return
      }
      const lineEnding = detectLineEnding(content)
      const baseHash = await sha256Hex(content)
      if (cancelled) return
      initBuffer({
        key,
        path,
        baseHash,
        baseContent: content,
        encoding,
        lineEnding,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [buffer, key, path, content, sessionId, initBuffer, markUnsupported, onUnsupportedEncoding])

  useEffect(() => {
    if (!buffer || unsupported) return
    void loadLspState(sessionId, buffer.path)
    void syncLsp(sessionId, { path: buffer.path, content: buffer.currentContent, event: 'open' })
  }, [buffer?.path, sessionId, syncLsp, loadLspState, unsupported])

  // -- Mount the CodeMirror view once we have an initialized buffer. -------
  useEffect(() => {
    if (!buffer || unsupported) return
    if (!containerRef.current) return
    if (viewRef.current) return

    const extensions = [
      lineNumbers(),
      history(),
      bracketMatching(),
      indentOnInput(),
      search(),
      autocompletion(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap]),
      EditorState.tabSize.of(2),
      languageCompartment.of([]),
      syntaxHighlighting(workspaceHighlightStyle),
      workspaceEditorTheme,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const next = update.state.doc.toString()
        setBufferState(key, next)
        window.clearTimeout(lspDebounceRef.current)
        lspDebounceRef.current = window.setTimeout(() => {
          void syncLsp(sessionId, { path: buffer.path, content: next, event: 'change' })
        }, 350)
      }),
    ]

    const view = new EditorView({
      state: EditorState.create({
        doc: buffer.currentContent,
        extensions,
      }),
      parent: containerRef.current,
    })
    viewRef.current = view

    // Load the grammar in the background and swap it in. A chunk that fails to
    // load leaves the file readable and editable as plain text, which is the
    // same outcome as an extension the editor has no grammar for.
    let cancelled = false
    void loadEditorLanguage(buffer.path).then((language) => {
      if (cancelled || !language || viewRef.current !== view) return
      view.dispatch({ effects: languageCompartment.reconfigure(language) })
    }).catch(() => {})

    return () => {
      cancelled = true
      window.clearTimeout(lspDebounceRef.current)
      view.destroy()
      viewRef.current = null
    }
    // We deliberately depend on the buffer's key rather than on `buffer`
    // itself: the key is stable per file, so this mounts once when the buffer
    // is first initialized and never re-mounts on a keystroke. Depending on
    // the local `key` alone would never fire, because it is already set on the
    // first render — before the buffer exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer?.key, unsupported])

  // -- External rebase: when the buffer's currentContent changes from outside
  // the editor (a conflict reload, or applyExternalSave once a save-event
  // subscription exists), push it back into the EditorView. We compare against
  // the view's current doc to avoid feedback loops with the updateListener.
  useEffect(() => {
    if (!buffer || !viewRef.current) return
    const current = viewRef.current.state.doc.toString()
    if (current === buffer.currentContent) return
    viewRef.current.dispatch({
      changes: { from: 0, to: current.length, insert: buffer.currentContent },
    })
  }, [buffer?.currentContent])

  // -- Save: POST to the workspace file endpoint, then re-init the buffer. -
  const performSave = useCallback(async (): Promise<boolean> => {
    if (!buffer) return false
    setSaving(true)
    setSaveError(null)
    const timeoutHandle = setTimeout(() => {
      setSaveError('Save timed out')
      setSaving(false)
    }, SAVE_TIMEOUT_MS)

    const result = await saveWorkspaceBuffer(sessionId, buffer, initBuffer)
    clearTimeout(timeoutHandle)
    setSaving(false)

    if (!result.ok) {
      setSaveError(result.message)
      return false
    }

    onSaved?.(buffer.path)
    void syncLsp(sessionId, { path: buffer.path, content: buffer.currentContent, event: 'save' })
    return true
  }, [buffer, sessionId, initBuffer, onSaved, syncLsp])

  // -- Close: dirty buffer triggers the unsaved-changes modal. -------------
  const handleClose = useCallback(() => {
    if (buffer?.isDirty) {
      setCloseRequested(true)
      return
    }
    onClose?.()
  }, [buffer?.isDirty, onClose])

  const handleModalDiscard = useCallback(() => {
    setCloseRequested(false)
    onClose?.()
  }, [onClose])

  const handleModalSave = useCallback(async () => {
    const success = await performSave()
    if (success) {
      setCloseRequested(false)
      onClose?.()
    }
  }, [performSave, onClose])

  const handleModalCancel = useCallback(() => {
    setCloseRequested(false)
  }, [])

  const handleModalTimeout = useCallback(() => {
    setCloseRequested(false)
    setSaveError('Close prompt timed out — buffer kept dirty')
  }, [])

  // -- Conflict banner actions. --------------------------------------------
  // "Reload" has to mean reload: dropping the conflict only restores the
  // baseline the editor opened with, which is the very content the banner just
  // told the user is stale. Refetch first, then rebase onto what is on disk.
  const handleConflictReload = useCallback(() => {
    acknowledgeConflict(key, 'reload')
    void (async () => {
      await useWorkspaceContentStore.getState().loadFile(sessionId, path, { force: true })
      const entry = useWorkspaceContentStore.getState().filesByKey[`${sessionId}::${path}`]
      if (entry?.state !== 'ok' || typeof entry.content !== 'string') return
      initBuffer({
        key,
        path,
        baseHash: await sha256Hex(entry.content),
        baseContent: entry.content,
        encoding: buffer?.encoding ?? 'utf-8',
        lineEnding: buffer?.lineEnding ?? 'LF',
      })
    })()
  }, [key, path, sessionId, acknowledgeConflict, initBuffer, buffer?.encoding, buffer?.lineEnding])

  const handleConflictKeepMine = useCallback(() => {
    acknowledgeConflict(key, 'keepMine')
  }, [key, acknowledgeConflict])

  const handleConflictOpenView = useCallback(() => {
    acknowledgeConflict(key, 'openConflict')
  }, [key, acknowledgeConflict])

  // -- Render. -------------------------------------------------------------
  const dirtyMarker = useMemo(() => (buffer?.isDirty ? '●' : ''), [buffer?.isDirty])

  if (unsupported) {
    return (
      <div
        data-testid="workspace-editor-unsupported"
        className="flex h-full items-center justify-center text-[12px] text-[var(--color-text-muted)]"
      >
        unsupported-encoding · this file uses an encoding the editor cannot open. Read-only preview
        is available below.
      </div>
    )
  }

  if (!buffer) {
    return (
      <div
        data-testid="workspace-editor-loading"
        className="flex h-full items-center justify-center text-[12px] text-[var(--color-text-muted)]"
      >
        Loading editor…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 text-[12px]">
        <span data-testid="workspace-editor-path" className="font-medium text-[var(--color-text)]">
          {dirtyMarker} {buffer.path}
        </span>
        <span className="text-[var(--color-text-muted)]">
          {buffer.encoding} · {buffer.lineEnding}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="workspace-editor-save"
            disabled={saving || !buffer.isDirty}
            onClick={() => void performSave()}
            className="rounded-[6px] border border-[var(--color-border)] px-2.5 py-1 text-[12px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            data-testid="workspace-editor-close"
            onClick={handleClose}
            className="rounded-[6px] border border-[var(--color-border)] px-2.5 py-1 text-[12px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
          >
            Close
          </button>
        </div>
      </div>

      {buffer.conflict && (
        <ConflictBanner
          filePath={buffer.path}
          isDirty={buffer.isDirty}
          conflict={buffer.conflict}
          onReload={handleConflictReload}
          onKeepMine={handleConflictKeepMine}
          onOpenConflictView={handleConflictOpenView}
        />
      )}

      {saveError && (
        <div
          role="alert"
          data-testid="workspace-editor-save-error"
          className="border-b border-[var(--color-error-border)] bg-[var(--color-error-surface)] px-3 py-1.5 text-[12px] text-[var(--color-error-text)]"
        >
          {saveError}
        </div>
      )}

      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto" />

      <UnsavedChangesModal
        open={closeRequested}
        filePath={buffer.path}
        isSaving={saving}
        onDiscard={handleModalDiscard}
        onSave={handleModalSave}
        onCancel={handleModalCancel}
        onTimeout={handleModalTimeout}
      />
    </div>
  )
}
