import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { CodeViewer } from '../chat/CodeViewer'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'

export type PreviewFile = {
  path: string
  size: number
  language: string
  tooBig?: boolean
}

export type PreviewFileContent = {
  path: string
  content: string
  language: string
  size: number
  truncated: boolean
}

const LANG_ICONS: Record<string, string> = {
  markdown: 'description',
  python: 'code',
  javascript: 'javascript',
  typescript: 'code',
  bash: 'terminal',
  json: 'data_object',
  yaml: 'data_object',
  text: 'notes',
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; file: PreviewFileContent }

/**
 * Two-pane file preview: file list on the left, rendered content on the
 * right. Content is fetched lazily via `loadFile` and cached per path for
 * the lifetime of the component. Serves both market (async fetch) and
 * locally installed skills (loadFile resolves from memory).
 */
export function FilePreview({
  files,
  loadFile,
  initialPath,
}: {
  files: PreviewFile[]
  loadFile: (path: string) => Promise<PreviewFileContent>
  initialPath?: string
}) {
  const t = useTranslation()
  const defaultPath = initialPath ?? files.find((f) => f.path === 'SKILL.md')?.path ?? files[0]?.path ?? null
  const [activePath, setActivePath] = useState<string | null>(defaultPath)
  const [state, setState] = useState<LoadState>({ kind: 'idle' })
  const cacheRef = useRef(new Map<string, PreviewFileContent>())
  const requestSeq = useRef(0)

  const open = useCallback(
    async (path: string) => {
      setActivePath(path)
      const cached = cacheRef.current.get(path)
      if (cached) {
        setState({ kind: 'loaded', file: cached })
        return
      }
      const seq = ++requestSeq.current
      setState({ kind: 'loading' })
      try {
        const file = await loadFile(path)
        cacheRef.current.set(path, file)
        if (requestSeq.current !== seq) return
        setState({ kind: 'loaded', file })
      } catch (err) {
        if (requestSeq.current !== seq) return
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [loadFile],
  )

  useEffect(() => {
    if (defaultPath) void open(defaultPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (files.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-6 py-12 text-center">
        <span className="material-symbols-outlined mb-2 block text-[32px] text-[var(--color-text-tertiary)]">folder_off</span>
        <p className="text-sm text-[var(--color-text-tertiary)]">{t('market.file.noFiles')}</p>
      </div>
    )
  }

  const activeFile = files.find((f) => f.path === activePath)

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]" data-testid="market-file-preview">
      <div className="flex max-h-[520px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5">
        {files.map((file) => {
          const active = file.path === activePath
          return (
            <button
              key={file.path}
              type="button"
              data-testid={`market-file-item-${file.path}`}
              onClick={() => void open(file.path)}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                active
                  ? 'bg-[var(--color-primary-fixed)] text-[var(--color-brand)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <span className="material-symbols-outlined flex-shrink-0 text-[16px]" aria-hidden>
                {LANG_ICONS[file.language] || 'draft'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{file.path}</span>
                <span className={`block text-[10px] ${active ? 'opacity-80' : 'text-[var(--color-text-tertiary)]'}`}>
                  {file.language} · {formatSize(file.size)}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="min-w-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        {activeFile && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-2.5 text-[11px] text-[var(--color-text-tertiary)]">
            <span className="font-mono font-medium text-[var(--color-text-secondary)]">{activeFile.path}</span>
            <span>{activeFile.language}</span>
            <span>{formatSize(activeFile.size)}</span>
            {state.kind === 'loaded' && state.file.truncated && (
              <span className="inline-flex items-center gap-1 text-[var(--color-warning)]">
                <span className="material-symbols-outlined text-[13px]" aria-hidden>content_cut</span>
                {t('market.file.truncated')}
              </span>
            )}
          </div>
        )}

        <div className="max-h-[480px] overflow-y-auto p-4">
          {state.kind === 'loading' && (
            <div className="flex justify-center py-10" data-testid="market-file-loading">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-brand)] border-t-transparent" />
            </div>
          )}
          {state.kind === 'error' && (
            <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="market-file-error">
              <span className="material-symbols-outlined text-[28px] text-[var(--color-error)]">error</span>
              <p className="text-sm text-[var(--color-text-primary)]">{t('market.file.loadError')}</p>
              <p className="max-w-md break-words text-xs text-[var(--color-text-tertiary)]">{state.message}</p>
              <button
                type="button"
                onClick={() => activePath && void open(activePath)}
                className="mt-1 inline-flex min-h-8 items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-primary)] hover:border-[var(--color-border-focus)]"
              >
                <span className="material-symbols-outlined text-[14px]">refresh</span>
                {t('market.retry')}
              </button>
            </div>
          )}
          {state.kind === 'idle' && (
            <p className="py-10 text-center text-sm text-[var(--color-text-tertiary)]">{t('market.file.empty')}</p>
          )}
          {state.kind === 'loaded' &&
            (state.file.language === 'markdown' ? (
              <MarkdownRenderer content={state.file.content} variant="document" />
            ) : (
              <CodeViewer
                code={state.file.content}
                language={state.file.language}
                showLineNumbers
                wrapLongLines
                maxLines={500}
              />
            ))}
        </div>
      </div>
    </div>
  )
}
