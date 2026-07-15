import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../types/agent'

const mocks = vi.hoisted(() => {
  class Point {
    x = 0
    y = 0
    set = vi.fn((x: number, y = x) => {
      this.x = x
      this.y = y
    })
  }

  class Container {
    children: unknown[] = []
    position = new Point()
    scale = new Point()
    label = ''
    sortableChildren = false
    zIndex = 0
    addChild = vi.fn((...children: unknown[]) => {
      this.children.push(...children)
      return children[0]
    })
    addChildAt = vi.fn((child: unknown, index: number) => {
      this.children.splice(index, 0, child)
      return child
    })
    sortChildren = vi.fn()
  }

  class Graphics extends Container {
    rect = vi.fn(() => this)
    fill = vi.fn(() => this)
  }

  class Sprite extends Container {
    constructor(public texture: { width: number; height: number }) {
      super()
    }
  }

  const applications: Array<{
    canvas: HTMLCanvasElement
    stage: Container
    init: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    ticker: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
    renderer: { resize: ReturnType<typeof vi.fn> }
  }> = []

  class Application {
    canvas = document.createElement('canvas')
    stage = new Container()
    init = vi.fn(() => Promise.resolve())
    destroy = vi.fn()
    ticker = { add: vi.fn(), remove: vi.fn() }
    renderer = { resize: vi.fn() }
    constructor() {
      applications.push(this)
    }
  }

  const agentEntities: AgentEntity[] = []
  class AgentEntity extends Container {
    agentId: string
    data: Agent
    eventCallback: ((event: { stopPropagation(): void; clientX: number; clientY: number }) => void) | undefined
    apply = vi.fn((patch: Partial<Agent>) => { this.data = { ...this.data, ...patch } })
    setPosition = vi.fn((x: number, y: number) => {
      this.data = { ...this.data, x, y }
      this.position.set(x, y)
    })
    playCustomAnimation = vi.fn((animation: string, task?: string) => {
      this.data = { ...this.data, state: 'talking', customAnimation: animation, currentTask: task }
    })
    updateVisuals = vi.fn()
    on = vi.fn((_name: string, callback: AgentEntity['eventCallback']) => {
      this.eventCallback = callback
    })
    constructor(agent: Agent) {
      super()
      this.agentId = agent.id
      this.data = { ...agent }
      this.position.set(agent.x, agent.y)
      agentEntities.push(this)
    }
  }

  const deskEntities: DeskEntity[] = []
  class DeskEntity {
    deskId: string
    shadowGfx = new Container()
    deskLayer = new Container()
    screenActivityLayer = new Container()
    chairLayer = new Container()
    occupiedIndicator = new Container()
    updateDepthZ = vi.fn()
    setOccupied = vi.fn()
    setScreenActivity = vi.fn()
    constructor(desk: { id: string }) {
      this.deskId = desk.id
      deskEntities.push(this)
    }
  }

  const movementUpdate = vi.fn(() => false)
  const animationUpdate = vi.fn()
  const simulatorTick = vi.fn((_dt: number, agents: Agent[]) => agents)
  const simulatorAfterMovement = vi.fn((_dt: number, agents: Agent[]) => agents)
  const simulatorStartVisit = vi.fn((agents: Agent[]) => agents)
  const simulatorStartTour = vi.fn((agents: Agent[]) => agents)
  const loadOfficeAssets = vi.fn(() => Promise.resolve(true))
  const loadSpineAssets = vi.fn(() => Promise.resolve(true))
  const mergeSnapshot = vi.fn((_current: Agent[], synced: Agent[]) => synced.map((agent) => ({ ...agent })))
  const backgroundTexture = { width: 480, height: 320 }

  return {
    Application,
    Container,
    Graphics,
    Sprite,
    applications,
    AgentEntity,
    agentEntities,
    DeskEntity,
    deskEntities,
    movementUpdate,
    animationUpdate,
    simulatorTick,
    simulatorAfterMovement,
    simulatorStartVisit,
    simulatorStartTour,
    loadOfficeAssets,
    loadSpineAssets,
    mergeSnapshot,
    backgroundTexture,
  }
})

vi.mock('pixi.js', () => ({
  Application: mocks.Application,
  Container: mocks.Container,
  Graphics: mocks.Graphics,
  Sprite: mocks.Sprite,
}))
vi.mock('./entities/AgentEntity', () => ({ AgentEntity: mocks.AgentEntity }))
vi.mock('./entities/DeskEntity', () => ({ DeskEntity: mocks.DeskEntity }))
vi.mock('./systems/MovementSystem', () => ({
  MovementSystem: class { update = mocks.movementUpdate },
}))
vi.mock('./systems/AnimationSystem', () => ({
  AnimationSystem: class { update = mocks.animationUpdate },
}))
vi.mock('./simulation/OfficeSimulator', () => ({
  OfficeSimulator: class {
    tick = mocks.simulatorTick
    afterMovement = mocks.simulatorAfterMovement
    startDeskVisit = mocks.simulatorStartVisit
    startDeskVisitTour = mocks.simulatorStartTour
  },
}))
vi.mock('./simulation/syncOfficeAgents', () => ({
  mergeOfficeAgentSnapshot: mocks.mergeSnapshot,
}))
vi.mock('./assets/loadOfficeAssets', () => ({
  loadOfficeAssets: mocks.loadOfficeAssets,
  getOfficeBackgroundTexture: () => mocks.backgroundTexture,
}))
vi.mock('./assets/loadSpineAssets', () => ({
  loadSpineAssets: mocks.loadSpineAssets,
}))

import { DESKS, INITIAL_AGENTS } from './layout/officeLayout'
import { OfficeScene } from './OfficeScene'

function syncedAgent(index: number, overrides: Partial<Agent> = {}): Agent {
  return {
    ...INITIAL_AGENTS[index]!,
    sourceKey: index === 0 ? 'main-agent' : `team:${index}`,
    ...overrides,
  }
}

describe('OfficeScene', () => {
  beforeEach(() => {
    mocks.applications.length = 0
    mocks.agentEntities.length = 0
    mocks.deskEntities.length = 0
    vi.clearAllMocks()
    mocks.loadOfficeAssets.mockResolvedValue(true)
    mocks.loadSpineAssets.mockResolvedValue(true)
    mocks.simulatorTick.mockImplementation((_dt, agents) => agents)
    mocks.simulatorAfterMovement.mockImplementation((_dt, agents) => agents)
    mocks.simulatorStartVisit.mockImplementation((agents) => agents)
    mocks.simulatorStartTour.mockImplementation((agents) => agents)
    mocks.mergeSnapshot.mockImplementation((_current, synced) => synced.map((agent) => ({ ...agent })))
  })

  it('initializes assets, scene entities, scaling, background, and ticker', async () => {
    const host = document.createElement('div')
    const scene = new OfficeScene()

    await scene.init(host, 480, 640)

    const app = mocks.applications[0]!
    expect(app.init).toHaveBeenCalledWith(expect.objectContaining({
      width: 480,
      height: 640,
      preference: 'webgl',
    }))
    expect(host).toContainElement(app.canvas)
    expect(mocks.loadSpineAssets).toHaveBeenCalledTimes(1)
    expect(mocks.loadOfficeAssets).toHaveBeenCalledTimes(1)
    expect(mocks.deskEntities).toHaveLength(DESKS.length)
    expect(mocks.agentEntities).toHaveLength(INITIAL_AGENTS.length)
    expect(app.ticker.add).toHaveBeenCalledTimes(1)
    expect(app.stage.children).toHaveLength(1)
    expect(app.canvas.style.width).toBe('100%')
  })

  it('surfaces initialization failures and disposes an initialized application', async () => {
    mocks.loadSpineAssets.mockRejectedValueOnce(new Error('Spine failed'))
    const scene = new OfficeScene()

    await expect(scene.init(document.createElement('div'), 960, 640)).rejects.toThrow('Spine failed')

    expect(mocks.applications[0]!.destroy).toHaveBeenCalledWith(true, { children: true })
  })

  it('aborts scene creation if destroyed while renderer initialization is pending', async () => {
    let finishInit = () => {}
    const scene = new OfficeScene()
    const promise = scene.init(document.createElement('div'), 960, 640)
    mocks.applications[0]!.init.mockImplementationOnce(() => new Promise<void>((resolve) => { finishInit = resolve }))
    scene.destroy()
    finishInit()
    await promise

    expect(mocks.applications[0]!.destroy).toHaveBeenCalled()
  })

  it('syncs cloned agent snapshots and exposes defensive copies', () => {
    const scene = new OfficeScene()
    const incoming = [syncedAgent(0), syncedAgent(1)]

    scene.syncAgents(incoming)
    const firstRead = scene.getAgents()
    firstRead[0]!.name = 'Mutated outside'

    expect(scene.getAgents()[0]!.name).not.toBe('Mutated outside')
    expect(mocks.mergeSnapshot).toHaveBeenCalled()
  })

  it('delegates single and multi-stop visits and custom animations', () => {
    const scene = new OfficeScene()
    scene.syncAgents([syncedAgent(0), syncedAgent(1)])

    scene.requestDeskVisit(1, 2, 'Status?')
    scene.requestDeskVisitTour(1, [2])
    scene.playAgentAnimation('main-agent', 'emotes/wave', 'Greeting')

    expect(mocks.simulatorStartVisit).toHaveBeenCalledWith(expect.any(Array), 1, 2, 'Status?')
    expect(mocks.simulatorStartTour).toHaveBeenCalledWith(expect.any(Array), 1, [2], expect.any(Function))
    expect(scene.getAgents()[0]).toMatchObject({
      state: 'talking',
      customAnimation: 'emotes/wave',
      currentTask: 'Greeting',
      viewFacing: 'front',
    })
  })

  it('ignores custom animations for missing agents or active missions', () => {
    const scene = new OfficeScene()
    const missionAgent = syncedAgent(0, {
      mission: {
        kind: 'desk_visit',
        phase: 'goto',
        hostAgentId: 'office-agent-2',
        hostDeskId: 'desk-1',
        message: 'Hi',
        resumeState: 'idle',
        resumeTask: '',
        talkDuration: 1,
        queue: [],
      },
    })
    scene.syncAgents([missionAgent])

    scene.playAgentAnimation('missing', 'emotes/wave')
    scene.playAgentAnimation('main-agent', 'emotes/wave')

    expect(scene.getAgents()[0]!.customAnimation).toBeUndefined()
  })

  it('resizes only after initialization and preserves complete-scene aspect ratio', async () => {
    const scene = new OfficeScene()
    scene.resize(100, 100)
    await scene.init(document.createElement('div'), 960, 640)

    scene.resize(480, 480)

    const app = mocks.applications[0]!
    expect(app.renderer.resize).toHaveBeenCalledWith(480, 480)
    const world = app.stage.children[0] as InstanceType<typeof mocks.Container>
    expect(world.scale.set).toHaveBeenLastCalledWith(0.5)
    expect(world.position.set).toHaveBeenLastCalledWith(0, 80)
  })

  it('reports agent pointer events with current data and roster number', async () => {
    const onAgentClick = vi.fn()
    const scene = new OfficeScene({ onAgentClick })
    await scene.init(document.createElement('div'), 960, 640)
    const stopPropagation = vi.fn()

    mocks.agentEntities[1]!.eventCallback?.({ stopPropagation, clientX: 25, clientY: 40 })

    expect(stopPropagation).toHaveBeenCalled()
    expect(onAgentClick).toHaveBeenCalledWith(expect.objectContaining({
      rosterNo: 2,
      clientX: 25,
      clientY: 40,
      agent: expect.objectContaining({ id: 'office-agent-2' }),
    }))
  })

  it('runs simulation, movement, animation, depth, and desk occupancy on each tick', async () => {
    const scene = new OfficeScene()
    scene.syncAgents([
      syncedAgent(0, { state: 'working', ambientKind: 'watch' }),
      syncedAgent(1),
    ])
    await scene.init(document.createElement('div'), 960, 640)
    const tickerCallback = mocks.applications[0]!.ticker.add.mock.calls[0]![0]

    tickerCallback({ deltaTime: 120 })

    expect(mocks.simulatorTick).toHaveBeenCalledWith(0.05, expect.any(Array))
    expect(mocks.movementUpdate).toHaveBeenCalledWith(expect.any(Map), 0.05)
    expect(mocks.simulatorAfterMovement).toHaveBeenCalledWith(0.05, expect.any(Array), expect.any(Map))
    expect(mocks.animationUpdate).toHaveBeenCalledWith(expect.any(Map), 0.05)
    expect(mocks.deskEntities[0]!.updateDepthZ).toHaveBeenCalled()
    expect(mocks.deskEntities[0]!.setOccupied).toHaveBeenCalledWith(true)
    expect(mocks.deskEntities[0]!.setScreenActivity).toHaveBeenCalledWith('watch')
  })

  it('starts one pending source visit when the ticker finds both agents available', async () => {
    const scene = new OfficeScene()
    scene.syncAgents([syncedAgent(0), syncedAgent(1, { sourceKey: undefined })])
    scene.syncAgents([syncedAgent(0), syncedAgent(1, { sourceKey: 'team:new' })])
    await scene.init(document.createElement('div'), 960, 640)
    const tickerCallback = mocks.applications[0]!.ticker.add.mock.calls[0]![0]

    tickerCallback({ deltaTime: 1 })

    expect(mocks.simulatorStartVisit).toHaveBeenCalledWith(
      expect.any(Array),
      1,
      2,
      expect.stringContaining('Agent 2'),
    )
  })

  it('destroys ticker, renderer, entities, and internal queues idempotently', async () => {
    const scene = new OfficeScene()
    await scene.init(document.createElement('div'), 960, 640)
    const app = mocks.applications[0]!

    scene.destroy()
    scene.destroy()

    expect(app.ticker.remove).toHaveBeenCalledTimes(1)
    expect(app.destroy).toHaveBeenCalledWith(true, { children: true })
    scene.resize(100, 100)
    expect(app.renderer.resize).not.toHaveBeenCalled()
  })
})
