import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { WorkspaceChangedFile } from '@/api/sessions'
import { Button } from '@/components/ui/Button'
import { FileTypeIcon } from '@/components/ui/FileTypeIcon'
import { useTranslation } from '@/i18n'
import { workspaceOpen } from '@/lib/workspace/openTarget'

type WorkspaceChangesFallbackProps = {
  sessionId: string
  /** Null means the workspace evidence could not be verified. */
  files: WorkspaceChangedFile[] | null
}

const COLLAPSED_COUNT = 5

/** Current workspace evidence is cumulative and has no turn baseline or undo. */
export function WorkspaceChangesFallback({ sessionId, files }: WorkspaceChangesFallbackProps) {
  const t = useTranslation()
  const [showAllFiles, setShowAllFiles] = useState(false)
  const visibleFiles = showAllFiles ? files : files?.slice(0, COLLAPSED_COUNT)

  return (
    <section
      aria-label={t('chat.workspaceChangesFallbackLabel')}
      className="mx-auto mb-5 mt-2 w-full max-w-[var(--chat-content-max-width)] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]"
    >
      <div className="space-y-1 bg-[var(--color-surface-container-low)] px-3 py-2">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
          {files === null
            ? t('chat.workspaceChangesFallbackLabel')
            : t('chat.workspaceChangesFallbackTitle', { count: files.length })}
        </h3>
        <p role={files === null ? 'alert' : undefined} className="text-xs leading-5 text-[var(--color-text-secondary)]">
          {t(files === null ? 'chat.workspaceChangesFallbackUnavailable' : 'chat.workspaceChangesFallbackExplanation')}
        </p>
      </div>

      {files?.length === 0 ? (
        <p className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
          {t('chat.workspaceChangesFallbackEmpty')}
        </p>
      ) : null}

      {visibleFiles?.length ? (
        <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          {visibleFiles.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                aria-label={t('chat.workspaceChangesFallbackOpenFile', { path: file.path })}
                title={file.path}
                onClick={() => workspaceOpen.file(sessionId, file.path)}
                className="flex min-h-[44px] w-full min-w-0 items-center gap-3 rounded-[var(--radius-md)] px-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
              >
                <FileTypeIcon path={file.path} size={20} />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-primary)]">{file.path}</span>
                <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {files && files.length > COLLAPSED_COUNT ? (
        <div className="border-t border-[var(--color-border)] px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showAllFiles}
            onClick={() => setShowAllFiles((current) => !current)}
          >
            {t(showAllFiles ? 'chat.turnChangesShowLess' : 'chat.turnChangesShowMore', { count: files.length - COLLAPSED_COUNT })}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
