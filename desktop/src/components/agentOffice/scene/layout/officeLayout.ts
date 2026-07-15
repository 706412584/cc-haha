import type { Agent, AgentState, Desk } from '../../types/agent'

export const SCENE_WIDTH = 960
export const SCENE_HEIGHT = 640

export const COLORS = {
  floor: 0xffffff,
  wall: 0xe8e6e1,
  desk: 0xffffff,
  deskShadow: 0x00000014,
  monitor: 0x2a2a2a,
  chair: 0xd4d2cc,
  agentBody: 0x1a1a1a,
} as const

const DESK_COLS = 2
const DESK_ROWS = 3
const DESK_COL_GAP = 150
const DESK_ROW_GAP = 140
const DESK_BLOCK_WIDTH = (DESK_COLS - 1) * DESK_COL_GAP
const DESK_BLOCK_HEIGHT = (DESK_ROWS - 1) * DESK_ROW_GAP
const DESK_ORIGIN_X = (SCENE_WIDTH - DESK_BLOCK_WIDTH) / 2
const DESK_ORIGIN_Y = (SCENE_HEIGHT - DESK_BLOCK_HEIGHT) / 2
export const SEAT_OFFSET_Y = 45

function buildDesks(): Desk[] {
  const desks: Desk[] = []
  let n = 0
  for (let row = 0; row < DESK_ROWS; row++) {
    for (let col = 0; col < DESK_COLS; col++) {
      const x = DESK_ORIGIN_X + col * DESK_COL_GAP
      const y = DESK_ORIGIN_Y + row * DESK_ROW_GAP
      desks.push({ id: `desk-${n}`, x, y, seatX: x, seatY: y + SEAT_OFFSET_Y })
      n++
    }
  }
  return desks
}

export const DESKS = buildDesks()

export type AgentRosterEntry = {
  id: string
  name: string
  color: number
  task: string
}

export const AGENT_ROSTER: AgentRosterEntry[] = [
  { id: 'main-agent', name: 'Main Agent', color: 0xe85d4a, task: 'Waiting for work' },
  { id: 'office-agent-2', name: 'Agent 2', color: 0x4a90d9, task: 'Waiting for work' },
  { id: 'office-agent-3', name: 'Agent 3', color: 0x9b6dd7, task: 'Waiting for work' },
  { id: 'office-agent-4', name: 'Agent 4', color: 0xf5c542, task: 'Waiting for work' },
  { id: 'office-agent-5', name: 'Agent 5', color: 0xf97316, task: 'Waiting for work' },
  { id: 'office-agent-6', name: 'Agent 6', color: 0x4ecdc4, task: 'Waiting for work' },
]

function buildInitialAgents(): Agent[] {
  return AGENT_ROSTER.map((entry, index) => {
    const desk = DESKS[index]!
    const state: AgentState = 'idle'
    return {
      id: entry.id,
      name: entry.name,
      color: entry.color,
      x: desk.seatX,
      y: desk.seatY,
      state,
      assignedDeskId: desk.id,
      facing: index % 2 === 0 ? 1 : -1,
      viewFacing: 'front',
    }
  })
}

export const INITIAL_AGENTS = buildInitialAgents()

export const HANDOFF_STATUS = {
  delivering: 'Dispatching…',
  handingOff: 'Handing off…',
  receiving: 'Receiving handoff…',
  wrappingUp: 'Returning to desk…',
  planning: 'Planning handoff…',
} as const

const HANDOFF_VISIT_MESSAGES: ((hostName: string) => string)[] = [
  (name) => `${name}, this one is yours.`,
  (name) => `${name}, the latest context is ready.`,
  (name) => `${name}, please take it from here.`,
  (name) => `${name}, I have unblocked your queue.`,
]

export function pickHandoffVisitMessage(hostName: string, hostRosterNo: number): string {
  const index = Math.abs(hostRosterNo - 1) % HANDOFF_VISIT_MESSAGES.length
  return HANDOFF_VISIT_MESSAGES[index]!(hostName)
}
