import { ChevronRight, UsersRound, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { useTranslation, type TranslationKey } from '../../i18n'
import type { TeamMember, TeamWorkbenchSnapshot } from '../../types/team'
import { MEMBER_AVATARS } from './agentTeamsAvatars'
import {
  getMemberAvatarKey,
  getWorkbenchPhase,
  getWorkbenchProgress,
  type WorkbenchPhase,
} from './agentTeamsModel'

/** Faces beyond this collapse into a `+N`, so the strip never wraps. */
const MAX_STACKED_AVATARS = 5

function phaseTone(phase: WorkbenchPhase): Tone {
  if (phase === 'forming') return 'warning'
  if (phase === 'running') return 'brand'
  if (phase === 'finishing') return 'info'
  return 'success'
}

function AvatarStack({
  members,
  leadAgentId,
  size,
}: {
  members: TeamMember[]
  leadAgentId: string | undefined
  size: number
}) {
  const shown = members.slice(0, MAX_STACKED_AVATARS)
  const overflow = members.length - shown.length
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      {shown.map((member, index) => (
        <span
          key={member.agentId}
          className="inline-flex items-center justify-center rounded-full bg-[var(--color-surface-container)] ring-1 ring-[var(--color-surface)]"
          style={{
            width: size,
            height: size,
            marginLeft: index === 0 ? 0 : -Math.round(size * 0.32),
            zIndex: shown.length - index,
          }}
        >
          <img
            src={MEMBER_AVATARS[getMemberAvatarKey(member, member.agentId === leadAgentId)]}
            alt=""
            draggable={false}
            className="select-none object-contain"
            style={{ width: size - 2, height: size - 2 }}
          />
        </span>
      ))}
      {overflow > 0 ? (
        <span
          className="inline-flex items-center justify-center rounded-full bg-[var(--color-surface-container)] font-mono text-[9px] font-extrabold text-[var(--color-text-secondary)] ring-1 ring-[var(--color-surface)]"
          style={{ width: size, height: size, marginLeft: -Math.round(size * 0.32) }}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  )
}

/**
 * The always-visible trace of a running team in the main session header. It
 * opens the full workbench directly; a team never takes over the chat's
 * right-hand panel.
 */
export function AgentTeamsStrip({
  snapshot,
  onOpen,
  onHide,
  compact,
}: {
  snapshot: TeamWorkbenchSnapshot
  onOpen: () => void
  /** Hides this team's strip for the session. Omitted renders no hide control. */
  onHide?: () => void
  compact: boolean
}) {
  const t = useTranslation()
  const phase = getWorkbenchPhase(snapshot)
  const progress = getWorkbenchProgress(snapshot)
  const members = snapshot.team.members

  return (
    <div
      className={[
        'group/strip mt-2 flex w-full max-w-full items-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] transition-colors',
        'hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)]',
        'focus-within:ring-2 focus-within:ring-[var(--color-border-focus)]',
      ].join(' ')}
    >
      <button
        type="button"
        data-testid="agent-teams-strip"
        onClick={onOpen}
        title={snapshot.team.name}
        className={[
          'flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left',
          'focus-visible:outline-none',
          compact ? 'text-[11px]' : 'text-[12px]',
        ].join(' ')}
      >
        <UsersRound size={compact ? 13 : 14} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-[var(--color-brand)]" />
        <span className="shrink-0 font-semibold text-[var(--color-text-primary)]">
          {t('agentTeams.strip.label')}
        </span>
        <AvatarStack members={members} leadAgentId={snapshot.team.leadAgentId} size={compact ? 18 : 20} />
        <span className="flex shrink-0 items-center gap-1 text-[var(--color-text-tertiary)]">
          <StatusDot tone={phaseTone(phase)} pulse={phase === 'running'} />
          {t(`agentTeams.phase.${phase}` as TranslationKey)}
        </span>
        {progress.total > 0 ? (
          <span className="shrink-0 tabular-nums text-[var(--color-text-secondary)]">
            {t('agentTeams.inline.tasks', { completed: progress.completed, total: progress.total })}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 font-medium text-[var(--color-brand)]">
          {t('agentTeams.inline.open')}
          <ChevronRight size={12} strokeWidth={2.4} aria-hidden="true" />
        </span>
      </button>
      {onHide ? (
        <button
          type="button"
          data-testid="agent-teams-strip-hide"
          onClick={onHide}
          title={t('agentTeams.strip.hide')}
          aria-label={t('agentTeams.strip.hide')}
          className="mr-1 shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--color-text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--color-surface-container)] hover:text-[var(--color-text-primary)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] group-hover/strip:opacity-100"
        >
          <X size={compact ? 12 : 13} strokeWidth={2.4} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * The in-transcript record of the team being formed. It sits where the
 * TeamCreate call happened so scrolling back through the conversation still
 * shows that this turn handed work to a team.
 */
export function AgentTeamsInlineCard({
  snapshot,
  teamName,
  fallbackPhase = 'forming',
  phaseOverride,
  onOpen,
  children,
}: {
  snapshot?: TeamWorkbenchSnapshot
  teamName: string
  fallbackPhase?: WorkbenchPhase
  phaseOverride?: WorkbenchPhase
  onOpen?: () => void
  children?: ReactNode
}) {
  const t = useTranslation()
  const phase = phaseOverride ?? (snapshot ? getWorkbenchPhase(snapshot) : fallbackPhase)
  const progress = snapshot ? getWorkbenchProgress(snapshot) : { completed: 0, total: 0 }
  const members = snapshot?.team.members ?? []
  const canOpen = Boolean(snapshot && onOpen)

  return (
    <div className="mb-5 px-1">
      <button
        type="button"
        data-testid="agent-teams-inline-card"
        onClick={onOpen}
        disabled={!canOpen}
        className="flex w-full items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3.5 py-2.5 text-left shadow-[var(--shadow-card)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      >
        {members.length > 0 ? (
          <AvatarStack members={members} leadAgentId={snapshot?.team.leadAgentId} size={30} />
        ) : (
          <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-container)] text-[var(--color-brand)] ring-1 ring-[var(--color-border)]">
            <UsersRound size={16} strokeWidth={2.2} aria-hidden="true" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate font-mono text-[12px] font-extrabold text-[var(--color-text-primary)]">
              {teamName}
            </span>
            <Badge tone={phaseTone(phase)} size="xs" bordered>
              {t(`agentTeams.phase.${phase}` as TranslationKey)}
            </Badge>
          </span>
          {snapshot ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)]">
              <span>{t('agentTeams.inline.created', { count: members.length })}</span>
              {progress.total > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">
                    {t('agentTeams.inline.tasks', { completed: progress.completed, total: progress.total })}
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
        </span>
        {canOpen ? (
          <span className="flex shrink-0 items-center gap-0.5 text-[11.5px] font-medium text-[var(--color-brand)]">
            {t('agentTeams.inline.open')}
            <ChevronRight size={13} strokeWidth={2.4} aria-hidden="true" />
          </span>
        ) : null}
      </button>
      {children}
    </div>
  )
}
