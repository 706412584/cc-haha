import { useCallback, useMemo, useState } from 'react'
import { FilePen, FileText } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { useTabStore } from '../../stores/tabStore'
import { SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useWorkspaceEditorStore } from '../../stores/workspaceEditorStore'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { errorCountFromDiagnostics, toLegacyLspState } from '../../lib/lspStateMap'
import { CodeSurface } from '../workspace/surfaces/CodeSurface'
import { LspStatusIndicator } from '../workspace/LspStatusIndicator'
import { WorkspaceEditor } from '../workspace/WorkspaceEditor'
import { PanelMessage } from '../workspace/surfaces/PanelMessage'
import type { WorkspaceTextSelection } from '../workspace/surfaces/textSelection'
import { workspaceOpen } from '../../lib/workspace/openTarget'
import { basenameOf } from '../../lib/workspace/types'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'

type Props = {
  sessionId: string
  path: string
  value: string
  language: string
  reveal?: { line: number; column?: number; nonce: number }
  revealScroll?: boolean
}

/**
 * Read/edit switch for a text file in the workspace.
 *
 * The workspace surface is read-only by default: `CodeSurface` renders the
 * bytes the content store fetched, and every line can be quoted into the chat.
 * "Edit" swaps that for the CodeMirror editor, which keeps its own buffer on
 * top of the same file and saves through the atomic-write endpoint.
 *
 * The two modes share one path identity (`sessionId::path`), so switching back
 * and forth never loses edits and never refetches the file.
 */
export function WorkspaceEditableFile({
  sessionId,
  path,
  value,
  language,
  reveal,
  revealScroll = true,
}: Props) {
  const t = useTranslation()
  const [editing, setEditing] = useState(false)

  const unsupported = useWorkspaceEditorStore((s) => Boolean(s.unsupportedKeys[`${sessionId}::${path}`]))
  const buffer = useWorkspaceEditorStore((s) => s.buffersByKey[`${sessionId}::${path}`])
  const lspState = useWorkspaceEditorStore((s) => s.lspStateBySession[sessionId])
  const lspDiagnostics = useWorkspaceEditorStore((s) => s.lspDiagnosticsBySessionPath[`${sessionId}::${path}`])
  const markUnsupported = useWorkspaceEditorStore((s) => s.markUnsupported)
  const restartLsp = useWorkspaceEditorStore((s) => s.restartLsp)
  const addToast = useUIStore((s) => s.addToast)

  // The preview mirrors the buffer once the file has been opened for editing,
  // so toggling back does not appear to discard the user's work.
  const shownValue = buffer?.currentContent ?? value

  const errorCount = useMemo(
    () => errorCountFromDiagnostics(lspDiagnostics?.diagnostics),
    [lspDiagnostics?.diagnostics],
  )

  const addSelectionToChat = useCallback((selection: WorkspaceTextSelection) => {
    useWorkspaceChatContextStore.getState().addReference(sessionId, {
      kind: 'code-selection',
      path,
      name: basenameOf(path),
      lineStart: selection.startLine,
      lineEnd: selection.endLine,
      quote: selection.text,
    })
  }, [path, sessionId])

  const addLineComment = useCallback((
    lineStart: number,
    lineEnd: number,
    note: string,
    quote: string,
  ) => {
    useWorkspaceChatContextStore.getState().addReference(sessionId, {
      kind: 'code-comment',
      path,
      name: basenameOf(path),
      lineStart,
      lineEnd,
      quote,
      note,
    })
  }, [path, sessionId])

  const handleUnsupportedEncoding = useCallback(() => {
    markUnsupported(sessionId, path)
    setEditing(false)
    addToast({ type: 'info', message: t('workspace.editUnsupported') })
  }, [addToast, markUnsupported, path, sessionId, t])

  const handleRetry = useCallback(() => {
    void restartLsp(sessionId, path).catch((error) => {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('workspace.lspRestartFailed'),
      })
    })
  }, [addToast, path, restartLsp, sessionId, t])

  const handleDiagnosticOpen = useCallback((diagnostic: { path: string; line: number; column?: number }) => {
    workspaceOpen.file(sessionId, diagnostic.path, {
      line: diagnostic.line,
      ...(diagnostic.column ? { column: diagnostic.column } : {}),
    })
  }, [sessionId])

  const handleSaved = useCallback((savedPath: string) => {
    void useWorkspaceContentStore.getState().loadFile(sessionId, savedPath, { force: true })
    useWorkspaceReviewStore.getState().invalidateSession(sessionId)
  }, [sessionId])

  const handleClose = useCallback(() => {
    const tab = useWorkspaceStore.getState().bySession[sessionId]?.tabs.find(
      (candidate) => candidate.kind === 'file' && candidate.path === path,
    )
    if (tab) useWorkspaceStore.getState().closeTab(sessionId, tab.id)
  }, [path, sessionId])

  const lspPill = path && !unsupported ? (
    <LspStatusIndicator
      state={toLegacyLspState(lspState, errorCount, sessionId)}
      diagnostics={lspDiagnostics?.diagnostics ?? []}
      onInstallClick={() => {
        useUIStore.getState().setPendingSettingsTab('plugins')
        useTabStore.getState().openTab(SETTINGS_TAB_ID, t('settings.title'), 'settings')
      }}
      onRetryClick={handleRetry}
      onDiagnosticOpen={handleDiagnosticOpen}
    />
  ) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <div className="flex shrink-0 items-center gap-0.5">
          {(['preview', 'edit'] as const).map((mode) => {
            const disabled = mode === 'edit' && unsupported
            const active = (mode === 'edit') === editing
            return (
              <button
                key={mode}
                type="button"
                data-testid={`workspace-file-${mode}-toggle`}
                disabled={disabled}
                aria-pressed={active}
                onClick={() => setEditing(mode === 'edit')}
                className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {mode === 'preview'
                  ? <FileText size={13} strokeWidth={1.8} aria-hidden="true" />
                  : <FilePen size={13} strokeWidth={1.8} aria-hidden="true" />}
                {mode === 'preview' ? t('workspace.preview') : t('workspace.edit')}
              </button>
            )
          })}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">{lspPill}</div>
      </div>

      {editing && !unsupported ? (
        <WorkspaceEditor
          sessionId={sessionId}
          path={path}
          content={value}
          onUnsupportedEncoding={handleUnsupportedEncoding}
          onSaved={handleSaved}
          onClose={handleClose}
        />
      ) : unsupported ? (
        <PanelMessage icon="code_off" message={t('workspace.editUnsupported')} />
      ) : (
        <CodeSurface
          value={shownValue}
          language={language}
          reveal={reveal}
          revealScroll={revealScroll}
          onAddLineComment={addLineComment}
          onAddSelection={addSelectionToChat}
        />
      )}
    </div>
  )
}
