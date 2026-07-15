import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../types/agent'
import { DESKS } from '../layout/officeLayout'
import {
  processDeskVisitMissions,
  startDeskVisit,
  startDeskVisitTour,
} from './deskVisit'

function agent(index: number, overrides: Partial<Agent> = {}): Agent {
  const desk = DESKS[index]!
  return {
    id: index === 0 ? 'main-agent' : `office-agent-${index + 1}`,
    name: index === 0 ? 'Main Agent' : `Live Agent ${index + 1}`,
    color: 0x4a90d9,
    x: desk.seatX,
    y: desk.seatY,
    state: 'idle',
    assignedDeskId: desk.id,
    facing: 1,
    viewFacing: 'front',
    ...overrides,
  }
}

describe('desk visit live-state restoration', () => {
  it('uses the live host name before the static roster fallback', () => {
    const message = vi.fn(() => 'hello')
    startDeskVisitTour([agent(0), agent(1, { name: 'Release Captain' })], 1, [2], message)

    expect(message).toHaveBeenCalledWith(2, 'Release Captain')
  })

  it('restores a thinking host live task after the visitor finishes talking', () => {
    const host = agent(1, {
      state: 'thinking',
      currentTask: 'Waiting for production approval',
      viewFacing: 'back',
    })
    const visitor = agent(0)
    let agents = startDeskVisit([visitor, host], 1, 2, 'Status?')
    agents = agents.map((candidate) => candidate.id === visitor.id
      ? {
          ...candidate,
          x: host.x - 40,
          y: host.y,
          state: 'idle' as const,
          targetX: undefined,
          targetY: undefined,
          walkPath: undefined,
          walkPathIndex: undefined,
        }
      : candidate)

    agents = processDeskVisitMissions(0, agents, new Map())
    expect(agents[1]).toMatchObject({ state: 'talking' })

    agents = processDeskVisitMissions(4, agents, new Map())
    expect(agents[1]).toMatchObject({
      state: 'thinking',
      currentTask: 'Waiting for production approval',
      viewFacing: 'back',
    })
  })

  it('restores every host after a multi-stop tour moves to the next host', () => {
    const visitor = agent(0)
    const firstHost = agent(1, {
      state: 'thinking',
      currentTask: 'Waiting for review',
      viewFacing: 'back',
    })
    const secondHost = agent(2, {
      state: 'idle',
      currentTask: undefined,
    })
    let agents = startDeskVisitTour([visitor, firstHost, secondHost], 1, [2, 3])
    agents = agents.map((candidate) => candidate.id === visitor.id
      ? {
          ...candidate,
          x: firstHost.x - 40,
          y: firstHost.y,
          state: 'idle' as const,
          targetX: undefined,
          targetY: undefined,
          walkPath: undefined,
          walkPathIndex: undefined,
        }
      : candidate)

    agents = processDeskVisitMissions(0, agents, new Map())
    agents = processDeskVisitMissions(4, agents, new Map())

    expect(agents[1]).toMatchObject({
      state: 'thinking',
      currentTask: 'Waiting for review',
      viewFacing: 'back',
    })
  })

  it('restores an already-walking visitor path after returning home', () => {
    const visitor = agent(0, {
      x: 300,
      y: 200,
      state: 'walking',
      currentTask: 'Walking to review',
      targetX: 330,
      targetY: 220,
      walkPath: [{ x: 330, y: 220 }, { x: 360, y: 240 }],
      walkPathIndex: 0,
      viewFacing: 'right',
    })
    const host = agent(1)
    let agents = startDeskVisit([visitor, host], 1, 2, 'Status?')
    const mission = agents[0]!.mission!
    agents = agents.map((candidate) => candidate.id === visitor.id
      ? {
          ...candidate,
          x: DESKS[0]!.seatX,
          y: DESKS[0]!.seatY,
          state: 'idle' as const,
          targetX: undefined,
          targetY: undefined,
          walkPath: undefined,
          walkPathIndex: undefined,
          mission: { ...mission, phase: 'return' as const },
        }
      : candidate)

    const finished = processDeskVisitMissions(0, agents, new Map())

    expect(finished[0]).toMatchObject({
      state: 'walking',
      currentTask: 'Walking to review',
      targetX: 330,
      targetY: 220,
      walkPath: [{ x: 330, y: 220 }, { x: 360, y: 240 }],
      walkPathIndex: 0,
      viewFacing: 'right',
    })
  })
})
