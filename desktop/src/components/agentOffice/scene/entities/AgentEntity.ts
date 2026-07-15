import { Container, Graphics, Rectangle } from 'pixi.js'
import { formatOfficeAgentNameplate, type Agent, type AgentState } from '../../types/agent'
import {
  resolveWalkViewFacing,
  viewFacingToLR,
} from '../systems/movementFacing'
import { SpineCharacter } from '../characters/SpineCharacter'
import { isSpineReady } from '../assets/loadSpineAssets'
import { Bubble } from '../ui/Bubble'
import { StatusLabel } from '../ui/StatusLabel'
import type { OfficeThemePalette } from '../../officeTheme'

export class AgentEntity extends Container {
  readonly agentId: string
  private agent: Agent
  private spineChar: SpineCharacter | null = null
  private interactionHighlight = new Graphics()
  private fallbackBody: Graphics | null = null
  private fallbackScarf: Graphics | null = null
  private statusLabel: StatusLabel
  private bubble: Bubble
  private walkPhase = 0
  private useSpine = false
  private selected = false
  private hovered = false

  constructor(agent: Agent) {
    super()
    this.agentId = agent.id
    this.agent = { ...agent }

    this.statusLabel = new StatusLabel(formatOfficeAgentNameplate(agent))
    this.bubble = new Bubble()
    this.interactionHighlight.visible = false
    this.addChild(this.interactionHighlight)

    if (isSpineReady()) {
      this.spineChar = new SpineCharacter(agent.id, agent.color)
      if (this.spineChar.isReady) {
        this.useSpine = true
        this.spineChar.setAgentColor(agent.color)
        this.spineChar.setFacing(agent.facing)
        this.spineChar.setViewFacing(agent.viewFacing ?? 'front')
        this.spineChar.playState(agent.state)
        this.addChild(this.spineChar, this.statusLabel, this.bubble)
      } else {
        this.spineChar.destroy()
        this.spineChar = null
        this.initFallbackGraphics()
      }
    } else {
      this.initFallbackGraphics()
    }

    this.eventMode = 'static'
    this.cursor = 'pointer'
    this.hitArea = new Rectangle(-34, -92, 68, 124)
    this.on('pointerover', () => {
      this.hovered = true
      this.drawInteractionHighlight()
    })
    this.on('pointerout', () => {
      this.hovered = false
      this.drawInteractionHighlight()
    })

    this.syncVisual()
    this.position.set(agent.x, agent.y)
  }

  setThemePalette(palette: OfficeThemePalette) {
    this.statusLabel.setThemePalette(palette)
    this.bubble.setThemePalette(palette)
  }

  setSelected(selected: boolean) {
    this.selected = selected
    this.drawInteractionHighlight()
  }

  setReducedMotion(reduced: boolean) {
    this.spineChar?.setReducedMotion(reduced)
  }

  private drawInteractionHighlight() {
    this.interactionHighlight.clear()
    this.interactionHighlight.visible = this.selected || this.hovered
    if (!this.interactionHighlight.visible) return
    this.interactionHighlight.ellipse(0, 14, 30, 13)
    this.interactionHighlight.fill({
      color: this.selected ? 0x2563eb : 0xffffff,
      alpha: this.selected ? 0.2 : 0.13,
    })
    this.interactionHighlight.stroke({
      color: this.selected ? 0x60a5fa : 0xffffff,
      width: this.selected ? 2.5 : 1.5,
      alpha: this.selected ? 0.95 : 0.72,
    })
  }

  get data(): Agent {
    return this.agent
  }

  apply(patch: Partial<Agent>) {
    const prevState = this.agent.state
    const prevNameplate = formatOfficeAgentNameplate(this.agent)
    const prevFacing = this.agent.facing
    const prevViewFacing = this.agent.viewFacing
    const prevColor = this.agent.color
    const prevCustomAnimation = this.agent.customAnimation
    const prevBubbleText = this.agent.bubbleText
    this.agent = { ...this.agent, ...patch }

    const nextNameplate = formatOfficeAgentNameplate(this.agent)
    if (nextNameplate !== prevNameplate) {
      this.statusLabel.setName(nextNameplate)
    }

    if (this.agent.bubbleText !== prevBubbleText) {
      if (this.agent.bubbleText) {
        this.bubble.show(this.agent.bubbleText, this.agent.ambientRemaining ?? 4)
      } else {
        this.bubble.hide()
      }
    }

    if (this.useSpine && this.spineChar) {
      if (patch.viewFacing != null && patch.viewFacing !== prevViewFacing) {
        this.spineChar.setViewFacing(patch.viewFacing)
      }
      if (patch.facing != null && patch.facing !== prevFacing) {
        this.spineChar.setFacing(patch.facing)
      }
      if (
        (patch.state != null && patch.state !== prevState) ||
        patch.customAnimation !== prevCustomAnimation
      ) {
        this.spineChar.playState(this.agent.state, this.agent.customAnimation)
      }
      if (patch.color != null && patch.color !== prevColor) {
        this.spineChar.setAgentColor(patch.color)
      }
      this.updateOverlayPositions()
    } else {
      this.syncVisual()
    }
  }

  setPosition(x: number, y: number) {
    this.agent.x = x
    this.agent.y = y
    this.position.set(x, y)
  }

  showBubble(text: string, duration = 4) {
    this.agent.bubbleText = text
    this.bubble.show(text, duration)
    this.updateOverlayPositions()
  }

  hideBubble() {
    this.agent.bubbleText = undefined
    this.bubble.hide()
  }

  playCustomAnimation(animation: string, task?: string) {
    this.agent = {
      ...this.agent,
      state: 'talking',
      currentTask: task,
      customAnimation: animation,
      viewFacing: 'front',
      facing: 1,
      targetX: undefined,
      targetY: undefined,
      walkPath: undefined,
      walkPathIndex: undefined,
      mission: undefined,
      bubbleText: undefined,
    }
    this.bubble.hide()

    if (this.useSpine && this.spineChar) {
      this.spineChar.setViewFacing('front')
      this.spineChar.setFacing(1)
      this.spineChar.playAnimation(animation)
      this.updateOverlayPositions()
      return
    }

    this.syncVisual()
  }

  updateVisuals(state: AgentState, dt: number) {
    if (this.useSpine && this.spineChar) {
      if (
        state === 'walking' &&
        this.agent.targetX != null &&
        this.agent.targetY != null
      ) {
        const viewFacing = resolveWalkViewFacing(
          this.agent.targetX - this.agent.x,
          this.agent.targetY - this.agent.y,
        )
        this.agent.viewFacing = viewFacing
        this.agent.facing = viewFacingToLR(viewFacing)
        this.spineChar.setViewFacing(viewFacing)
        this.spineChar.setFacing(this.agent.facing)
      } else if (state === 'working' || state === 'thinking') {
        if (this.agent.viewFacing !== 'back') {
          this.agent.viewFacing = 'back'
          this.spineChar.setViewFacing('back')
        }
      }
      this.spineChar.playState(state, this.agent.customAnimation)
    } else {
      this.walkPhase += dt * 8
      this.drawFallbackBody(state, 0)
    }

    this.bubble.update(dt)
    this.statusLabel.setState(state)
    this.statusLabel.setTask(
      state === 'working' || state === 'thinking' ? this.agent.currentTask : undefined,
    )
    this.updateOverlayPositions()
  }

  private updateOverlayPositions() {
    const crownTopY = this.useSpine && this.spineChar
      ? this.spineChar.getHeadOffsetY()
      : -58
    this.statusLabel.layout(crownTopY)
    const labelTopY = this.statusLabel.getLabelTopY(crownTopY)
    const gapAboveLabel = 4
    const bubbleExtraDown = 10
    this.bubble.position.set(
      0,
      labelTopY - gapAboveLabel - Bubble.TAIL_TIP_Y + bubbleExtraDown,
    )
  }

  private syncVisual() {
    this.statusLabel.setName(formatOfficeAgentNameplate(this.agent))
    this.statusLabel.setState(this.agent.state)
    this.statusLabel.setTask(
      this.agent.state === 'working' || this.agent.state === 'thinking'
        ? this.agent.currentTask
        : undefined,
    )
    if (this.agent.bubbleText) {
      this.bubble.show(this.agent.bubbleText)
    }
    if (this.useSpine && this.spineChar) {
      this.spineChar.playState(this.agent.state, this.agent.customAnimation)
      this.spineChar.setFacing(this.agent.facing)
      this.spineChar.setViewFacing(this.agent.viewFacing ?? 'front')
      this.spineChar.setAgentColor(this.agent.color)
    } else {
      this.drawFallbackBody(this.agent.state, 0)
    }
    this.updateOverlayPositions()
  }

  private initFallbackGraphics() {
    this.fallbackBody = new Graphics()
    this.fallbackScarf = new Graphics()
    this.addChild(this.fallbackBody, this.fallbackScarf, this.statusLabel, this.bubble)
    this.useSpine = false
  }

  private drawFallbackBody(state: AgentState, bob: number) {
    if (!this.fallbackBody || !this.fallbackScarf) return

    const facing = this.agent.facing
    const g = this.fallbackBody
    const s = this.fallbackScarf
    g.clear()
    s.clear()

    const bounce =
      state === 'walking'
        ? Math.sin(this.walkPhase) * 2
        : state === 'working'
          ? Math.sin(this.walkPhase * 2) * 1
          : bob

    // shadow
    g.ellipse(0, 16 + bounce, 14, 4)
    g.fill({ color: 0x000000, alpha: 0.1 })

    // legs / pants
    const legSwing = state === 'walking' ? Math.sin(this.walkPhase) * 3 : 0
    g.roundRect(-9, 6 + bounce + legSwing, 7, 12, 2)
    g.fill(0x3a3f4a)
    g.roundRect(2, 6 + bounce - legSwing, 7, 12, 2)
    g.fill(0x3a3f4a)

    // shirt body
    g.roundRect(-11, -8 + bounce, 22, 18, 4)
    g.fill(0xf8f8f6)
    g.roundRect(-7, -8 + bounce, 14, 4, 2)
    g.fill(0xe8e8e6)

    // head
    g.circle(1, -20 + bounce, 10)
    g.fill(0xffe0c4)
    g.roundRect(-9, -28 + bounce, 20, 8, 3)
    g.fill(0x2a2a30)

    // typing arm when working
    if (state === 'working') {
      const armY = -4 + bounce + Math.sin(this.walkPhase * 3) * 2
      g.roundRect(12, armY, 8, 4, 2)
      g.fill(0xf8f8f6)
    }

    // thinking dots
    if (state === 'thinking') {
      for (let i = 0; i < 3; i++) {
        g.circle(14 + i * 6, -34 + bounce, 2)
        g.fill({ color: 0x9b6dd7, alpha: i <= Math.floor(this.walkPhase) % 3 ? 1 : 0.3 })
      }
    }

    // badge / 工牌
    s.roundRect(-1, -2 + bounce, 10, 8, 2)
    s.fill(this.agent.color)

    g.scale.x = facing
    s.scale.x = facing
  }
}
