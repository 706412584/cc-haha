import { Container } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../types/agent'

vi.mock('../assets/loadSpineAssets', () => ({ isSpineReady: () => false }))
vi.mock('../ui/StatusLabel', () => ({
  StatusLabel: class extends Container {
    setName() {}
    setState() {}
    setTask() {}
    setThemePalette = vi.fn()
    layout() {}
    getLabelTopY(y: number) { return y }
  },
}))
vi.mock('../ui/Bubble', () => ({
  Bubble: class extends Container {
    static readonly TAIL_TIP_Y = -4
    show() { this.visible = true }
    hide() { this.visible = false }
    update() { return this.visible }
    setThemePalette = vi.fn()
  },
}))

import { resolveOfficeThemePalette } from '../../officeTheme'
import { AgentEntity } from './AgentEntity'

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
    ...overrides,
  }
}

describe('AgentEntity fallback visuals', () => {
  it('exposes data snapshots and updates public position state', () => {
    const entity = new AgentEntity(agent())

    entity.setPosition(12, 34)
    entity.apply({ name: 'Renamed', role: 'Reviewer', color: 0xff0000 })

    expect(entity.data).toMatchObject({
      name: 'Renamed',
      role: 'Reviewer',
      color: 0xff0000,
      x: 12,
      y: 34,
    })
    expect(entity.position).toMatchObject({ x: 12, y: 34 })
  })

  it('applies theme and selected or hover highlights through public interaction state', () => {
    const entity = new AgentEntity(agent())
    const [highlight, , , label, bubble] = entity.children as unknown as [
      { visible: boolean },
      Container,
      Container,
      Container & { setThemePalette: ReturnType<typeof vi.fn> },
      Container & { setThemePalette: ReturnType<typeof vi.fn> },
    ]
    const palette = resolveOfficeThemePalette('dark')

    entity.setThemePalette(palette)
    entity.setSelected(true)
    expect(highlight.visible).toBe(true)

    entity.setSelected(false)
    expect(highlight.visible).toBe(false)
    expect(label.setThemePalette).toHaveBeenCalledWith(palette)
    expect(bubble.setThemePalette).toHaveBeenCalledWith(palette)
  })

  it('shows, updates, and hides bubble state through public methods', () => {
    const entity = new AgentEntity(agent())
    entity.showBubble('Working', 2)
    expect(entity.data.bubbleText).toBe('Working')

    entity.apply({ bubbleText: 'Done', ambientRemaining: 1 })
    expect(entity.data.bubbleText).toBe('Done')

    entity.hideBubble()
    expect(entity.data.bubbleText).toBeUndefined()
  })

  it('updates fallback animation states and task overlays', () => {
    const entity = new AgentEntity(agent({
      state: 'walking',
      targetX: 500,
      targetY: 365,
      currentTask: 'Move',
    }))

    entity.updateVisuals('walking', 0.25)
    entity.apply({ state: 'working', currentTask: 'Implement tests' })
    entity.updateVisuals('working', 0.25)
    entity.apply({ state: 'thinking' })
    entity.updateVisuals('thinking', 0.25)

    expect(entity.data.state).toBe('thinking')
  })

  it('hides an existing bubble when a custom animation begins', () => {
    const entity = new AgentEntity(agent())
    entity.showBubble('Old message')
    const bubble = entity.children.at(-1)!
    expect(bubble.visible).toBe(true)

    entity.playCustomAnimation('emotes/wave')

    expect(entity.data.bubbleText).toBeUndefined()
    expect(bubble.visible).toBe(false)
  })

  it('mirrors only fallback character graphics, never labels or bubbles', () => {
    const entity = new AgentEntity(agent({ facing: -1 }))
    entity.updateVisuals('idle', 0)
    const [, body, scarf, label, bubble] = entity.children

    expect(entity.scale.x).toBe(1)
    expect(body?.scale.x).toBe(-1)
    expect(scarf?.scale.x).toBe(-1)
    expect(label?.scale.x).toBe(1)
    expect(bubble?.scale.x).toBe(1)
  })
})
