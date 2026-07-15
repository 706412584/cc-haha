import type { ChatState } from '../../types/chat'
import type { ActivityRow } from '../activity/sessionActivityModel'
import type { SessionActivitySnapshot } from '../activity/useSessionActivityModel'
import type { Agent, AgentState } from './types/agent'
import { AGENT_ROSTER, INITIAL_AGENTS } from './scene/layout/officeLayout'

const ROW_ORDER = ['team', 'subagents', 'backgroundTasks', 'tasks'] as const
const LIVE_STATUSES = new Set(['pending', 'in_progress', 'running', 'failed', 'error'])

const SECTION_ROLES = {
  team: '团队成员',
  subagents: '研发专员',
  backgroundTasks: '运维专员',
  tasks: '项目专员',
} as const

function mainAgentState(status: ChatState): AgentState {
  if (status === 'idle') return 'idle'
  if (status === 'thinking' || status === 'compacting') return 'thinking'
  return 'working'
}

function rowState(row: ActivityRow): AgentState {
  if (row.status === 'pending') return 'thinking'
  if (row.status === 'in_progress' || row.status === 'running') return 'working'
  if (row.status === 'failed' || row.status === 'error') return 'talking'
  return 'idle'
}

function clipDeskText(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined
  const characters = Array.from(text)
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength).join('')}…`
    : text
}

function taskLabel(row: ActivityRow): string | undefined {
  const detail = row.description || row.summary
  if (!detail || detail === row.label) return undefined
  return clipDeskText(detail, 18)
}

export function adaptActivityToOfficeRoster(activity: SessionActivitySnapshot): Agent[] {
  const mappedRows = ROW_ORDER.flatMap((section) =>
    activity.model.sections[section].rows
      .filter((row) => LIVE_STATUSES.has(row.status) || (section === 'team' && row.status === 'idle'))
      .map((row) => ({ section, row })),
  )
  const rows = [
    ...mappedRows.filter(({ row }) => row.status !== 'idle'),
    ...mappedRows.filter(({ row }) => row.status === 'idle'),
  ].slice(0, INITIAL_AGENTS.length - 1)

  return INITIAL_AGENTS.map((base, index) => {
    if (index === 0) {
      const status = activity.mainAgent.status
      return {
        ...base,
        id: 'main-agent',
        name: 'Main Agent',
        role: '老板',
        state: mainAgentState(status),
        currentTask: status === 'idle'
          ? undefined
          : activity.mainAgent.statusVerb || activity.mainAgent.activeToolName || 'Working',
        sourceKey: 'main-agent',
      }
    }

    const mapped = rows[index - 1]
    if (!mapped) {
      return {
        ...base,
        name: AGENT_ROSTER[index]?.name ?? base.name,
        role: undefined,
        state: 'idle',
        currentTask: undefined,
        sourceKey: undefined,
      }
    }

    return {
      ...base,
      name: clipDeskText(mapped.row.label, 12) ?? mapped.row.label,
      role: SECTION_ROLES[mapped.section],
      state: rowState(mapped.row),
      currentTask: taskLabel(mapped.row),
      ambientEligible: mapped.row.status === 'pending' || mapped.row.status === 'idle',
      sourceKey: `${mapped.section}:${mapped.row.id}`,
    }
  })
}
