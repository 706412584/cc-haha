import type { ChatState } from '../../types/chat'
import type { ActivityRow } from '../activity/sessionActivityModel'
import type { SessionActivitySnapshot } from '../activity/useSessionActivityModel'
import type { Agent, AgentState } from './types/agent'
import { AGENT_ROSTER, INITIAL_AGENTS } from './scene/layout/officeLayout'

const ROW_ORDER = ['team', 'subagents', 'backgroundTasks', 'tasks'] as const
const LIVE_STATUSES = new Set(['pending', 'in_progress', 'running', 'failed', 'error'])

export type OfficeActivityCopy = {
  sectionRoles: Record<(typeof ROW_ORDER)[number], string>
  mainAgentName: string
  mainAgentRole: string
  working: string
}

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

const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u
const COMBINING_CHARACTER = /[\p{Mark}\uFE0E\uFE0F]/u

function splitGraphemes(text: string): string[] {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment)
  }

  const clusters: string[] = []
  for (const codePoint of Array.from(text)) {
    const previous = clusters[clusters.length - 1]
    if (
      previous &&
      (COMBINING_CHARACTER.test(codePoint) || previous.endsWith('\u200d') || codePoint === '\u200d')
    ) {
      clusters[clusters.length - 1] = previous + codePoint
    } else if (
      previous &&
      REGIONAL_INDICATOR.test(previous) &&
      REGIONAL_INDICATOR.test(codePoint) &&
      Array.from(previous).length === 1
    ) {
      clusters[clusters.length - 1] = previous + codePoint
    } else {
      clusters.push(codePoint)
    }
  }
  return clusters
}

function clipDeskText(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined
  const graphemes = splitGraphemes(text)
  return graphemes.length > maxLength
    ? `${graphemes.slice(0, maxLength).join('')}…`
    : text
}

function taskLabel(row: ActivityRow): string | undefined {
  const detail = row.description || row.summary
  if (!detail || detail === row.label) return undefined
  return clipDeskText(detail, 18)
}

export function adaptActivityToOfficeRoster(
  activity: SessionActivitySnapshot,
  copy: OfficeActivityCopy,
): Agent[] {
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
        name: copy.mainAgentName,
        role: copy.mainAgentRole,
        state: mainAgentState(status),
        currentTask: status === 'idle'
          ? undefined
          : activity.mainAgent.statusVerb || activity.mainAgent.activeToolName || copy.working,
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
      role: copy.sectionRoles[mapped.section],
      state: rowState(mapped.row),
      currentTask: taskLabel(mapped.row),
      ambientEligible: mapped.row.status === 'pending' || mapped.row.status === 'idle',
      sourceKey: `${mapped.section}:${mapped.row.id}`,
    }
  })
}
