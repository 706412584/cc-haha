import { describe, expect, it } from 'vitest'
import type { Agent } from '../../types/agent'
import { reconcileOfficeRoster, tickRetainedOfficeRoster } from './reconcileOfficeRoster'

function slot(index: number, sourceKey?: string): Agent {
  return {
    id: index === 0 ? 'main-agent' : `office-agent-${index + 1}`,
    name: sourceKey ?? `Agent ${index + 1}`,
    role: sourceKey ? 'Team member' : undefined,
    color: 0x4a90d9,
    x: 100 + index * 10,
    y: 200,
    state: sourceKey ? 'working' : 'idle',
    assignedDeskId: `desk-${index}`,
    facing: 1,
    sourceKey,
  }
}

describe('reconcileOfficeRoster', () => {
  it('keeps a source on its previous desk when row ordering changes', () => {
    const current = [slot(0, 'main-agent'), slot(1, 'team:a'), slot(2, 'team:b'), slot(3)]
    const incoming = [slot(0, 'main-agent'), slot(1, 'team:b'), slot(2, 'team:a'), slot(3)]

    const next = reconcileOfficeRoster(current, incoming)

    expect(next[1]?.sourceKey).toBe('team:a')
    expect(next[2]?.sourceKey).toBe('team:b')
  })

  it('retains a completed source as an ambient-eligible idle employee before releasing the desk', () => {
    const current = [slot(0, 'main-agent'), slot(1, 'tasks:done'), slot(2)]
    const incoming = [slot(0, 'main-agent'), slot(1), slot(2)]

    const retained = reconcileOfficeRoster(current, incoming, 30)
    expect(retained[1]).toMatchObject({
      sourceKey: 'tasks:done',
      state: 'idle',
      currentTask: undefined,
      ambientEligible: true,
      retainedIdleRemaining: 30,
    })

    const released = tickRetainedOfficeRoster(retained, 30, incoming)
    expect(released[1]?.sourceKey).toBeUndefined()
  })
})
