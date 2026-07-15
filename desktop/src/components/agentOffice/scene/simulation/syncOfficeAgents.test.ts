import { describe, expect, it } from 'vitest'
import type { Agent } from '../../types/agent'
import { mergeOfficeAgentSnapshot } from './syncOfficeAgents'

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'office-agent-2',
    name: 'Agent 2',
    color: 0x4a90d9,
    x: 480,
    y: 365,
    state: 'idle',
    assignedDeskId: 'desk-1',
    facing: 1,
    viewFacing: 'front',
    ambientEligible: true,
    ...overrides,
  }
}

describe('mergeOfficeAgentSnapshot', () => {
  it('immediately interrupts ambient scene state when real work resumes', () => {
    const current = agent({
      sourceKey: 'team:designer',
      state: 'talking',
      currentTask: '摸鱼·追剧',
      bubbleText: '摸鱼·追剧',
      customAnimation: 'emotes/idea',
      ambientEventId: 'ambient-1',
      ambientKind: 'watch',
      ambientRemaining: 5,
    })
    const incoming = agent({
      sourceKey: 'team:designer',
      state: 'working',
      currentTask: 'Polish the release',
      ambientEligible: false,
    })

    const [merged] = mergeOfficeAgentSnapshot([current], [incoming])

    expect(merged).toEqual(incoming)
    expect(merged?.bubbleText).toBeUndefined()
    expect(merged?.customAnimation).toBeUndefined()
    expect(merged?.ambientEventId).toBeUndefined()
  })

  it('ends a shared ambient event for everyone when one participant resumes real work', () => {
    const current = [
      agent({
        id: 'office-agent-2',
        sourceKey: 'team:designer',
        state: 'talking',
        bubbleText: '闲聊·最近忙吗？',
        customAnimation: 'emotes/laugh',
        ambientEventId: 'ambient-chat',
        ambientKind: 'chat',
        ambientRemaining: 5,
      }),
      agent({
        id: 'office-agent-3',
        sourceKey: 'team:developer',
        state: 'talking',
        bubbleText: '闲聊·刚好歇会儿。',
        customAnimation: 'emotes/laugh',
        ambientEventId: 'ambient-chat',
        ambientKind: 'chat',
        ambientRemaining: 5,
      }),
    ]
    const incoming = [
      agent({
        id: 'office-agent-2',
        sourceKey: 'team:designer',
        state: 'working',
        currentTask: 'Real design work',
        ambientEligible: false,
      }),
      agent({
        id: 'office-agent-3',
        sourceKey: 'team:developer',
        state: 'idle',
      }),
    ]

    const merged = mergeOfficeAgentSnapshot(current, incoming)

    expect(merged).toEqual(incoming)
  })

  it('keeps an active ambient event across matching real idle snapshots', () => {
    const current = agent({
      sourceKey: 'team:designer',
      state: 'talking',
      currentTask: '摸鱼·打游戏',
      bubbleText: '摸鱼·打游戏',
      customAnimation: 'emotes/excited',
      ambientEventId: 'ambient-2',
      ambientKind: 'game',
      ambientRemaining: 4,
    })
    const incoming = agent({ sourceKey: 'team:designer', state: 'idle' })

    const [merged] = mergeOfficeAgentSnapshot([current], [incoming])

    expect(merged).toMatchObject({
      state: 'talking',
      currentTask: '摸鱼·打游戏',
      bubbleText: '摸鱼·打游戏',
      customAnimation: 'emotes/excited',
      ambientEventId: 'ambient-2',
      ambientKind: 'game',
      ambientRemaining: 4,
    })
  })

  it('updates real activity fields without resetting an active desk visit', () => {
    const current = agent({
      name: 'Researcher',
      sourceKey: 'subagents:research-1',
      x: 612,
      y: 284,
      targetX: 650,
      targetY: 300,
      walkPath: [{ x: 650, y: 300 }],
      walkPathIndex: 0,
      state: 'walking',
      currentTask: 'Dispatching…',
      mission: {
        kind: 'desk_visit',
        phase: 'goto',
        hostAgentId: 'office-agent-3',
        hostDeskId: 'desk-2',
        message: 'The context is ready.',
        resumeState: 'working',
        resumeTask: 'Inspect sources',
        talkDuration: 3.5,
        queue: [],
      },
    })
    const incoming = agent({
      name: 'Research Agent',
      sourceKey: 'subagents:research-1',
      state: 'working',
      currentTask: 'Summarize findings',
    })

    const [merged] = mergeOfficeAgentSnapshot([current], [incoming])

    expect(merged).toMatchObject({
      name: 'Research Agent',
      sourceKey: 'subagents:research-1',
      x: 612,
      y: 284,
      targetX: 650,
      targetY: 300,
      state: 'walking',
      currentTask: 'Dispatching…',
      mission: {
        phase: 'goto',
        resumeTask: 'Summarize findings',
      },
    })
  })
})
