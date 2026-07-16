import { describe, expect, it } from 'vitest'
import type { Agent } from '../../types/agent'
import { OfficeSimulator } from './OfficeSimulator'

function agent(index: number, overrides: Partial<Agent> = {}): Agent {
  return {
    id: index === 0 ? 'main-agent' : `office-agent-${index + 1}`,
    name: index === 0 ? 'Main Agent' : `Agent ${index + 1}`,
    role: index === 0 ? '老板' : '团队成员',
    color: 0x4a90d9,
    x: 405 + index * 30,
    y: 225,
    state: 'idle',
    assignedDeskId: `desk-${index}`,
    facing: 1,
    viewFacing: 'front',
    sourceKey: index === 0 ? 'main-agent' : `team:agent-${index}`,
    ambientEligible: index > 0,
    ...overrides,
  }
}

const ENGLISH_AMBIENT_COPY = {
  chatTask: 'Taking a break',
  chatFirst: 'How is your day going?',
  chatSecond: 'Glad to have a breather.',
  watch: 'Watching a show',
  game: 'Playing a game',
}

describe('OfficeSimulator ambient events', () => {
  it('starts at most one chat for idle real employees and excludes the boss or busy seats', () => {
    const simulator = new OfficeSimulator({
      random: () => 0,
      ambientInterval: 10,
      ambientDuration: 6,
      copy: ENGLISH_AMBIENT_COPY,
    })
    const agents = [
      agent(0),
      agent(1),
      agent(2),
      agent(3, { state: 'working', currentTask: 'Real task' }),
      agent(4, { sourceKey: undefined }),
      agent(5, { customAnimation: 'emotes/wave' }),
    ]

    const next = simulator.tick(10, agents)
    const ambientAgents = next.filter((candidate) => candidate.ambientEventId)

    expect(ambientAgents).toHaveLength(2)
    expect(ambientAgents.map((candidate) => candidate.id)).toEqual([
      'office-agent-2',
      'office-agent-3',
    ])
    expect(ambientAgents.map((candidate) => candidate.bubbleText)).toEqual([
      'How is your day going?',
      'Glad to have a breather.',
    ])
    expect(next[0]).toMatchObject({ role: '老板', state: 'idle' })
    expect(next[0]?.ambientEventId).toBeUndefined()
    expect(next[3]).toMatchObject({ state: 'working', currentTask: 'Real task' })
  })

  it('makes the first idle event observable within twelve seconds', () => {
    const simulator = new OfficeSimulator({ random: () => 0.8 })

    const before = simulator.tick(11.9, [agent(0), agent(1)])
    const started = simulator.tick(0.1, before)

    expect(started[1]?.ambientKind).toBe('game')
  })

  it('falls back to a solo ambient event instead of wasting the interval on chat', () => {
    const simulator = new OfficeSimulator({
      random: () => 0,
      ambientInterval: 10,
      ambientDuration: 6,
      copy: ENGLISH_AMBIENT_COPY,
    })

    const next = simulator.tick(10, [agent(0), agent(1)])

    expect(next[1]?.ambientEventId).toBeDefined()
    expect(next[1]?.ambientKind).not.toBe('chat')
  })

  it('uses copy injected by the UI locale boundary for ambient text', () => {
    const simulator = new OfficeSimulator({
      random: () => 0,
      ambientInterval: 10,
      ambientDuration: 6,
      copy: ENGLISH_AMBIENT_COPY,
    })

    const next = simulator.tick(10, [agent(0), agent(1), agent(2)])

    expect(next[1]).toMatchObject({
      currentTask: 'Taking a break',
      bubbleText: 'How is your day going?',
    })
    expect(next[2]).toMatchObject({
      currentTask: 'Taking a break',
      bubbleText: 'Glad to have a breather.',
    })
    expect(next.some((candidate) => candidate.bubbleText?.includes('闲聊'))).toBe(false)
  })

  it('uses updated locale copy for the next ambient event', () => {
    const simulator = new OfficeSimulator({
      random: () => 0.8,
      ambientInterval: 10,
      ambientDuration: 6,
      copy: ENGLISH_AMBIENT_COPY,
    })
    simulator.setCopy({
      ...ENGLISH_AMBIENT_COPY,
      game: '休息·玩遊戲',
    })

    const next = simulator.tick(10, [agent(0), agent(1)])

    expect(next[1]).toMatchObject({
      currentTask: '休息·玩遊戲',
      bubbleText: '休息·玩遊戲',
    })
  })

  it('plays state-appropriate personality emotes for working employees without replacing their task', () => {
    const simulator = new OfficeSimulator({
      random: () => 0,
      ambientInterval: 10,
      ambientDuration: 6,
    })

    const next = simulator.tick(10, [
      agent(0),
      agent(1, {
        state: 'working',
        currentTask: 'Implement stable seats',
        ambientEligible: false,
      }),
    ])

    expect(next[1]).toMatchObject({
      ambientKind: 'focus',
      customAnimation: 'emotes/determined',
      currentTask: 'Implement stable seats',
      ambientResumeState: 'working',
      ambientResumeTask: 'Implement stable seats',
    })
  })

  it('allows a rare playful event during work without making it the default', () => {
    const simulator = new OfficeSimulator({
      random: () => 0.99,
      ambientInterval: 10,
      ambientDuration: 6,
    })

    const next = simulator.tick(10, [
      agent(0),
      agent(1, { state: 'working', currentTask: 'Ship release', ambientEligible: false }),
    ])

    expect(next[1]).toMatchObject({
      ambientKind: 'game',
      customAnimation: 'emotes/excited',
    })
  })

  it('restores waiting employees to their real pending state after an ambient event', () => {
    const simulator = new OfficeSimulator({
      random: () => 0.8,
      ambientInterval: 10,
      ambientDuration: 6,
    })

    const started = simulator.tick(10, [
      agent(0),
      agent(1, {
        state: 'thinking',
        currentTask: 'Wait for dependency',
        ambientEligible: true,
      }),
    ])

    expect(started[1]).toMatchObject({
      ambientKind: 'game',
      state: 'talking',
    })

    const finished = simulator.tick(6, started)
    expect(finished[1]).toMatchObject({
      state: 'thinking',
      currentTask: 'Wait for dependency',
    })
    expect(finished[1]?.ambientEventId).toBeUndefined()
  })

  it.each([
    { random: [0.4, 0], kind: 'watch', label: 'Watching a show', animation: 'emotes/idea' },
    { random: [0.8, 0], kind: 'game', label: 'Playing a game', animation: 'emotes/excited' },
  ] as const)('shows a visible timed $kind event for one eligible employee', ({ random, kind, label, animation }) => {
    let randomIndex = 0
    const simulator = new OfficeSimulator({
      random: () => random[randomIndex++] ?? 0,
      ambientInterval: 10,
      ambientDuration: 6,
    })

    const started = simulator.tick(10, [agent(0), agent(1)])

    expect(started[1]).toMatchObject({
      ambientKind: kind,
      ambientRemaining: 6,
      currentTask: label,
      bubbleText: label,
      customAnimation: animation,
    })

    const finished = simulator.tick(6, started)
    expect(finished[1]).toMatchObject({ state: 'idle' })
    expect(finished[1]?.ambientEventId).toBeUndefined()
    expect(finished[1]?.currentTask).toBeUndefined()
    expect(finished[1]?.bubbleText).toBeUndefined()
    expect(finished[1]?.customAnimation).toBeUndefined()
  })
})
