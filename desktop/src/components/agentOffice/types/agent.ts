import type { ChibiFacing } from '../scene/characters/chibiAgentPresets'

export type AgentState = 'idle' | 'walking' | 'working' | 'talking' | 'thinking'

export interface DeskVisitStop {
  hostRosterNo: number
  hostAgentId: string
  hostDeskId: string
  message: string
}

export interface DeskVisitMission {
  kind: 'desk_visit'
  phase: 'goto' | 'talk' | 'return'
  hostAgentId: string
  hostDeskId: string
  message: string
  resumeState: AgentState
  resumeTask: string
  talkDuration: number
  talkRemaining?: number
  queue: DeskVisitStop[]
}

export interface Agent {
  id: string
  name: string
  role?: string
  color: number
  x: number
  y: number
  targetX?: number
  targetY?: number
  walkPath?: { x: number; y: number }[]
  walkPathIndex?: number
  state: AgentState
  currentTask?: string
  assignedDeskId?: string
  bubbleText?: string
  customAnimation?: string
  facing: 1 | -1
  viewFacing?: ChibiFacing
  mission?: DeskVisitMission
  sourceKey?: string
  ambientEligible?: boolean
  ambientEventId?: string
  ambientResumeState?: AgentState
  ambientResumeTask?: string
  ambientKind?: 'chat' | 'watch' | 'game'
  ambientRemaining?: number
}

export function formatOfficeAgentNameplate(agent: Pick<Agent, 'name' | 'role'>): string {
  return agent.role ? `${agent.role}\n${agent.name}` : agent.name
}

export interface Desk {
  id: string
  x: number
  y: number
  seatX: number
  seatY: number
  occupiedBy?: string
}
