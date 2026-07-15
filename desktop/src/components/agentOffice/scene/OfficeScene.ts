import { Application, Container, Graphics, Sprite } from 'pixi.js'
import type { FederatedPointerEvent } from 'pixi.js'
import type { Agent } from '../types/agent'
import {
  COLORS,
  DESKS,
  INITIAL_AGENTS,
  pickHandoffVisitMessage,
  SCENE_HEIGHT,
  SCENE_WIDTH,
} from './layout/officeLayout'
import { AgentEntity } from './entities/AgentEntity'
import { DeskEntity } from './entities/DeskEntity'
import { MovementSystem } from './systems/MovementSystem'
import { AnimationSystem } from './systems/AnimationSystem'
import { OfficeSimulator } from './simulation/OfficeSimulator'
import { mergeOfficeAgentSnapshot } from './simulation/syncOfficeAgents'
import {
  getOfficeBackgroundTexture,
  loadOfficeAssets,
} from './assets/loadOfficeAssets'
import { loadSpineAssets } from './assets/loadSpineAssets'

export type OfficeAgentClick = {
  agent: Agent
  rosterNo: number
  clientX: number
  clientY: number
}


export class OfficeScene {
  private app: Application | null = null
  private world: Container | null = null
  private agentEntities = new Map<string, AgentEntity>()
  private deskEntities = new Map<string, DeskEntity>()
  private officeLayer: Container | null = null

  private movement = new MovementSystem()
  private animation = new AnimationSystem()
  private simulator = new OfficeSimulator()

  private agents: Agent[] = INITIAL_AGENTS.map((agent) => ({ ...agent }))
  private syncedAgents: Agent[] = INITIAL_AGENTS.map((agent) => ({ ...agent }))
  private pendingVisitRosterNos = new Set<number>()
  private customAnimationRemaining = new Map<string, number>()
  private destroyed = false
  private readonly options: {
    onAgentClick?: (event: OfficeAgentClick) => void
  }

  constructor(options: { onAgentClick?: (event: OfficeAgentClick) => void } = {}) {
    this.options = options
  }

  async init(container: HTMLElement, width: number, height: number) {
    const app = new Application()
    let appInitialized = false
    try {
      await app.init({
        width,
        height,
        preference: 'webgl',
        backgroundColor: COLORS.floor,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      })
      appInitialized = true

      if (this.destroyed) {
        app.destroy(true, { children: true })
        return
      }

      this.app = app
      container.appendChild(app.canvas)

      this.world = new Container()
      app.stage.addChild(this.world)
      this.fitStage(width, height)

      await loadSpineAssets()
      if (this.destroyed) return

      const officeOk = await loadOfficeAssets()
      if (this.destroyed) return
      if (!officeOk) {
        console.error(
          '[Office] desk.png / chair.png 加载失败，工位将使用矢量占位图。请检查 public/assets/office/ 并硬刷新。',
        )
      }

      this.drawMap(this.world)
      this.spawnOffice(this.world)
      this.pushDataToEntities()

      app.ticker.add(this.onTick)
    } catch (error) {
      if (appInitialized) app.destroy(true, { children: true })
      if (this.app === app) this.app = null
      this.world = null
      throw error
    }
  }

  syncAgents(nextAgents: Agent[]) {
    const previousSourceKeys = this.syncedAgents.map((agent) => agent.sourceKey)
    this.syncedAgents = nextAgents.map((agent) => ({ ...agent }))

    nextAgents.forEach((agent, index) => {
      if (index === 0) return
      const rosterNo = index + 1
      if (!agent.sourceKey) {
        this.pendingVisitRosterNos.delete(rosterNo)
      } else if (agent.sourceKey !== previousSourceKeys[index]) {
        this.pendingVisitRosterNos.add(rosterNo)
      }
    })

    this.agents = mergeOfficeAgentSnapshot(this.agents, this.syncedAgents)
    this.pushDataToEntities()
  }

  /** 名册序号从 1 开始：visitor 去找 host 说一句话后回座继续工作 */
  requestDeskVisit(
    visitorRosterNo: number,
    hostRosterNo: number,
    message: string,
  ) {
    this.agents = this.simulator.startDeskVisit(
      this.agents,
      visitorRosterNo,
      hostRosterNo,
      message,
    )
    this.pushDataToEntities()
  }

  /** 按顺序拜访多个工位，全部说完后回访客工位 */
  requestDeskVisitTour(
    visitorRosterNo: number,
    hostRosterNos: number[],
    messageFn?: (hostRosterNo: number, hostName: string) => string,
  ) {
    this.agents = this.simulator.startDeskVisitTour(
      this.agents,
      visitorRosterNo,
      hostRosterNos,
      messageFn ?? ((hostNo, hostName) => pickHandoffVisitMessage(hostName, hostNo)),
    )
    this.pushDataToEntities()
  }

  getAgents(): Agent[] {
    return this.agents.map((agent) => ({ ...agent }))
  }

  playAgentAnimation(id: string, animation: string, task?: string) {
    const target = this.agents.find((agent) => agent.id === id)
    if (!target || target.mission) return

    this.customAnimationRemaining.set(id, 4)
    this.agents = this.agents.map((agent) =>
      agent.id === id
        ? {
            ...agent,
            state: 'talking' as const,
            currentTask: task,
            targetX: undefined,
            targetY: undefined,
            walkPath: undefined,
            walkPathIndex: undefined,
            bubbleText: undefined,
            customAnimation: animation,
            viewFacing: 'front' as const,
            facing: 1 as const,
          }
        : agent,
    )
    this.pushDataToEntities()
    this.agentEntities.get(id)?.playCustomAnimation(animation, task)
    this.pullDataFromEntities()
  }

  resize(containerWidth: number, containerHeight: number) {
    if (!this.app || !this.world) return
    this.app.renderer.resize(containerWidth, containerHeight)
    this.fitStage(containerWidth, containerHeight)
  }

  /** 等比缩放完整办公室场景并居中，任何屏幕比例下都不裁切内容 */
  private fitStage(containerWidth: number, containerHeight: number) {
    if (!this.world) return

    const scale = Math.min(
      containerWidth / SCENE_WIDTH,
      containerHeight / SCENE_HEIGHT,
    )
    const offsetX = (containerWidth - SCENE_WIDTH * scale) / 2
    const offsetY = (containerHeight - SCENE_HEIGHT * scale) / 2

    this.world.scale.set(scale)
    this.world.position.set(offsetX, offsetY)

    const canvas = this.app?.canvas as HTMLCanvasElement | undefined
    if (!canvas) return
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.maxWidth = '100%'
    canvas.style.maxHeight = '100%'
  }

  destroy() {
    this.destroyed = true
    this.app?.ticker.remove(this.onTick)
    this.app?.destroy(true, { children: true })
    this.app = null
    this.world = null
    this.agentEntities.clear()
    this.deskEntities.clear()
    this.officeLayer = null
    this.pendingVisitRosterNos.clear()
    this.customAnimationRemaining.clear()
  }

  private onTick = (ticker: { deltaTime: number }) => {
    const dt = Math.min(ticker.deltaTime / 60, 0.05)

    this.agents = mergeOfficeAgentSnapshot(this.agents, this.syncedAgents)
    this.agents = this.simulator.tick(dt, this.agents)
    this.pushDataToEntities()

    this.movement.update(this.agentEntities, dt)
    this.pullDataFromEntities()

    this.agents = this.simulator.afterMovement(
      dt,
      this.agents,
      this.agentEntities,
    )
    this.updateCustomAnimations(dt)
    this.startPendingVisits()
    this.pushDataToEntities()

    this.animation.update(this.agentEntities, dt)
    this.sortOfficeDepth()
    this.syncDeskOccupancy()
  }

  private updateCustomAnimations(dt: number) {
    for (const [id, remaining] of this.customAnimationRemaining) {
      const nextRemaining = remaining - dt
      if (nextRemaining > 0) {
        this.customAnimationRemaining.set(id, nextRemaining)
        continue
      }

      this.customAnimationRemaining.delete(id)
      const synced = this.syncedAgents.find((agent) => agent.id === id)
      if (!synced) continue
      this.agents = this.agents.map((agent) =>
        agent.id === id
          ? { ...synced, x: agent.x, y: agent.y }
          : agent,
      )
    }
  }

  private startPendingVisits() {
    if (this.pendingVisitRosterNos.size === 0) return

    for (const hostRosterNo of this.pendingVisitRosterNos) {
      const visitor = this.agents[0]
      const host = this.agents[hostRosterNo - 1]
      if (!visitor || !host || visitor.mission || host.mission) continue
      if (visitor.customAnimation || host.customAnimation) continue
      if (
        host.state === 'walking' ||
        this.agents.some((agent) => agent.mission?.hostAgentId === host.id)
      ) continue

      this.requestDeskVisit(
        1,
        hostRosterNo,
        pickHandoffVisitMessage(host.name, hostRosterNo),
      )
      this.pendingVisitRosterNos.delete(hostRosterNo)
      return
    }
  }

  private sortOfficeDepth() {
    if (!this.officeLayer) return

    const agentPositions = [...this.agentEntities.values()].map((e) => ({
      x: e.position.x,
      y: e.position.y,
    }))

    for (const e of this.agentEntities.values()) {
      e.zIndex = e.position.y
    }

    for (const desk of this.deskEntities.values()) {
      desk.updateDepthZ(agentPositions)
    }

    this.officeLayer.sortChildren()
  }

  private pushDataToEntities() {
    for (const agent of this.agents) {
      const entity = this.agentEntities.get(agent.id)
      if (!entity) continue

      const prev = entity.data
      entity.apply({
        ...agent,
        targetX: agent.targetX,
        targetY: agent.targetY,
        walkPath: agent.walkPath,
        walkPathIndex: agent.walkPathIndex,
        currentTask: agent.currentTask,
        bubbleText: agent.bubbleText,
        customAnimation: agent.customAnimation,
        mission: agent.mission,
        ambientEventId: agent.ambientEventId,
        ambientKind: agent.ambientKind,
        ambientRemaining: agent.ambientRemaining,
      })
      if (
        prev.x !== agent.x ||
        prev.y !== agent.y ||
        agent.state !== 'walking'
      ) {
        entity.setPosition(agent.x, agent.y)
      }
    }
  }

  private pullDataFromEntities() {
    this.agents = this.agents.map((agent) => {
      const entity = this.agentEntities.get(agent.id)
      return entity ? { ...agent, ...entity.data } : agent
    })
  }

  private syncDeskOccupancy() {
    const occupied = new Set(
      this.agents
        .filter((a) => a.state === 'working' && a.assignedDeskId)
        .map((a) => a.assignedDeskId!),
    )
    const ambientByDesk = new Map(
      this.agents
        .filter((agent) => agent.assignedDeskId)
        .map((agent) => [agent.assignedDeskId!, agent.ambientKind]),
    )
    for (const desk of this.deskEntities.values()) {
      desk.setOccupied(occupied.has(desk.deskId))
      desk.setScreenActivity(ambientByDesk.get(desk.deskId))
    }
  }

  /** 桌子 / 人物 / 椅子同层；桌沿为界动态遮挡 */
  private spawnOffice(parent: Container) {
    const layer = new Container()
    layer.label = 'office'
    layer.sortableChildren = true
    this.officeLayer = layer

    for (const desk of DESKS) {
      const entity = new DeskEntity(desk)
      this.deskEntities.set(desk.id, entity)
      layer.addChild(
        entity.shadowGfx,
        entity.deskLayer,
        entity.screenActivityLayer,
        entity.chairLayer,
        entity.occupiedIndicator,
      )
    }

    for (const agent of this.agents) {
      const entity = new AgentEntity(agent)
      this.agentEntities.set(agent.id, entity)
      entity.zIndex = agent.y
      entity.on('pointertap', (event: FederatedPointerEvent) => {
        event.stopPropagation()
        this.options.onAgentClick?.({
          agent: { ...entity.data },
          rosterNo: this.agents.findIndex((a) => a.id === agent.id) + 1,
          clientX: event.clientX,
          clientY: event.clientY,
        })
      })
      layer.addChild(entity)
    }

    this.sortOfficeDepth()
    parent.addChild(layer)
  }

  private drawMap(parent: Container) {
    const map = new Container()
    map.label = 'map'

    const floor = new Graphics()
    floor.rect(0, 0, SCENE_WIDTH, SCENE_HEIGHT)
    floor.fill(COLORS.floor)
    map.addChild(floor)

    const bgTex = getOfficeBackgroundTexture()
    if (bgTex) {
      const bg = new Sprite(bgTex)
      const scale = Math.min(
        SCENE_WIDTH / bgTex.width,
        SCENE_HEIGHT / bgTex.height,
      )
      bg.scale.set(scale)
      bg.position.set(
        (SCENE_WIDTH - bgTex.width * scale) / 2,
        (SCENE_HEIGHT - bgTex.height * scale) / 2,
      )
      map.addChild(bg)
    }

    parent.addChildAt(map, 0)
  }
}
