import { useEffect, useState } from 'react'
import { CircleAlert, FileDown, PencilLine, RotateCcw, Save } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'
import { selectIsDirty, useSystemPromptStore } from '@/stores/systemPromptStore'

/**
 * Editor for the session's main system prompt — the base prompt that REPLACES
 * the built-in one (unlike the orchestration prompts, which append to it).
 *
 * Because it replaces rather than appends, setting an override drops the
 * built-in environment/memory/skill sections, so the panel carries a standing
 * warning rather than a soft hint.
 */
export function SystemPromptSettings() {
  const t = useTranslation()
  const data = useSystemPromptStore((s) => s.data)
  const draft = useSystemPromptStore((s) => s.draft)
  const isLoading = useSystemPromptStore((s) => s.isLoading)
  const isSaving = useSystemPromptStore((s) => s.isSaving)
  const error = useSystemPromptStore((s) => s.error)
  const lastSavedAt = useSystemPromptStore((s) => s.lastSavedAt)
  const isDirty = useSystemPromptStore(selectIsDirty)
  const fetch = useSystemPromptStore((s) => s.fetch)
  const updateDraft = useSystemPromptStore((s) => s.updateDraft)
  const save = useSystemPromptStore((s) => s.save)
  const resetToDefault = useSystemPromptStore((s) => s.resetToDefault)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isResetOpen, setIsResetOpen] = useState(false)

  useEffect(() => {
    void fetch()
  }, [fetch])

  const maxChars = data?.maxChars ?? 200_000
  const isTooLong = draft.length > maxChars
  const isBlank = draft.trim().length === 0
  const canSave = Boolean(data) && isDirty && !isTooLong && !isBlank && !isSaving
  const canLoadDefault = Boolean(data?.default) && draft !== data?.default && !isSaving

  const handleReset = async () => {
    const reset = await resetToDefault()
    if (reset) setIsResetOpen(false)
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.systemPrompt.title')}
        description={t('settings.systemPrompt.description')}
      />

      {data === null && (isLoading || error === null) ? (
        // `error === null` covers the first paint, before the mount effect has
        // set `isLoading` — otherwise the panel flashes a load failure for one
        // frame every time it opens.
        <LoadingState label={t('common.loading')} labelHidden size="md" />
      ) : data === null ? (
        <ErrorState
          title={t('settings.systemPrompt.loadFailed')}
          detail={error}
          onRetry={() => void fetch()}
          retryLabel={t('common.retry')}
          size="lg"
        />
      ) : (
        <section className="flex min-h-[560px] min-w-0 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-medium uppercase tracking-normal text-[var(--color-text-tertiary)]">
                {t('settings.systemPrompt.title')}
              </span>
              <ModeBadge isCustom={data.isCustom} />
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
                {isPreviewing ? t('settings.systemPrompt.edit') : t('settings.systemPrompt.preview')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canLoadDefault}
                onClick={() => updateDraft(data.default)}
                icon={<FileDown size={14} aria-hidden="true" />}
              >
                {t('settings.systemPrompt.loadDefault')}
              </Button>
              {data.isCustom ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isSaving}
                  onClick={() => setIsResetOpen(true)}
                  icon={<RotateCcw size={14} aria-hidden="true" />}
                >
                  {t('settings.systemPrompt.resetToDefault')}
                </Button>
              ) : null}
            </div>
          </div>

          <p
            role="status"
            className="flex items-start gap-2 border-b border-[var(--color-border)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-warning-container)]"
          >
            <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t('settings.systemPrompt.replaceWarning')}</span>
          </p>

          {isPreviewing ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <MarkdownRenderer content={draft || ' '} variant="document" />
            </div>
          ) : (
            <textarea
              aria-label={t('settings.systemPrompt.editorLabel')}
              aria-describedby={isTooLong ? 'system-prompt-too-long' : undefined}
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              spellCheck={false}
              placeholder={t('settings.systemPrompt.placeholder')}
              className="min-h-0 flex-1 w-full resize-none overflow-auto bg-transparent p-5 font-mono text-[13px] leading-6 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
            />
          )}

          {error && data !== null ? (
            <ErrorState title={t('settings.systemPrompt.saveFailed')} detail={error} size="sm" className="m-3" />
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2.5">
            <div className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-tertiary)]">
              <span className="flex flex-wrap items-center gap-2">
                {isDirty ? <Badge tone="warning">{t('settings.systemPrompt.unsaved')}</Badge> : null}
                {lastSavedAt && !isDirty ? <Badge tone="success">{t('settings.systemPrompt.saved')}</Badge> : null}
                {data.isCustom ? null : <span>{t('settings.systemPrompt.editDefaultHint')}</span>}
              </span>
              <span>{t('settings.systemPrompt.applyHint')}</span>
              {isTooLong ? (
                <span id="system-prompt-too-long" role="alert" className="text-[var(--color-error)]">
                  {t('settings.systemPrompt.tooLong', { max: maxChars })}
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
                onClick={() => void save()}
                icon={<Save size={14} aria-hidden="true" />}
              >
                {t('settings.systemPrompt.save')}
              </Button>
            </div>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={isResetOpen}
        onClose={() => setIsResetOpen(false)}
        onConfirm={() => void handleReset()}
        title={t('settings.systemPrompt.resetToDefault')}
        body={t('settings.systemPrompt.resetConfirm')}
        confirmLabel={t('settings.systemPrompt.resetToDefault')}
        cancelLabel={t('common.cancel')}
        loading={isSaving}
      />
    </div>
  )
}

function ModeBadge({ isCustom }: { isCustom: boolean }) {
  const t = useTranslation()
  return isCustom ? (
    <Badge tone="brand">{t('settings.systemPrompt.customBadge')}</Badge>
  ) : (
    <Badge tone="neutral">{t('settings.systemPrompt.defaultBadge')}</Badge>
  )
}
