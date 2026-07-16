import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '../../i18n'
import type { ActivityRow } from '../activity/sessionActivityModel'
import type { TeamMember } from '../../types/team'
import type { SessionActivitySnapshot } from '../activity/useSessionActivityModel'
import { adaptActivityToOfficeRoster } from './officeActivityAdapter'
import { OfficeCanvas } from './OfficeCanvas'
import {
  formatMainAgentStatus,
  resolveAgentOfficeCopy,
  type AgentOfficeCopy,
} from './officeCopy'
import { projectOfficeActivity } from './officeActivityProjection'

const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'running'])
const FAILED_STATUSES = new Set(['failed', 'error'])

function statusLabel(
  status: ActivityRow['status'],
  copy: AgentOfficeCopy['status'],
): string {
  if (status === 'running' || status === 'in_progress') return copy.running
  if (status === 'pending') return copy.pending
  if (status === 'completed') return copy.completed
  if (status === 'failed' || status === 'error') return copy.failed
  if (status === 'stopped') return copy.stopped ?? String(status)
  return copy.idle ?? String(status)
}

function rowDescription(row: ActivityRow): string | undefined {
  const description = row.description || row.summary
  return description && description !== row.label ? description : undefined
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 py-3 shadow-sm">
      <p className="text-[11px] font-medium text-[var(--color-text-secondary)]">{label}</p>
      <strong className="mt-0.5 block text-2xl font-semibold tracking-tight text-[var(--color-text-primary)]">{value}</strong>
      <span className="text-[11px] text-[var(--color-text-tertiary)]">{hint}</span>
    </section>
  )
}

export type AgentOfficeOpenSubagentPayload = {
  sessionId: string
  toolUseId: string
  title: string
}

type AgentOfficeRuntimeProps = {
  sessionId: string
  activity: SessionActivitySnapshot
  onOpenSubagent?: (payload: AgentOfficeOpenSubagentPayload) => void
  onOpenMember?: (member: TeamMember) => void
  onStopBackgroundTask?: (taskId: string) => void
  onDismissActivityRows?: (keys: string[]) => void
  onOpenOutputFile?: (path: string) => void
  onDispatchTasks?: (taskIds: string[]) => void
  onSendQueuedMessageNow?: (queuedMessageId: string) => void
  onRemoveQueuedMessage?: (queuedMessageId: string) => void
  onSendMemberMessage?: (member: TeamMember, content: string) => void
  dispatchMode?: 'now' | 'queue'
}

export function AgentOfficeRuntime({
  sessionId,
  activity,
  onOpenSubagent,
  onOpenMember,
  onStopBackgroundTask,
  onDismissActivityRows,
  onOpenOutputFile,
  onDispatchTasks,
  onSendQueuedMessageNow,
  onRemoveQueuedMessage,
  onSendMemberMessage,
  dispatchMode = 'now',
}: AgentOfficeRuntimeProps) {
  const t = useTranslation()
  const copy = useMemo(() => resolveAgentOfficeCopy(t), [t])
  const mainStatusCopy = {
    foreground: t('agentOffice.mainStatus.foreground'),
    supervising: t('agentOffice.mainStatus.supervising'),
    background: t('agentOffice.mainStatus.background'),
    ready: t('agentOffice.mainStatus.ready'),
    blocked: t('agentOffice.mainStatus.blocked'),
    idle: t('agentOffice.mainStatus.idle'),
  }
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [memberMessage, setMemberMessage] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const taskRows = activity.model.sections.tasks.rows
  const queueRows = activity.model.sections.queue.rows
  const agentRows = [
    ...activity.model.sections.team.rows,
    ...activity.model.sections.subagents.rows,
    ...activity.model.sections.backgroundTasks.rows,
  ]
  const allRows = [...taskRows, ...queueRows, ...agentRows]
  const projection = projectOfficeActivity(allRows, now)
  const agentProjection = projectOfficeActivity(agentRows, now)
  const visibleRows = projection.liveRows
  const activeRows = projection.activeRows
  const completedRows = projection.completedRows
  const failedRows = projection.failedRows
  const hasTimedFailure = failedRows.some((row) => row.updatedAt)
  const liveAgentRows = agentProjection.liveRows
  const activeAgents = liveAgentRows.filter((row) => ACTIVE_STATUSES.has(row.status)).length
  const officeActivity = useMemo(() => ({
    ...activity,
    model: {
      ...activity.model,
      sections: {
        ...activity.model.sections,
        tasks: { ...activity.model.sections.tasks, rows: projectOfficeActivity(taskRows, now).liveRows },
        team: { ...activity.model.sections.team, rows: projectOfficeActivity(activity.model.sections.team.rows, now).liveRows },
        subagents: { ...activity.model.sections.subagents, rows: projectOfficeActivity(activity.model.sections.subagents.rows, now).liveRows },
        backgroundTasks: { ...activity.model.sections.backgroundTasks, rows: projectOfficeActivity(activity.model.sections.backgroundTasks.rows, now).liveRows },
        queue: { ...activity.model.sections.queue, rows: queueRows },
      },
    },
  }), [activity, now, queueRows, taskRows])
  const agents = useMemo(
    () => adaptActivityToOfficeRoster(officeActivity, copy),
    [copy, officeActivity],
  )

  useEffect(() => {
    if (!hasTimedFailure) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [hasTimedFailure])

  return (
    <div
      data-testid="agent-office-runtime"
      className="flex h-full min-h-[420px] w-full flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-text-primary)] shadow-sm"
    >
      <div className="grid shrink-0 grid-cols-2 gap-3 border-b border-[var(--color-border)] p-3 lg:grid-cols-4">
        <StatCard label={copy.stats.active} value={activeRows.length} hint={copy.stats.activeHint} />
        <StatCard label={copy.stats.completed} value={completedRows.length} hint={copy.stats.completedHint} />
        <StatCard label={copy.stats.attention} value={failedRows.length} hint={copy.stats.attentionHint} />
        <StatCard label={copy.stats.employees} value={`${activeAgents}/${liveAgentRows.length}`} hint={copy.stats.employeesHint} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="relative min-h-[420px] min-w-0 flex-1 overflow-hidden bg-[var(--color-surface-container-lowest)]">
          <OfficeCanvas
            agents={agents}
            copy={copy}
            selectedSourceKey={selectedSourceKey}
            onSelectAgent={setSelectedSourceKey}
          />
          <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-4 py-2 text-center shadow-lg backdrop-blur">
            <strong className="block text-xs text-[var(--color-text-primary)]">{t('agentOffice.canvasTitle')}</strong>
            <span className="block max-w-[360px] truncate text-[10px] text-[var(--color-text-tertiary)]">{sessionId}</span>
          </div>
        </main>

        <aside className="flex max-h-[42%] w-full shrink-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-surface-container-low)] lg:max-h-none lg:w-[280px] lg:border-l lg:border-t-0">
          <section className="min-h-0 flex-1 overflow-auto p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{copy.flowHeading}</h2>
              <div className="flex items-center gap-2">
                {onDismissActivityRows && failedRows.some((row) => row.dismissKey) ? (
                  <button
                    type="button"
                    onClick={() => onDismissActivityRows(failedRows.flatMap((row) => row.dismissKey ? [row.dismissKey] : []))}
                    className="rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                  >
                    {t('session.activity.clearFinished')}
                  </button>
                ) : null}
                <span className="text-[11px] text-[var(--color-text-tertiary)]">{visibleRows.length}</span>
              </div>
            </div>
            {selectedTaskIds.length > 0 && onDispatchTasks ? (
              <button
                type="button"
                aria-label={t(dispatchMode === 'now' ? 'agentOffice.task.processSelected' : 'agentOffice.task.queueSelected')}
                onClick={() => onDispatchTasks([...selectedTaskIds].sort())}
                className="mb-3 w-full rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-medium text-[var(--color-on-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              >
                {t(dispatchMode === 'now' ? 'agentOffice.task.processSelected' : 'agentOffice.task.queueSelected')} ({selectedTaskIds.length})
              </button>
            ) : null}

            <div className="space-y-2" data-testid="agent-office-live-status">
              {visibleRows.length > 0 ? visibleRows.slice(0, 8).map((row) => {
                const sourceKey = `${row.section}:${row.id}`
                const selected = selectedSourceKey === sourceKey
                const canOpenSubagent = row.section === 'subagents' && Boolean(row.toolUseId && onOpenSubagent)
                const canOpenMember = row.section === 'team' && Boolean(row.member && onOpenMember)
                const canStop = row.section === 'backgroundTasks' && row.status === 'running' && Boolean(row.taskId && onStopBackgroundTask)
                const canOpenOutput = Boolean(row.outputFile && onOpenOutputFile)
                const isReadyTask = row.section === 'tasks' && row.status === 'pending' && (row.blockedBy?.length ?? 0) === 0
                const isQueue = row.section === 'queue' && Boolean(row.queuedMessageId)
                const isMember = row.section === 'team' && Boolean(row.member)
                return (
                  <article key={sourceKey} className={`rounded-xl border shadow-sm transition-colors motion-reduce:transition-none ${
                    selected
                      ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-container)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]'
                  }`}>
                    <div className="flex items-start gap-2 p-3">
                      {row.section === 'tasks' ? (
                        <input
                          type="checkbox"
                          aria-label={t('agentOffice.task.select', { task: row.label })}
                          disabled={!isReadyTask}
                          checked={selectedTaskIds.includes(row.taskId ?? row.id)}
                          onChange={() => {
                            const taskId = row.taskId ?? row.id
                            setSelectedTaskIds((current) => current.includes(taskId)
                              ? current.filter(id => id !== taskId)
                              : [...current, taskId])
                          }}
                          className="mt-0.5"
                        />
                      ) : null}
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSelectedSourceKey((current) => current === sourceKey ? null : sourceKey)}
                        className="min-w-0 flex-1 rounded-lg text-left hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                      >
                      <span className="flex items-start justify-between gap-2">
                        <strong className="min-w-0 truncate text-xs text-[var(--color-text-primary)]">{row.label}</strong>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                          FAILED_STATUSES.has(row.status)
                            ? 'bg-[var(--color-error-container)] text-[var(--color-error)]'
                            : ACTIVE_STATUSES.has(row.status)
                              ? 'bg-[var(--color-primary-fixed)] text-[var(--color-primary)]'
                              : 'bg-[var(--color-surface-container-high)] text-[var(--color-text-secondary)]'
                        }`}>
                          {statusLabel(row.status, copy.status)}
                        </span>
                      </span>
                        {rowDescription(row) ? (
                          <span className="mt-1 block line-clamp-2 text-[11px] leading-4 text-[var(--color-text-secondary)]">{rowDescription(row)}</span>
                        ) : null}
                        {row.owner ? <span className="mt-1 block text-[10px] text-[var(--color-text-tertiary)]">{t('agentOffice.task.owner', { owner: row.owner })}</span> : null}
                        {row.ownedTask ? <span className="mt-1 block text-[10px] text-[var(--color-text-tertiary)]">{t('agentOffice.task.assignedTask', { id: row.ownedTask.taskId ?? row.ownedTask.id, task: row.ownedTask.label })}</span> : null}
                        {(row.blockedBy?.length ?? 0) > 0 ? <span className="mt-1 block text-[10px] text-[var(--color-warning)]">{t('agentOffice.task.blockedBy', { tasks: row.blockedBy!.join(', ') })}</span> : null}
                        {row.stale ? <span className="mt-1 block text-[10px] text-[var(--color-warning)]">{t('agentOffice.queue.stale')}</span> : null}
                      </button>
                    </div>
                    {selected && (canOpenSubagent || canOpenMember || canStop || canOpenOutput || isReadyTask || isQueue || isMember) ? (
                      <div className="flex flex-wrap gap-1 border-t border-[var(--color-border)] px-3 py-2">
                        {isReadyTask && onDispatchTasks ? (
                          <button type="button" onClick={() => onDispatchTasks([row.taskId ?? row.id])} className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
                            {t(dispatchMode === 'now' ? 'agentOffice.task.processOne' : 'agentOffice.task.queueOne')}
                          </button>
                        ) : null}
                        {canOpenSubagent ? (
                          <button
                            type="button"
                            onClick={() => onOpenSubagent?.({ sessionId, toolUseId: row.toolUseId!, title: row.label })}
                            className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                          >
                            {t('session.activity.fullRun')}
                          </button>
                        ) : null}
                        {canOpenMember ? (
                          <button
                            type="button"
                            onClick={() => onOpenMember?.(row.member!)}
                            className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                          >
                            {t('session.activity.openTeamMember', { name: row.label })}
                          </button>
                        ) : null}
                        {canStop ? (
                          <button
                            type="button"
                            onClick={() => onStopBackgroundTask?.(row.taskId!)}
                            className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-error)] hover:bg-[var(--color-error)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                          >
                            {t('session.activity.stopBackgroundTask', { name: row.label })}
                          </button>
                        ) : null}
                        {canOpenOutput ? (
                          <button
                            type="button"
                            onClick={() => onOpenOutputFile?.(row.outputFile!)}
                            className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                          >
                            {t('session.activity.details.outputFile')}
                          </button>
                        ) : null}
                        {isQueue && onSendQueuedMessageNow ? (
                          <button type="button" onClick={() => onSendQueuedMessageNow(row.queuedMessageId!)} className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
                            {t('agentOffice.queue.sendNow')}
                          </button>
                        ) : null}
                        {isQueue && onRemoveQueuedMessage ? (
                          <button type="button" onClick={() => onRemoveQueuedMessage(row.queuedMessageId!)} className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-error)] hover:bg-[var(--color-error)]/10">
                            {t('agentOffice.queue.remove')}
                          </button>
                        ) : null}
                        {isMember && onSendMemberMessage ? (
                          <form
                            className="flex w-full gap-1"
                            onSubmit={(event) => {
                              event.preventDefault()
                              const content = memberMessage.trim()
                              if (!content) return
                              onSendMemberMessage(row.member!, content)
                              setMemberMessage('')
                            }}
                          >
                            <input value={memberMessage} onChange={event => setMemberMessage(event.target.value)} placeholder={t('agentOffice.member.placeholder')} className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-[10px]" />
                            <button type="submit" disabled={!memberMessage.trim()} className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] disabled:opacity-50">{t('agentOffice.member.send')}</button>
                          </form>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                )
              }) : (
                <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 py-8 text-center text-xs text-[var(--color-text-tertiary)]">
                  {copy.emptyFlow}
                </div>
              )}
            </div>
          </section>

          <section className="shrink-0 border-t border-[var(--color-border)] p-4">
            <h2 className="mb-2 text-xs font-semibold text-[var(--color-text-primary)]">{copy.liveHeading}</h2>
            <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
              <span className={`h-2 w-2 rounded-full ${activity.mainAgent.status === 'idle' ? 'bg-[var(--color-text-tertiary)]' : 'bg-[var(--color-success)]'}`} />
              <span className="truncate">
                {formatMainAgentStatus(
                  copy,
                  activity.mainAgent.statusVerb || activity.mainAgent.activeToolName || mainStatusCopy[activity.mainAgent.operationalStatus],
                )}
              </span>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
