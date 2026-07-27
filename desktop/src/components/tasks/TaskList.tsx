import { useState } from 'react'
import type { CronTask } from '../../types/task'
import { TaskRow } from './TaskRow'
import { Card } from '@/components/ui/Card'
import { useTranslation } from '../../i18n'

type Props = {
  tasks: CronTask[]
}

export function TaskList({ tasks }: Props) {
  const t = useTranslation()
  const enabledCount = tasks.filter((task) => task.enabled).length
  const [expandedLogsId, setExpandedLogsId] = useState<string | null>(null)

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3.5">
        <StatCard label={t('tasks.totalTasks')} value={String(tasks.length)} />
        <StatCard label={t('tasks.active')} value={String(enabledCount)} />
        <StatCard label={t('tasks.disabled')} value={String(tasks.length - enabledCount)} />
      </div>

      {/* Task rows — accordion: only one logs panel open at a time.
          The separators live on this container rather than on each row so the
          last row does not draw a rule against the card's own edge.

          The corners are rounded per-row instead of with `overflow-hidden`:
          each row anchors a confirm popover and an action menu, and an
          `overflow-hidden` ancestor clips absolutely positioned descendants
          whatever their own stacking is. Rounding the first row's head and the
          last row's tail keeps the row hover fill and the open runs drawer
          inside the card's edge without a clipping context. */}
      <Card
        radius="xl"
        padding="none"
        className="mt-[22px] divide-y divide-[var(--color-border-separator)] [&>*:first-child>*:first-child]:rounded-t-[var(--radius-xl)] [&>*:last-child>*:last-child]:rounded-b-[var(--radius-xl)]"
      >
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            showLogs={expandedLogsId === task.id}
            onToggleLogs={() => setExpandedLogsId(expandedLogsId === task.id ? null : task.id)}
          />
        ))}
      </Card>
    </div>
  )
}

/**
 * `surface="none"` rather than one of `Card`'s named layers: the handoff puts
 * these on `--color-surface-container`, which the component has no name for,
 * and an empty surface class cannot fight the one passed below it.
 */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card radius="xl" surface="none" padding="none" className="bg-[var(--color-surface-container)] px-[22px] py-[18px]">
      <div
        className="text-[26px] font-bold leading-none text-[var(--color-text-primary)]"
        style={{ fontFamily: 'var(--font-headline)' }}
      >
        {value}
      </div>
      <div className="mt-1.5 text-xs text-[var(--color-text-tertiary)]">{label}</div>
    </Card>
  )
}
