import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
    getAgents: ReturnType<typeof vi.fn>
    requestDeskVisit: ReturnType<typeof vi.fn>
    playAgentAnimation: ReturnType<typeof vi.fn>
    setAmbientCopy: ReturnType<typeof vi.fn>
    setThemePalette: ReturnType<typeof vi.fn>
    setSelectedSourceKey: ReturnType<typeof vi.fn>
    setReducedMotion: ReturnType<typeof vi.fn>
  }>,
  agentClick: null as ((event: unknown) => void) | null,
  resizeCallback: null as ResizeObserverCallback | null,
  reducedMotionListener: null as (() => void) | null,
  reducedMotionMatches: false,
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
    setAmbientCopy = vi.fn()
    setThemePalette = vi.fn()
    setSelectedSourceKey = vi.fn()
    setReducedMotion = vi.fn()

    constructor(options: { onAgentClick: (event: unknown) => void }) {
      mocks.agentClick = options.onAgentClick
      mocks.instances.push(this)
    }
  },
}))

const ENGLISH_COPY = {
  sectionRoles: {
    team: 'Team member',
    subagents: 'Engineering specialist',
    backgroundTasks: 'Operations specialist',
    tasks: 'Project specialist',
  },
  mainAgentName: 'Main Agent',
  mainAgentRole: 'Lead',
  working: 'Working',
  mainAgentStatus: 'Main Agent · {status}',
  agentState: {
    idle: 'Idle',
    thinking: 'Thinking',
    working: 'Working',
    walking: 'Walking',
    talking: 'Talking',
  },
  earlierTasks: 'Earlier tasks',
  handoffStatus: {
    delivering: 'Dispatching…',
    handingOff: 'Handing off…',
    receiving: 'Receiving handoff…',
    wrappingUp: 'Returning to desk…',
    planning: 'Planning handoff…',
  },
  handoffVisitMessages: [
    '{name}, this one is yours.',
    '{name}, the latest context is ready.',
    '{name}, please take it from here.',
    '{name}, I have unblocked your queue.',
  ],
  status: {
    running: 'In progress',
    pending: 'Waiting',
    completed: 'Completed',
    failed: 'Needs attention',
  },
  stats: {
    active: 'In progress',
    activeHint: 'Real tasks and Agents',
    completed: 'Completed',
    completedHint: 'Current activity history',
    attention: 'Needs attention',
    attentionHint: 'Errors or blockers',
    employees: 'AI employees',
    employeesHint: 'Live activity',
  },
  flowHeading: 'Current workflow',
  emptyFlow: 'Waiting for real tasks or SubAgents',
  liveHeading: 'Live status',
  interactionHint: 'Select an employee to view actions or interact',
  agentRosterLabel: 'Office employees',
  chatTask: 'Taking a break',
  chatFirst: 'How is your day going?',
  chatSecond: 'Glad to have a breather.',
  watch: 'Watching a show',
  game: 'Playing a game',
  retry: 'Retry',
  interact: 'Interact…',
  emotesHeading: 'Emotes',
  backToActions: 'Back to actions',
  interactWith: 'Interact with {name}',
  visitMessage: '{name}, let us sync progress.',
  emotes: {
    determined: 'Determined',
    thinking: 'Thinking',
    idea: 'Idea',
    excited: 'Excited',
    hooray: 'Hooray',
    wave: 'Wave',
    laugh: 'Laugh',
    confused: 'Confused',
  },
} as const

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
    mocks.agentClick = null
    mocks.resizeCallback = null
    mocks.reducedMotionListener = null
    mocks.reducedMotionMatches = false
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return mocks.reducedMotionMatches },
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => { mocks.reducedMotionListener = listener },
      removeEventListener: (_type: string, listener: () => void) => {
        if (mocks.reducedMotionListener === listener) mocks.reducedMotionListener = null
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
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
    const { rerender, unmount } = render(<OfficeCanvas agents={[agent('Main Agent')]} copy={ENGLISH_COPY} />)
    const scene = mocks.instances[0]!

    expect(scene.syncAgents).toHaveBeenCalledWith([agent('Main Agent')])

    await act(async () => {
      mocks.resizeCallback?.([{
        contentRect: { width: 960, height: 640 },
      } as ResizeObserverEntry], {} as ResizeObserver)
    })

    expect(scene.init).toHaveBeenCalledTimes(1)
    expect(scene.init).toHaveBeenCalledWith(expect.any(HTMLElement), 960, 640)

    rerender(<OfficeCanvas agents={[agent('Main Agent', 'thinking')]} copy={ENGLISH_COPY} />)

    expect(mocks.instances).toHaveLength(1)
    expect(scene.syncAgents).toHaveBeenLastCalledWith([agent('Main Agent', 'thinking')])

    unmount()
    expect(scene.destroy).toHaveBeenCalledTimes(1)
  })

  it('shows an error and retries scene initialization after a renderer failure', async () => {
    mocks.initImplementation = () => Promise.reject(new Error('WebGL unavailable'))
    render(<OfficeCanvas agents={[agent('Main Agent')]} copy={ENGLISH_COPY} />)
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
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
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
    render(<OfficeCanvas agents={[agent('Main Agent')]} copy={ENGLISH_COPY} />)
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

  it('updates reduced-motion behavior without rebuilding the scene', () => {
    const { unmount } = render(<OfficeCanvas agents={[agent('Main Agent')]} copy={ENGLISH_COPY} />)
    const scene = mocks.instances[0]!

    expect(scene.setReducedMotion).toHaveBeenLastCalledWith(false)
    mocks.reducedMotionMatches = true
    act(() => mocks.reducedMotionListener?.())

    expect(scene.setReducedMotion).toHaveBeenLastCalledWith(true)
    expect(mocks.instances).toHaveLength(1)

    unmount()
    expect(mocks.reducedMotionListener).toBeNull()
  })

  it('updates the mounted Pixi palette when the app theme changes', async () => {
    document.documentElement.setAttribute('data-theme', 'warm-classic')
    render(<OfficeCanvas agents={[agent('Main Agent')]} copy={ENGLISH_COPY} />)
    const scene = mocks.instances[0]!

    document.documentElement.setAttribute('data-theme', 'dark')
    await act(async () => { await Promise.resolve() })

    expect(scene.setThemePalette).toHaveBeenLastCalledWith(expect.objectContaining({
      floor: 0x171917,
    }))
  })

  it('synchronizes React selection with Pixi and reports clicked source keys', () => {
    const onSelectAgent = vi.fn()
    const { rerender } = render(
      <OfficeCanvas
        agents={[agent('Main Agent')]}
        copy={ENGLISH_COPY}
        selectedSourceKey="main-agent"
        onSelectAgent={onSelectAgent}
      />,
    )
    const scene = mocks.instances[0]!

    expect(scene.setSelectedSourceKey).toHaveBeenLastCalledWith('main-agent')
    expect(screen.getByText('Select an employee to view actions or interact')).toBeInTheDocument()
    const roster = screen.getByRole('group', { name: 'Office employees' })
    expect(within(roster).getByRole('button', { name: 'Main Agent · Working' })).toHaveAttribute('aria-pressed', 'true')

    act(() => {
      mocks.agentClick?.({
        agent: agent('Main Agent'),
        rosterNo: 1,
        clientX: 100,
        clientY: 100,
      })
    })
    expect(onSelectAgent).toHaveBeenCalledWith('main-agent')

    rerender(
      <OfficeCanvas
        agents={[agent('Main Agent')]}
        copy={ENGLISH_COPY}
        selectedSourceKey={null}
        onSelectAgent={onSelectAgent}
      />,
    )
    expect(scene.setSelectedSourceKey).toHaveBeenLastCalledWith(null)
  })

  it('renders localized interaction copy without leaking Chinese labels', () => {
    render(<OfficeCanvas agents={[agent('Main Agent')]} copy={ENGLISH_COPY} />)

    act(() => {
      mocks.agentClick?.({
        agent: agent('Main Agent'),
        rosterNo: 1,
        clientX: 100,
        clientY: 100,
      })
    })

    expect(screen.getByRole('button', { name: 'Interact…' })).toBeInTheDocument()
    expect(screen.getByText('Emotes')).toBeInTheDocument()
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Wave' })).toBeInTheDocument()
    expect(screen.queryByText('互动…')).not.toBeInTheDocument()
    expect(screen.queryByText('表情动作')).not.toBeInTheDocument()
  })

  it('updates the mounted scene copy when the locale changes', () => {
    const { rerender } = render(
      <OfficeCanvas agents={[agent('Main Agent')]} copy={ENGLISH_COPY} />,
    )
    const scene = mocks.instances[0]!
    const updatedCopy = { ...ENGLISH_COPY, game: '休息·玩遊戲' }

    rerender(<OfficeCanvas agents={[agent('Main Agent')]} copy={updatedCopy} />)

    expect(mocks.instances).toHaveLength(1)
    expect(scene.setAmbientCopy).toHaveBeenLastCalledWith(updatedCopy)
  })

  it('offers agent emotes and closes the action menu after selection', () => {
    render(<OfficeCanvas agents={[agent('Main Agent')]} copy={ENGLISH_COPY} />)
    const scene = mocks.instances[0]!

    act(() => {
      mocks.agentClick?.({
        agent: agent('Main Agent'),
        rosterNo: 1,
        clientX: 100,
        clientY: 100,
      })
    })

    expect(screen.getByText('Main Agent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Wave' }))

    expect(scene.playAgentAnimation).toHaveBeenCalledWith(
      'main-agent',
      'emotes/wave',
      'Wave',
    )
    expect(screen.queryByText('Emotes')).not.toBeInTheDocument()
  })

  it('requests a desk visit for a selected peer and supports backing out', () => {
    const peer = { ...agent('Reviewer', 'idle'), id: 'office-agent-2' }
    render(<OfficeCanvas agents={[agent('Main Agent'), peer]} copy={ENGLISH_COPY} />)
    const scene = mocks.instances[0]!
    scene.getAgents.mockReturnValue([agent('Main Agent'), peer])

    act(() => {
      mocks.agentClick?.({
        agent: agent('Main Agent'),
        rosterNo: 1,
        clientX: 100,
        clientY: 100,
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Interact…' }))
    expect(screen.queryByRole('button', { name: 'Interact with Main Agent' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to actions' }))
    expect(screen.getByText('Emotes')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Interact…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Interact with Reviewer' }))

    expect(scene.requestDeskVisit).toHaveBeenCalledWith(
      1,
      2,
      'Reviewer, let us sync progress.',
    )
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument()
  })

  it('closes the menu on outside pointer input and Escape but not inside it', () => {
    render(<OfficeCanvas agents={[agent('Main Agent')]} copy={ENGLISH_COPY} />)
    const openMenu = () => act(() => {
      mocks.agentClick?.({
        agent: agent('Main Agent'),
        rosterNo: 1,
        clientX: 100,
        clientY: 100,
      })
    })

    openMenu()
    fireEvent.pointerDown(screen.getByText('Emotes'))
    expect(screen.getByText('Emotes')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByText('Emotes')).not.toBeInTheDocument()

    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Emotes')).not.toBeInTheDocument()
  })
})
