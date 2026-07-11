import { ListChecks } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useActivityPanelStore } from '../../stores/activityPanelStore'

type SessionActivityButtonProps = {
  sessionId: string
  label?: string
}

export function SessionActivityButton({
  sessionId,
  label,
}: SessionActivityButtonProps) {
  const t = useTranslation()
  const resolvedLabel = label ?? t('session.activity.title')
  const isOpen = useActivityPanelStore((state) => state.isOpen(sessionId))
  const toggle = useActivityPanelStore((state) => state.toggle)
  return (
    <button
      type="button"
      aria-label={resolvedLabel}
      aria-expanded={isOpen}
      aria-pressed={isOpen}
      title={resolvedLabel}
      onClick={() => toggle(sessionId)}
      data-active={isOpen ? 'true' : 'false'}
      data-session-activity-trigger="true"
      className={`relative inline-flex h-8 w-8 items-center justify-center rounded-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
        isOpen
          ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      <ListChecks size={17} strokeWidth={1.9} />
    </button>
  )
}
