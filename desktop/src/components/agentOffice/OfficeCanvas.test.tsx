import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from './types/agent'
import { OfficeCanvas } from './OfficeCanvas'

const mocks = vi.hoisted(() => ({
  initImplementation: () => Promise.resolve(),
  instances: [] as Array<{
    init: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    syncAgents: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }>,
  resizeCallback: null as ResizeObserverCallback | null,
}))

vi.mock('./scene/OfficeScene', () => ({
  OfficeScene: class {
    init = vi.fn(() => mocks.initImplementation())
    resize = vi.fn()
    syncAgents = vi.fn()
    destroy = vi.fn()
    getAgents = vi.fn(() => [])
    requestDeskVisit = vi.fn()
    playAgentAnimation = vi.fn()

    constructor() {
      mocks.instances.push(this)
    }
  },
}))

function agent(name: string, state: Agent['state'] = 'working'): Agent {
  return {
    id: 'main-agent',
    name,
    color: 0xe85d4a,
    x: 405,
    y: 225,
    state,
    assignedDeskId: 'desk-0',
    facing: 1,
    viewFacing: 'back',
    sourceKey: 'main-agent',
  }
}

describe('OfficeCanvas', () => {
  beforeEach(() => {
    mocks.initImplementation = () => Promise.resolve()
    mocks.instances.length = 0
    mocks.resizeCallback = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        mocks.resizeCallback = callback
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    })
  })

  it('initializes one Pixi scene, syncs activity updates, and destroys it on unmount', async () => {
    const { rerender, unmount } = render(<OfficeCanvas agents={[agent('Main Agent')]} />)
    const scene = mocks.instances[0]!

    expect(scene.syncAgents).toHaveBeenCalledWith([agent('Main Agent')])

    await act(async () => {
      mocks.resizeCallback?.([{
        contentRect: { width: 960, height: 640 },
      } as ResizeObserverEntry], {} as ResizeObserver)
    })

    expect(scene.init).toHaveBeenCalledTimes(1)
    expect(scene.init).toHaveBeenCalledWith(expect.any(HTMLElement), 960, 640)

    rerender(<OfficeCanvas agents={[agent('Main Agent', 'thinking')]} />)

    expect(mocks.instances).toHaveLength(1)
    expect(scene.syncAgents).toHaveBeenLastCalledWith([agent('Main Agent', 'thinking')])

    unmount()
    expect(scene.destroy).toHaveBeenCalledTimes(1)
  })

  it('shows an error and retries scene initialization after a renderer failure', async () => {
    mocks.initImplementation = () => Promise.reject(new Error('WebGL unavailable'))
    render(<OfficeCanvas agents={[agent('Main Agent')]} />)
    const scene = mocks.instances[0]!

    await act(async () => {
      mocks.resizeCallback?.([{
        contentRect: { width: 960, height: 640 },
      } as ResizeObserverEntry], {} as ResizeObserver)
      await Promise.resolve()
    })

    expect(scene.init).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('WebGL unavailable')

    mocks.initImplementation = () => Promise.resolve()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await Promise.resolve()
    })

    expect(scene.init).toHaveBeenCalledTimes(2)
  })

  it('applies the latest observed size after initialization completes', async () => {
    const events: string[] = []
    let resolveInit: () => void = () => {}
    mocks.initImplementation = () => new Promise<void>((resolve) => {
      resolveInit = () => {
        events.push('initialized')
        resolve()
      }
    })
    render(<OfficeCanvas agents={[agent('Main Agent')]} />)
    const scene = mocks.instances[0]!
    scene.resize.mockImplementation(() => events.push('resized'))

    await act(async () => {
      mocks.resizeCallback?.([{
        contentRect: { width: 960, height: 640 },
      } as ResizeObserverEntry], {} as ResizeObserver)
      mocks.resizeCallback?.([{
        contentRect: { width: 800, height: 600 },
      } as ResizeObserverEntry], {} as ResizeObserver)
      resolveInit()
      await Promise.resolve()
    })

    expect(scene.resize).toHaveBeenLastCalledWith(800, 600)
    expect(events.slice(-2)).toEqual(['initialized', 'resized'])
  })
})
