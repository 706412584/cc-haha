import { useState } from 'react'
import { StatusDot } from '@/components/ui/Badge'
import { Progress } from '@/components/ui/Progress'
import { useTeamStore } from '../../stores/teamStore'
import { useTranslation } from '../../i18n'
import type { TeamMember } from '../../types/team'

const memberStatusConfig = {
  running: {
    icon: 'pending',
    color: 'var(--color-warning)',
    pulse: true,
  },
  idle: {
    icon: 'radio_button_unchecked',
    color: 'var(--color-text-tertiary)',
    pulse: false,
  },
  completed: {
    icon: 'check_circle',
    color: 'var(--color-success)',
    pulse: false,
  },
  error: {
    icon: 'error',
    color: 'var(--color-error)',
    pulse: false,
  },
} as const

export function TeamStatusBar() {
  const t = useTranslation()
  const { activeTeam, openMemberSession } = useTeamStore()
  const [expanded, setExpanded] = useState(true)

  if (!activeTeam) return null

  // Filter out leader — main window is already the leader's view
  const members = activeTeam.members.filter(
    (m) => !activeTeam.leadAgentId || m.agentId !== activeTeam.leadAgentId,
  )
  const runningCount = members.filter((m) => m.status === 'running').length
  const completedCount = members.filter((m) => m.status === 'completed').length
  const totalCount = members.length
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const allDone = runningCount === 0 && totalCount > 0

  return (
    <div className="shrink-0 px-8">
      <div className="mx-auto max-w-[860px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-card)] overflow-hidden mb-2">
        {/* Header */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-3 px-4 py-2.5 bg-[var(--color-surface-container)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
        >
          <div className="flex items-center justify-center w-6 h-6 rounded-[var(--radius-md)] bg-[var(--color-brand-soft)]">
            <span className="material-symbols-outlined text-[14px] text-[var(--color-brand)]">groups</span>
          </div>

          <span className="text-xs font-semibold text-[var(--color-text-primary)]">
            {t('teams.team')} {activeTeam.name}
          </span>

          {/* `tone` stays explicit rather than `auto`: this bar turns green once
              nothing is running, which is not the same as reaching 100%. */}
          <Progress
            label={`${t('teams.team')} ${activeTeam.name}`}
            value={progressPercent}
            size="sm"
            tone={allDone ? 'success' : 'brand'}
            className="max-w-[200px] flex-1"
          />

          <span className="font-mono text-[10px] text-[var(--color-text-tertiary)] tabular-nums">
            {completedCount}/{totalCount}
          </span>

          {runningCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--color-warning)]">
              <StatusDot tone="warning" pulse />
              {runningCount} {t('teams.running')}
            </span>
          )}

          <span
            className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)] transition-transform duration-200"
            style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            expand_less
          </span>
        </button>

        {/* Expanded member list */}
        {expanded && (
          <div className="px-4 pb-2 pt-1 flex flex-col gap-0.5 max-h-[240px] overflow-y-auto border-t border-[var(--color-border-separator)]">
            {members.map((member) => (
              <MemberRow key={member.agentId} member={member} onView={() => openMemberSession(member)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MemberRow({ member, onView }: { member: TeamMember; onView: () => void }) {
  const config = memberStatusConfig[member.status] || memberStatusConfig.idle

  return (
    <button
      onClick={onView}
      className="w-full flex items-center gap-2 py-1.5 px-1 rounded-[var(--radius-sm)] text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] group"
    >
      <span
        className={`material-symbols-outlined text-[16px] shrink-0 ${config.pulse ? 'animate-pulse-dot' : ''}`}
        style={{ color: config.color, fontVariationSettings: "'FILL' 1" }}
      >
        {config.icon}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[12px] text-[var(--color-text-tertiary)]">smart_toy</span>
          <span className={`text-xs ${
            member.status === 'completed'
              ? 'text-[var(--color-text-tertiary)]'
              : 'text-[var(--color-text-primary)]'
          }`}>
            {member.role}
          </span>
        </div>

        {member.status === 'running' && member.currentTask && (
          <div className="flex items-center gap-1 mt-0.5">
            <StatusDot tone="warning" pulse />
            <span className="text-[10px] text-[var(--color-warning)] truncate">
              {member.currentTask}
            </span>
          </div>
        )}
      </div>

      <span className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity">
        open_in_new
      </span>
    </button>
  )
}
