import type { TranslationKey } from '../../i18n'
import type { OfficeActivityCopy } from './officeActivityAdapter'
import type { OfficeAmbientCopy } from './scene/simulation/OfficeSimulator'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

export type AgentOfficeAgentState = 'idle' | 'thinking' | 'working' | 'walking' | 'talking'

export type AgentOfficeHandoffCopy = {
  delivering: string
  handingOff: string
  receiving: string
  wrappingUp: string
  planning: string
}

export type AgentOfficeCopy = OfficeActivityCopy & OfficeAmbientCopy & {
  mainAgentStatus: string
  agentState: Record<AgentOfficeAgentState, string>
  earlierTasks: string
  handoffStatus: AgentOfficeHandoffCopy
  handoffVisitMessages: readonly string[]
  status: {
    running: string
    pending: string
    completed: string
    failed: string
  }
  stats: {
    active: string
    activeHint: string
    completed: string
    completedHint: string
    attention: string
    attentionHint: string
    employees: string
    employeesHint: string
  }
  flowHeading: string
  emptyFlow: string
  liveHeading: string
  interactionHint: string
  agentRosterLabel: string
  retry: string
  interact: string
  emotesHeading: string
  backToActions: string
  interactWith: string
  visitMessage: string
  emotes: {
    determined: string
    thinking: string
    idea: string
    excited: string
    hooray: string
    wave: string
    laugh: string
    confused: string
  }
}

export function resolveAgentOfficeCopy(t: Translate): AgentOfficeCopy {
  return {
    sectionRoles: {
      team: t('agentOffice.role.team'),
      subagents: t('agentOffice.role.subagent'),
      backgroundTasks: t('agentOffice.role.operations'),
      tasks: t('agentOffice.role.project'),
    },
    mainAgentName: t('agentOffice.mainAgentName'),
    mainAgentRole: t('agentOffice.role.lead'),
    working: t('agentOffice.status.working'),
    mainAgentStatus: t('agentOffice.mainAgentStatus'),
    agentState: {
      idle: t('agentOffice.agentState.idle'),
      thinking: t('agentOffice.agentState.thinking'),
      working: t('agentOffice.agentState.working'),
      walking: t('agentOffice.agentState.walking'),
      talking: t('agentOffice.agentState.talking'),
    },
    earlierTasks: t('agentOffice.earlierTasks'),
    handoffStatus: {
      delivering: t('agentOffice.handoff.delivering'),
      handingOff: t('agentOffice.handoff.handingOff'),
      receiving: t('agentOffice.handoff.receiving'),
      wrappingUp: t('agentOffice.handoff.wrappingUp'),
      planning: t('agentOffice.handoff.planning'),
    },
    handoffVisitMessages: [
      t('agentOffice.handoff.visit.first'),
      t('agentOffice.handoff.visit.second'),
      t('agentOffice.handoff.visit.third'),
      t('agentOffice.handoff.visit.fourth'),
    ],
    status: {
      running: t('agentOffice.status.running'),
      pending: t('agentOffice.status.pending'),
      completed: t('agentOffice.status.completed'),
      failed: t('agentOffice.status.failed'),
    },
    stats: {
      active: t('agentOffice.stats.active'),
      activeHint: t('agentOffice.stats.activeHint'),
      completed: t('agentOffice.stats.completed'),
      completedHint: t('agentOffice.stats.completedHint'),
      attention: t('agentOffice.stats.attention'),
      attentionHint: t('agentOffice.stats.attentionHint'),
      employees: t('agentOffice.stats.employees'),
      employeesHint: t('agentOffice.stats.employeesHint'),
    },
    flowHeading: t('agentOffice.flowHeading'),
    emptyFlow: t('agentOffice.emptyFlow'),
    liveHeading: t('agentOffice.liveHeading'),
    interactionHint: t('agentOffice.interactionHint'),
    agentRosterLabel: t('agentOffice.agentRosterLabel'),
    chatTask: t('agentOffice.ambient.chatTask'),
    chatFirst: t('agentOffice.ambient.chatFirst'),
    chatSecond: t('agentOffice.ambient.chatSecond'),
    watch: t('agentOffice.ambient.watch'),
    game: t('agentOffice.ambient.game'),
    retry: t('agentOffice.actions.retry'),
    interact: t('agentOffice.actions.interact'),
    emotesHeading: t('agentOffice.actions.emotes'),
    backToActions: t('agentOffice.actions.back'),
    interactWith: t('agentOffice.actions.interactWith'),
    visitMessage: t('agentOffice.actions.visitMessage'),
    emotes: {
      determined: t('agentOffice.emote.determined'),
      thinking: t('agentOffice.emote.thinking'),
      idea: t('agentOffice.emote.idea'),
      excited: t('agentOffice.emote.excited'),
      hooray: t('agentOffice.emote.hooray'),
      wave: t('agentOffice.emote.wave'),
      laugh: t('agentOffice.emote.laugh'),
      confused: t('agentOffice.emote.confused'),
    },
  }
}

export function formatMainAgentStatus(copy: AgentOfficeCopy, status: string): string {
  return copy.mainAgentStatus.replace('{status}', status)
}

export function formatAgentOfficeState(
  copy: AgentOfficeCopy,
  state: AgentOfficeAgentState,
): string {
  return copy.agentState[state]
}

export function formatAgentOfficeRowLabel(
  copy: AgentOfficeCopy,
  row: { label: string; taskHistory?: unknown },
): string {
  return row.taskHistory ? copy.earlierTasks : row.label
}
