import { useEffect, useState } from 'react'
import { CircleAlert, PencilLine, RotateCcw, Save } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'
import {
  ORCHESTRATION_MODES,
  selectIsDirty,
  useOrchestrationPromptStore,
} from '@/stores/orchestrationPromptStore'

const MODE_LABEL_KEYS = {
  coordinator: 'settings.orchestration.coordinator',
  solo: 'settings.orchestration.solo',
  re: 'settings.orchestration.re',
} as const

/**
 * Editor for the three per-session orchestration prompts.
 *
 * One prompt at a time: each is 4–13KB, and three editors on one screen would
 * leave none of them tall enough to read. The left rail picks the mode, the
 * right pane edits it.
 */
export function OrchestrationPromptSettings() {
  const t = useTranslation()
  const prompts = useOrchestrationPromptStore((s) => s.prompts)
  const selectedMode = useOrchestrationPromptStore((s) => s.selectedMode)
  const draft = useOrchestrationPromptStore((s) => s.draft)
  const maxChars = useOrchestrationPromptStore((s) => s.maxChars)
  const isLoading = useOrchestrationPromptStore((s) => s.isLoading)
  const isSaving = useOrchestrationPromptStore((s) => s.isSaving)
  const error = useOrchestrationPromptStore((s) => s.error)
  const lastSavedAt = useOrchestrationPromptStore((s) => s.lastSavedAt)
  const isDirty = useOrchestrationPromptStore(selectIsDirty)
  const fetchPrompts = useOrchestrationPromptStore((s) => s.fetch)
  const selectMode = useOrchestrationPromptStore((s) => s.selectMode)
  const updateDraft = useOrchestrationPromptStore((s) => s.updateDraft)
  const save = useOrchestrationPromptStore((s) => s.save)
  const resetToDefault = useOrchestrationPromptStore((s) => s.resetToDefault)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isResetOpen, setIsResetOpen] = useState(false)

  useEffect(() => {
    void fetchPrompts()
  }, [fetchPrompts])

  const entry = prompts?.[selectedMode] ?? null
  const isTooLong = draft.length > maxChars
  const isBlank = draft.trim().length === 0
  const canSave = Boolean(entry) && isDirty && !isTooLong && !isBlank && !isSaving

  const handleSave = async () => {
    if (!canSave) return
    await save()
  }

  /**
   * One editor serves all three modes, so switching modes replaces the draft.
   * Guard that with the same confirm the memory editor uses for the same
   * reason, rather than silently dropping typed text.
   */
  const handleSelectMode = (mode: typeof selectedMode) => {
    if (mode === selectedMode) return
    if (isDirty && !window.confirm(t('settings.orchestration.discardUnsavedConfirm'))) return
    selectMode(mode)
  }

  const handleReset = async () => {
    const reset = await resetToDefault()
    if (reset) setIsResetOpen(false)
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.orchestration.title')}
        description={t('settings.orchestration.description')}
      />

      {prompts === null && (isLoading || error === null) ? (
        // `error === null` covers the first paint, before the mount effect has
        // set `isLoading` — otherwise the panel flashes a load failure for one
        // frame every time it opens.
        <LoadingState label={t('common.loading')} labelHidden size="md" />
      ) : prompts === null ? (
        <ErrorState
          title={t('settings.orchestration.loadFailed')}
          detail={error}
          onRetry={() => void fetchPrompts()}
          retryLabel={t('common.retry')}
          size="lg"
        />
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside
            role="tablist"
            aria-orientation="vertical"
            aria-label={t('settings.orchestration.title')}
            className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-2"
          >
            {ORCHESTRATION_MODES.map((mode) => {
              const active = mode === selectedMode
              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  id={`orchestration-tab-${mode}`}
                  aria-selected={active}
                  aria-controls={`orchestration-panel-${mode}`}
                  onClick={() => handleSelectMode(mode)}
                  className={`flex min-h-10 w-full items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                    active
                      ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-dropdown)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                    {t(MODE_LABEL_KEYS[mode])}
                  </span>
                  <ModeBadge isCustom={prompts[mode].isCustom} />
                </button>
              )
            })}
          </aside>

          <section
            role="tabpanel"
            id={`orchestration-panel-${selectedMode}`}
            aria-labelledby={`orchestration-tab-${selectedMode}`}
            className="flex min-h-[560px] min-w-0 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-medium uppercase tracking-normal text-[var(--color-text-tertiary)]">
                  {t(MODE_LABEL_KEYS[selectedMode])}
                </span>
                <ModeBadge isCustom={entry?.isCustom ?? false} />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={isPreviewing}
                  onClick={() => setIsPreviewing((previous) => !previous)}
                  icon={<PencilLine size={14} aria-hidden="true" />}
                >
                  {isPreviewing ? t('settings.orchestration.edit') : t('settings.orchestration.preview')}
                </Button>
                {entry?.isCustom ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isSaving}
                    onClick={() => setIsResetOpen(true)}
                    icon={<RotateCcw size={14} aria-hidden="true" />}
                  >
                    {t('settings.orchestration.resetToDefault')}
                  </Button>
                ) : null}
              </div>
            </div>

            {selectedMode === 're' ? (
              <p
                role="status"
                className="flex items-start gap-2 border-b border-[var(--color-border)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-warning-container)]"
              >
                <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{t('settings.orchestration.reWarning')}</span>
              </p>
            ) : null}

            {isPreviewing ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-6">
                <MarkdownRenderer content={draft || ' '} variant="document" />
              </div>
            ) : (
              <textarea
                aria-label={t(MODE_LABEL_KEYS[selectedMode])}
                aria-describedby={isTooLong ? 'orchestration-too-long' : undefined}
                value={draft}
                onChange={(event) => updateDraft(event.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 w-full resize-none overflow-auto bg-transparent p-5 font-mono text-[13px] leading-6 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
              />
            )}

            {error && prompts !== null ? (
              <ErrorState title={t('settings.orchestration.saveFailed')} detail={error} size="sm" className="m-3" />
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2.5">
              <div className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-tertiary)]">
                <span className="flex flex-wrap items-center gap-2">
                  {isDirty ? <Badge tone="warning">{t('settings.orchestration.unsaved')}</Badge> : null}
                  {lastSavedAt && !isDirty ? <Badge tone="success">{t('settings.orchestration.saved')}</Badge> : null}
                  {entry?.isCustom ? null : (
                    <span>{t('settings.orchestration.editDefaultHint')}</span>
                  )}
                </span>
                <span>{t('settings.orchestration.applyHint')}</span>
                {isTooLong ? (
                  <span id="orchestration-too-long" role="alert" className="text-[var(--color-error)]">
                    {t('settings.orchestration.tooLong', { max: maxChars })}
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs tabular-nums text-[var(--color-text-tertiary)]">
                  {draft.length} / {maxChars}
                </span>
                <Button
                  type="button"
                  size="sm"
                  disabled={!canSave}
                  loading={isSaving}
                  onClick={() => void handleSave()}
                  icon={<Save size={14} aria-hidden="true" />}
                >
                  {t('settings.orchestration.save')}
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={isResetOpen}
        onClose={() => setIsResetOpen(false)}
        onConfirm={() => void handleReset()}
        title={t('settings.orchestration.resetToDefault')}
        body={t('settings.orchestration.resetConfirm')}
        confirmLabel={t('settings.orchestration.resetToDefault')}
        cancelLabel={t('common.cancel')}
        loading={isSaving}
      />
    </div>
  )
}

function ModeBadge({ isCustom }: { isCustom: boolean }) {
  const t = useTranslation()
  return isCustom ? (
    <Badge tone="brand">{t('settings.orchestration.customBadge')}</Badge>
  ) : (
    <Badge tone="neutral">{t('settings.orchestration.defaultBadge')}</Badge>
  )
}
