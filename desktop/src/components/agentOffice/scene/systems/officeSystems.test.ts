import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../types/agent'
import type { AgentEntity } from '../entities/AgentEntity'
import { DESKS } from '../layout/officeLayout'
import { AnimationSystem } from './AnimationSystem'
import { MovementSystem } from './MovementSystem'

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'main-agent',
    name: 'Main Agent',
    color: 0,
    x: 0,
    y: 0,
    state: 'idle',
    assignedDeskId: DESKS[0]!.id,
    facing: 1,
    ...overrides,
  }
}

function entity(initial: Agent) {
  let data = { ...initial }
  return {
    get data() { return data },
    apply: vi.fn((patch: Partial<Agent>) => { data = { ...data, ...patch } }),
    setPosition: vi.fn((x: number, y: number) => { data = { ...data, x, y } }),
    updateVisuals: vi.fn(),
  }
}

describe('MovementSystem', () => {
  it('assigns the first waypoint and clears stale task and bubble state', () => {
    const original = agent({ currentTask: 'Old task', bubbleText: 'Old bubble' })
    expect(MovementSystem.assignWalkPath(original, [])).toBe(original)

    expect(MovementSystem.assignWalkPath(original, [{ x: -10, y: 0 }])).toMatchObject({
      state: 'walking',
      targetX: -10,
      targetY: 0,
      walkPathIndex: 0,
      currentTask: undefined,
      bubbleText: undefined,
      viewFacing: 'left',
      facing: -1,
    })
  })

  it('moves toward a target without overshooting', () => {
    const moving = entity(agent({ state: 'walking', targetX: 100, targetY: 0 }))
    const idle = entity(agent({ id: 'idle' }))
    const entities = new Map([
      ['moving', moving],
      ['idle', idle],
    ]) as unknown as Map<string, AgentEntity>

    expect(new MovementSystem().update(entities, 0.5)).toBe(true)
    expect(moving.data).toMatchObject({ x: 45, y: 0, viewFacing: 'right' })
    expect(idle.apply).not.toHaveBeenCalled()
  })

  it('advances to the next waypoint after reaching a path point', () => {
    const moving = entity(agent({
      state: 'walking',
      x: 9,
      targetX: 10,
      targetY: 0,
      walkPath: [{ x: 10, y: 0 }, { x: 10, y: -20 }],
      walkPathIndex: 0,
    }))

    new MovementSystem().update(new Map([['moving', moving]]) as unknown as Map<string, AgentEntity>, 0.1)

    expect(moving.data).toMatchObject({
      x: 10,
      y: 0,
      walkPathIndex: 1,
      targetX: 10,
      targetY: -20,
      viewFacing: 'back',
    })
  })

  it('returns to working when the final target is the assigned desk seat', () => {
    const desk = DESKS[0]!
    const moving = entity(agent({
      state: 'walking',
      x: desk.seatX - 1,
      y: desk.seatY,
      targetX: desk.seatX,
      targetY: desk.seatY,
      currentTask: 'Continue work',
    }))

    new MovementSystem().update(new Map([['moving', moving]]) as unknown as Map<string, AgentEntity>, 0.1)

    expect(moving.data).toMatchObject({
      state: 'working',
      viewFacing: 'back',
      currentTask: 'Continue work',
      targetX: undefined,
    })
  })

  it('becomes idle and clears the task at a non-desk destination', () => {
    const moving = entity(agent({
      state: 'walking',
      x: 9,
      targetX: 10,
      targetY: 0,
      currentTask: 'Walking',
    }))

    new MovementSystem().update(new Map([['moving', moving]]) as unknown as Map<string, AgentEntity>, 0.1)

    expect(moving.data).toMatchObject({ state: 'idle', currentTask: undefined })
  })
})

describe('AnimationSystem', () => {
  it('updates every entity using its current state and frame delta', () => {
    const first = entity(agent({ state: 'thinking' }))
    const second = entity(agent({ id: 'second', state: 'working' }))
    const entities = new Map([
      ['first', first],
      ['second', second],
    ]) as unknown as Map<string, AgentEntity>

    new AnimationSystem().update(entities, 0.25)

    expect(first.updateVisuals).toHaveBeenCalledWith('thinking', 0.25)
    expect(second.updateVisuals).toHaveBeenCalledWith('working', 0.25)
  })
})
