import { useCallback, useDeferredValue, useMemo, useState } from 'react'
import { Columns2, FilePen, FileText } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { useTabStore } from '../../stores/tabStore'
import { SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useWorkspaceEditorStore } from '../../stores/workspaceEditorStore'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { errorCountFromDiagnostics, toLegacyLspState } from '../../lib/lspStateMap'
import { useElementWidth } from '../../hooks/useElementWidth'
import { CodeSurface } from '../workspace/surfaces/CodeSurface'
import { MarkdownSurface } from '../workspace/surfaces/MarkdownSurface'
import { LspStatusIndicator } from '../workspace/LspStatusIndicator'
import { WorkspaceEditor } from '../workspace/WorkspaceEditor'
import { PanelMessage } from '../workspace/surfaces/PanelMessage'
import type { WorkspaceTextSelection } from '../workspace/surfaces/textSelection'
import { workspaceOpen } from '../../lib/workspace/openTarget'
import { basenameOf } from '../../lib/workspace/types'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'

/**
 * Below this the two panes are too narrow to read. jsdom reports no width, so
 * callers keep their fallback and the split stays available under test.
 */
const SPLIT_MIN_WIDTH = 720

type ViewMode = 'preview' | 'edit' | 'split'

type Props = {
  sessionId: string
  path: string
  value: string
  language: string
  reveal?: { line: number; column?: number; nonce: number }
  revealScroll?: boolean
  /**
   * Which read-only surface to pair with the editor. Markdown gets a third
   * "split" mode because its rendered form is the thing being authored, so
   * editing it without seeing the result is the whole problem.
   */
  variant?: 'code' | 'markdown'
  /** Workspace root, for resolving relative markdown image paths. */
  workDir?: string | null
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
  variant = 'code',
  workDir = null,
}: Props) {
  const t = useTranslation()
  const [mode, setMode] = useState<ViewMode>('preview')
  const editing = mode === 'edit'
  const [measureRef, measuredWidth] = useElementWidth<HTMLDivElement>()
  // Only markdown offers split, so only markdown needs the width. Observing on
  // every text file would add a second ResizeObserver to panels that already
  // observe their own container for the narrow-overlay decision.
  const attachMeasure = useCallback((node: HTMLDivElement | null) => {
    if (variant === 'markdown') measureRef(node)
  }, [measureRef, variant])
  // jsdom has no layout, so an unmeasured panel keeps the split available
  // rather than disabling a control that works in a real window.
  const splitAvailable = measuredWidth === null || measuredWidth >= SPLIT_MIN_WIDTH

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
  // In split the preview re-parses on every keystroke. Deferring it keeps typing
  // at full priority and lets the render lag a frame instead; the standalone
  // preview deliberately uses the live value, so switching back to it can never
  // show stale text.
  const deferredValue = useDeferredValue(shownValue)
  const splitPreviewValue = mode === 'split' ? deferredValue : shownValue

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
    setMode('preview')
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

  // A markdown file has no language server, so the pill would only ever report
  // "not available" on every document the user opens.
  const lspPill = path && !unsupported && variant === 'code' ? (
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

  const modes: ViewMode[] = variant === 'markdown' ? ['preview', 'edit', 'split'] : ['preview', 'edit']

  const preview = variant === 'markdown' ? (
    <MarkdownSurface
      value={splitPreviewValue}
      path={path}
      sessionId={sessionId}
      workDir={workDir}
      onAddSelection={addSelectionToChat}
    />
  ) : (
    <CodeSurface
      value={shownValue}
      language={language}
      reveal={reveal}
      revealScroll={revealScroll}
      onAddLineComment={addLineComment}
      onAddSelection={addSelectionToChat}
    />
  )

  const editor = (
    <WorkspaceEditor
      sessionId={sessionId}
      path={path}
      content={value}
      onUnsupportedEncoding={handleUnsupportedEncoding}
      onSaved={handleSaved}
      onClose={handleClose}
    />
  )

  return (
    <div ref={attachMeasure} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <div className="flex shrink-0 items-center gap-0.5">
          {modes.map((candidate) => {
            const active = mode === candidate
            const disabled = (candidate === 'edit' && unsupported)
              || (candidate === 'split' && (!splitAvailable || unsupported))
            const label = candidate === 'preview'
              ? t('workspace.preview')
              : candidate === 'edit' ? t('workspace.edit') : t('workspace.split')
            return (
              <button
                key={candidate}
                type="button"
                data-testid={`workspace-file-${candidate}-toggle`}
                disabled={disabled}
                aria-pressed={active}
                title={candidate === 'split' && !splitAvailable ? t('workspace.splitUnavailable') : undefined}
                onClick={() => setMode(candidate)}
                className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {candidate === 'preview'
                  ? <FileText size={13} strokeWidth={1.8} aria-hidden="true" />
                  : candidate === 'edit'
                    ? <FilePen size={13} strokeWidth={1.8} aria-hidden="true" />
                    : <Columns2 size={13} strokeWidth={1.8} aria-hidden="true" />}
                {label}
              </button>
            )
          })}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">{lspPill}</div>
      </div>

      {mode === 'split' && !unsupported ? (
        <div data-testid="workspace-split" className="flex min-h-0 min-w-0 flex-1 flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-[var(--color-border)]">{editor}</div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{preview}</div>
        </div>
      ) : editing && !unsupported ? (
        editor
      ) : unsupported ? (
        <PanelMessage icon="code_off" message={t('workspace.editUnsupported')} />
      ) : (
        preview
      )}
    </div>
  )
}
