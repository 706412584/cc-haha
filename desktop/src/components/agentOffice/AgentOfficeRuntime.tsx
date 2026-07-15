import { useMemo } from 'react'
import type { ActivityRow } from '../activity/sessionActivityModel'
import type { SessionActivitySnapshot } from '../activity/useSessionActivityModel'
import { adaptActivityToOfficeRoster } from './officeActivityAdapter'
import { OfficeCanvas } from './OfficeCanvas'

const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'running'])
const COMPLETED_STATUSES = new Set(['completed'])
const FAILED_STATUSES = new Set(['failed', 'error'])

function statusLabel(status: ActivityRow['status']): string {
  if (status === 'running' || status === 'in_progress') return '进行中'
  if (status === 'pending') return '等待中'
  if (status === 'completed') return '已完成'
  if (status === 'failed' || status === 'error') return '异常'
  return String(status)
}

function rowDescription(row: ActivityRow): string {
  return row.description || row.summary || row.label
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-black/[0.07] bg-white px-4 py-3 shadow-sm">
      <p className="text-[11px] font-medium text-neutral-500">{label}</p>
      <strong className="mt-0.5 block text-2xl font-semibold tracking-tight text-neutral-900">{value}</strong>
      <span className="text-[11px] text-neutral-400">{hint}</span>
    </section>
  )
}

export function AgentOfficeRuntime({
  sessionId,
  activity,
}: {
  sessionId: string
  activity: SessionActivitySnapshot
}) {
  const agents = useMemo(() => adaptActivityToOfficeRoster(activity), [activity])
  const taskRows = activity.model.sections.tasks.rows
  const agentRows = [
    ...activity.model.sections.team.rows,
    ...activity.model.sections.subagents.rows,
    ...activity.model.sections.backgroundTasks.rows,
  ]
  const allRows = [...taskRows, ...agentRows]
  const visibleRows = allRows.filter(
    (row) => ACTIVE_STATUSES.has(row.status) || FAILED_STATUSES.has(row.status),
  )
  const activeRows = allRows.filter((row) => ACTIVE_STATUSES.has(row.status))
  const completedRows = allRows.filter((row) => COMPLETED_STATUSES.has(row.status))
  const failedRows = allRows.filter((row) => FAILED_STATUSES.has(row.status))
  const liveAgentRows = agentRows.filter(
    (row) => ACTIVE_STATUSES.has(row.status) || FAILED_STATUSES.has(row.status),
  )
  const activeAgents = liveAgentRows.filter((row) => ACTIVE_STATUSES.has(row.status)).length

  return (
    <div
      data-testid="agent-office-runtime"
      className="flex h-full min-h-[420px] w-full flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-[#f7f7f5] text-neutral-800 shadow-sm"
    >
      <div className="grid shrink-0 grid-cols-4 gap-3 border-b border-black/[0.07] p-3">
        <StatCard label="进行中" value={activeRows.length} hint="真实任务与 Agent" />
        <StatCard label="已完成" value={completedRows.length} hint="当前活动记录" />
        <StatCard label="待处理" value={failedRows.length} hint="异常或阻塞" />
        <StatCard label="AI 员工" value={`${activeAgents}/${liveAgentRows.length}`} hint="在线活动" />
      </div>

      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1 overflow-hidden bg-white">
          <OfficeCanvas agents={agents} />
          <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-xl border border-black/[0.06] bg-white/90 px-4 py-2 text-center shadow-lg backdrop-blur">
            <strong className="block text-xs text-neutral-700">Agent Office</strong>
            <span className="block max-w-[360px] truncate text-[10px] text-neutral-400">{sessionId}</span>
          </div>
        </main>

        <aside className="flex w-[260px] shrink-0 flex-col border-l border-black/[0.07] bg-[#fafaf9]">
          <section className="min-h-0 flex-1 overflow-auto p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-800">当前任务流</h2>
              <span className="text-[11px] text-neutral-400">{visibleRows.length}</span>
            </div>

            <div className="space-y-2" data-testid="agent-office-live-status">
              {visibleRows.length > 0 ? visibleRows.slice(0, 8).map((row) => (
                <article key={`${row.section}:${row.id}`} className="rounded-xl border border-black/[0.07] bg-white p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <strong className="min-w-0 truncate text-xs text-neutral-800">{row.label}</strong>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                      FAILED_STATUSES.has(row.status)
                        ? 'bg-red-50 text-red-600'
                        : ACTIVE_STATUSES.has(row.status)
                          ? 'bg-blue-50 text-blue-600'
                          : 'bg-neutral-100 text-neutral-500'
                    }`}>
                      {statusLabel(row.status)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-neutral-500">{rowDescription(row)}</p>
                </article>
              )) : (
                <div className="rounded-xl border border-dashed border-black/10 bg-white/60 px-4 py-8 text-center text-xs text-neutral-400">
                  等待真实任务或 SubAgent
                </div>
              )}
            </div>
          </section>

          <section className="shrink-0 border-t border-black/[0.07] p-4">
            <h2 className="mb-2 text-xs font-semibold text-neutral-700">实时状态</h2>
            <div className="flex items-center gap-2 text-[11px] text-neutral-500">
              <span className={`h-2 w-2 rounded-full ${activity.mainAgent.status === 'idle' ? 'bg-neutral-300' : 'bg-emerald-500'}`} />
              <span className="truncate">
                Main Agent · {activity.mainAgent.statusVerb || activity.mainAgent.activeToolName || activity.mainAgent.status}
              </span>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
