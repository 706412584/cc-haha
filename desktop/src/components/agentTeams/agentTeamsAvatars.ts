import dataAnalystAvatar from '../../assets/agent-teams/data-analyst.png'
import docsCoordinatorAvatar from '../../assets/agent-teams/docs-coordinator.png'
import qaEngineerAvatar from '../../assets/agent-teams/qa-engineer.png'
import releaseEngineerAvatar from '../../assets/agent-teams/release-engineer.png'
import securityReviewerAvatar from '../../assets/agent-teams/security-reviewer.png'
import serverEngineerAvatar from '../../assets/agent-teams/server-engineer.png'
import teamLeadAvatar from '../../assets/agent-teams/team-lead.png'
import uiDesignerAvatar from '../../assets/agent-teams/ui-designer.png'
import type { MemberAvatarKey } from './agentTeamsModel'

export const MEMBER_AVATARS: Record<MemberAvatarKey, string> = {
  'team-lead': teamLeadAvatar,
  'server-engineer': serverEngineerAvatar,
  'ui-designer': uiDesignerAvatar,
  'qa-engineer': qaEngineerAvatar,
  'security-reviewer': securityReviewerAvatar,
  'data-analyst': dataAnalystAvatar,
  'release-engineer': releaseEngineerAvatar,
  'docs-coordinator': docsCoordinatorAvatar,
}

export const MEMBER_ACCENTS = [
  'var(--color-brand)',
  'var(--color-warning)',
  'var(--color-success)',
  'var(--color-info)',
  'var(--color-text-secondary)',
  'var(--color-error)',
] as const

const ACCENT_COLOR_ORDER = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']

export function memberAccentColor(color: string | undefined, index: number): string {
  const colorIndex = color ? ACCENT_COLOR_ORDER.indexOf(color) : -1
  return MEMBER_ACCENTS[(colorIndex >= 0 ? colorIndex : index) % MEMBER_ACCENTS.length]!
}
