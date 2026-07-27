import { EmptyState } from '@/components/ui/EmptyState'
import { useTranslation } from '../../i18n'

type Props = {
  onCreateTask: () => void
}

/**
 * The clock now sits in the shared 48px bordered icon box instead of a 64px
 * tinted circle, and the description drops from `text-sm` to the shared
 * `text-xs` — the deliberate cost of having one empty state instead of 24.
 * In exchange the title is a real heading, which it was not before.
 */
export function TaskEmptyState({ onCreateTask }: Props) {
  const t = useTranslation()
  return (
    <EmptyState
      variant="plain"
      size="lg"
      icon={
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      }
      title={t('tasks.emptyTitle')}
      description={t('tasks.emptyDesc')}
      action={{ label: t('tasks.newTask'), onClick: onCreateTask, variant: 'primary' }}
    />
  )
}
