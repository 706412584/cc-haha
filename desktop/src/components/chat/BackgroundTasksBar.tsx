import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleStop, LoaderCircle, X, XCircle } from 'lucide-react'
import { StatusDot } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'
import { createBackgroundTaskDismissKey, formatDurationMs } from '../../lib/backgroundTasks'
import type { BackgroundAgentTask } from '../../types/chat'

type BackgroundTasksBarProps = {
  tasks: BackgroundAgentTask[]
  compact?: boolean
  dismissedFinishedTaskKeys?: Set<string>
  onClearFinished?: (taskKeys: string[]) => void
}

const EMPTY_DISMISSED_TASK_KEYS = new Set<string>()

export function BackgroundTasksBar({
  tasks,
  compact = false,
  dismissedFinishedTaskKeys,
  onClearFinished,
}: BackgroundTasksBarProps) {
  const t = useTranslation()
  const [open, setOpen] = useState(false)
  const dismissedTaskKeys = dismissedFinishedTaskKeys ?? EMPTY_DISMISSED_TASK_KEYS

  const { runningTasks, finishedTasks } = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      runningTasks: sorted.filter((task) => task.status === 'running'),
      finishedTasks: sorted.filter((task) => task.status !== 'running'),
    }
  }, [tasks])

  const visibleFinishedTasks = finishedTasks.filter((task) =>
    !dismissedTaskKeys.has(createBackgroundTaskDismissKey(task))
  )
  const runningCount = runningTasks.length
  const visibleFinishedCount = visibleFinishedTasks.length

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  if (tasks.length === 0 || (runningCount === 0 && visibleFinishedCount === 0 && !open)) return null

  const taskButtonLabel = runningCount > 0
    ? t(
        runningCount === 1
          ? 'chat.backgroundTasks.runningCountOne'
          : 'chat.backgroundTasks.runningCountMany',
        { count: runningCount },
      )
    : t(
        visibleFinishedCount === 1
          ? 'chat.backgroundTasks.finishedCountOne'
          : 'chat.backgroundTasks.finishedCountMany',
        { count: visibleFinishedCount },
      )
  const drawerTitleId = 'background-tasks-drawer-title'

  return (
    <>
      {runningCount > 0 || visibleFinishedCount > 0 ? (
        <div className={['shrink-0', compact ? 'px-4' : 'px-8'].join(' ')}>
          <div className={compact ? 'w-full py-2' : 'mx-auto w-full max-w-[900px] py-2'}>
            <Button
              variant="tonal"
              size="base"
              data-testid="background-tasks-button"
              aria-expanded={open}
              aria-controls="background-tasks-drawer"
              onClick={() => setOpen(true)}
              icon={runningCount > 0 ? (
                <LoaderCircle size={16} strokeWidth={2.2} className="animate-spin text-[var(--color-warning)]" aria-hidden="true" />
              ) : (
                <CheckCircle2 size={16} strokeWidth={2.2} className="text-[var(--color-success)]" aria-hidden="true" />
              )}
            >
              {taskButtonLabel}
            </Button>
          </div>
        </div>
      ) : null}

      {open ? (
        <aside
          id="background-tasks-drawer"
          data-testid="background-tasks-drawer"
          role="dialog"
          aria-modal="false"
          aria-labelledby={drawerTitleId}
          className="absolute inset-y-0 right-0 z-40 flex w-[360px] max-w-[calc(100vw-24px)] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4">
            <h2 id={drawerTitleId} className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              {t('chat.backgroundTasks.title')}
            </h2>
            <IconButton
              size="md"
              tone="muted"
              label={t('chat.backgroundTasks.close')}
              showTooltip={false}
              onClick={() => setOpen(false)}
              icon={<X size={16} strokeWidth={2.2} aria-hidden="true" />}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <TaskSection title={t('chat.backgroundTasks.running')} tasks={runningTasks} />

            <div className="mt-5 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
                {t('chat.backgroundTasks.finished')}
                {visibleFinishedCount > 0 ? (
                  <span className="ml-1 font-normal text-[var(--color-text-tertiary)]">{visibleFinishedCount}</span>
                ) : null}
              </h3>
              {visibleFinishedCount > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onClearFinished?.(finishedTasks.map(createBackgroundTaskDismissKey))
                    if (runningTasks.length === 0) setOpen(false)
                  }}
                >
                  {t('chat.backgroundTasks.clear')}
                </Button>
              ) : null}
            </div>
            <TaskList tasks={visibleFinishedTasks} />
          </div>
        </aside>
      ) : null}
    </>
  )
}

function TaskSection({ title, tasks }: { title: string; tasks: BackgroundAgentTask[] }) {
  if (tasks.length === 0) return null

  return (
    <section>
      <h3 className="mb-2 text-[13px] font-semibold text-[var(--color-text-secondary)]">{title}</h3>
      <TaskList tasks={tasks} />
    </section>
  )
}

function TaskList({ tasks }: { tasks: BackgroundAgentTask[] }) {
  if (tasks.length === 0) return null

  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <BackgroundTaskRow key={task.taskId} task={task} />
      ))}
    </div>
  )
}

function BackgroundTaskRow({ task }: { task: BackgroundAgentTask }) {
  const t = useTranslation()
  const title = task.description?.trim() ||
    task.summary?.trim() ||
    task.lastToolName?.trim() ||
    task.outputFile?.trim() ||
    task.taskId
  const typeLabel = getTaskTypeLabel(task, t)
  const duration = formatDurationMs(task.usage?.durationMs, t)
  const tokenLabel = task.usage?.totalTokens
    ? t('chat.backgroundAgents.tokens', { count: formatCompactNumber(task.usage.totalTokens) })
    : null

  return (
    <div
      data-testid="background-task-row"
      data-status={task.status}
      className="rounded-[8px] bg-[var(--color-surface-container-low)] px-3 py-2.5"
    >
      <div className="flex min-w-0 items-start gap-2">
        <StatusDot
          tone={task.status === 'running' ? 'brand' : 'neutral'}
          size="md"
          pulse={task.status === 'running'}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]" title={title}>
            {title}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--color-text-tertiary)]">
            <span className="inline-flex items-center gap-1 text-[var(--color-text-secondary)]">
              {getTaskStatusIcon(task.status)}
              {typeLabel}
            </span>
            <span>{getTaskStatusLabel(task.status, t)}</span>
            {duration ? <span>{duration}</span> : null}
            {tokenLabel ? <span>{tokenLabel}</span> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function getTaskStatusIcon(status: BackgroundAgentTask['status']) {
  if (status === 'running') {
    return <LoaderCircle size={13} strokeWidth={2.2} className="animate-spin" aria-hidden="true" />
  }
  if (status === 'failed') {
    return <XCircle size={13} strokeWidth={2.2} className="text-[var(--color-error)]" aria-hidden="true" />
  }
  if (status === 'stopped') {
    return <CircleStop size={13} strokeWidth={2.2} aria-hidden="true" />
  }
  return <CheckCircle2 size={13} strokeWidth={2.2} className="text-[var(--color-success)]" aria-hidden="true" />
}

function getTaskTypeLabel(
  task: BackgroundAgentTask,
  t: ReturnType<typeof useTranslation>,
): string {
  if (task.taskType === 'local_agent' || task.taskType === 'remote_agent') {
    return t('chat.backgroundTasks.type.agent')
  }
  if (task.taskType === 'local_bash' || task.taskType === 'shell' || task.taskType === 'bash') {
    return t('chat.backgroundTasks.type.bash')
  }
  if (task.taskType === 'local_workflow' || task.workflowName) {
    return t('chat.backgroundTasks.type.workflow')
  }
  return t('chat.backgroundTasks.type.task')
}

function getTaskStatusLabel(
  status: BackgroundAgentTask['status'],
  t: ReturnType<typeof useTranslation>,
): string {
  switch (status) {
    case 'running':
      return t('chat.backgroundAgents.status.running')
    case 'completed':
      return t('chat.backgroundAgents.status.completed')
    case 'failed':
      return t('chat.backgroundAgents.status.failed')
    case 'stopped':
      return t('chat.backgroundAgents.status.stopped')
  }
}

function formatCompactNumber(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1000000) return `${Math.round(value / 100) / 10}k`
  return `${Math.round(value / 100000) / 10}m`
}
