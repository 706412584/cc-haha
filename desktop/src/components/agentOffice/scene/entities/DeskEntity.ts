import { Container, FillGradient, Graphics, Sprite } from 'pixi.js'
import type { Agent, Desk } from '../../types/agent'
import { SEAT_OFFSET_Y } from '../layout/officeLayout'
import {
  getOfficeChairTexture,
  getOfficeDeskTexture,
} from '../assets/loadOfficeAssets'
import {
  computeChairLayerZ,
  computeDeskLayerZ,
} from '../systems/deskDepthSort'

const STYLE = {
  shadow: { color: 0x3d4f6e, alpha: 0.1 },
  deskTop: 0xfaf8f4,
  deskEdge: 0xe8e0d4,
  deskStroke: 0xd8d0c4,
  chairDark: 0x556b7d,
  chair: 0x7a8fa3,
  chairWheel: 0x3d4a56,
  monitor: 0x2e3238,
  screenTop: 0x7ec8ff,
  screenBottom: 0x4a8fd9,
  keyboard: 0xeeedea,
  keyboardStroke: 0xd0ccc4,
  mouse: 0xf5f4f1,
} as const

const DESK_BASE_WIDTH = 152
const CHAIR_BASE_WIDTH = 104
const DESK_ANCHOR_Y = 0.62
const DESK_TARGET_WIDTH = (DESK_BASE_WIDTH * 2) / 3
const CHAIR_ANCHOR_Y = 0.36
const CHAIR_TARGET_WIDTH = CHAIR_BASE_WIDTH / 2

const CHAIR_DEPTH_AHEAD = 2

export class DeskEntity {
  readonly deskId: string
  readonly shadowGfx = new Graphics()
  readonly deskLayer = new Container()
  readonly chairLayer = new Container()
  readonly occupiedIndicator = new Graphics()
  readonly screenActivityLayer = new Graphics()

  private desk: Desk
  private currentScreenActivity: Agent['ambientKind']
  private screenRect = { x: -18, y: -44, width: 36, height: 22 }

  constructor(desk: Desk) {
    this.deskId = desk.id
    this.desk = desk

    for (const part of [
      this.shadowGfx,
      this.deskLayer,
      this.chairLayer,
      this.occupiedIndicator,
      this.screenActivityLayer,
    ]) {
      part.position.set(desk.x, desk.y)
    }

    this.screenActivityLayer.visible = false
    this.drawShadow()
    this.mountSprites()
  }

  /** 素材晚到或 HMR 后可重新挂载 PNG */
  remountSprites() {
    this.deskLayer.removeChildren()
    this.chairLayer.removeChildren()
    this.mountSprites()
  }

  updateDepthZ(agentPositions: { x: number; y: number }[]) {
    const deskZ = computeDeskLayerZ(this.desk, agentPositions)
    const chairZ = computeChairLayerZ(
      this.desk,
      agentPositions,
      CHAIR_DEPTH_AHEAD,
    )
    this.deskLayer.zIndex = deskZ
    this.shadowGfx.zIndex = deskZ - 0.5
    this.chairLayer.zIndex = chairZ
    this.screenActivityLayer.zIndex = deskZ + 0.5
    this.occupiedIndicator.zIndex = chairZ + 0.5
  }

  get screenActivity(): Agent['ambientKind'] {
    return this.currentScreenActivity
  }

  setScreenActivity(activity: Agent['ambientKind']) {
    if (activity === this.currentScreenActivity) return
    this.currentScreenActivity = activity
    const g = this.screenActivityLayer
    g.clear()
    g.visible = activity === 'watch' || activity === 'game'
    if (!g.visible) return

    const { x, y, width, height } = this.screenRect
    const centerX = x + width / 2
    const centerY = y + height / 2
    g.roundRect(x - 2, y - 2, width + 4, height + 4, 4)
    g.fill({ color: 0x151923, alpha: 0.96 })

    if (activity === 'watch') {
      g.roundRect(x, y, width, height, 3)
      g.fill(0xe85d4a)
      g.moveTo(centerX - 5, centerY - 7)
      g.lineTo(centerX + 6, centerY)
      g.lineTo(centerX - 5, centerY + 7)
      g.closePath()
      g.fill(0xffffff)
      return
    }

    g.roundRect(x, y, width, height, 3)
    g.fill(0x242a38)
    g.circle(centerX - 8, centerY, 5)
    g.fill(0x4ecdc4)
    g.rect(centerX - 10.5, centerY - 1.5, 5, 3)
    g.rect(centerX - 9.5, centerY - 2.5, 3, 5)
    g.fill(0xffffff)
    g.circle(centerX + 7, centerY - 3, 2)
    g.circle(centerX + 11, centerY + 2, 2)
    g.fill(0xf5c542)
  }

  setOccupied(occupied: boolean) {
    this.occupiedIndicator.clear()
    if (occupied) {
      this.occupiedIndicator.circle(0, SEAT_OFFSET_Y - 4, 5.5)
      this.occupiedIndicator.fill({ color: 0x50b86c, alpha: 0.85 })
      this.occupiedIndicator.stroke({ color: 0xffffff, width: 1.5, alpha: 0.6 })
    }
  }

  getSeatPosition() {
    return { x: this.desk.seatX, y: this.desk.seatY }
  }

  private mountSprites() {
    const deskTex = getOfficeDeskTexture()
    const chairTex = getOfficeChairTexture()

    if (deskTex) {
      const desk = new Sprite(deskTex)
      desk.anchor.set(0.5, DESK_ANCHOR_Y)
      desk.position.set(0, SEAT_OFFSET_Y - 14)
      desk.scale.set(DESK_TARGET_WIDTH / deskTex.width)
      this.screenRect = { x: -15.5, y: -29, width: 31, height: 17 }
      this.deskLayer.addChild(desk)
    } else {
      this.drawDeskFallback()
    }

    if (chairTex) {
      const chair = new Sprite(chairTex)
      chair.anchor.set(0.5, CHAIR_ANCHOR_Y)
      chair.position.set(0, SEAT_OFFSET_Y)
      chair.scale.set(CHAIR_TARGET_WIDTH / chairTex.width)
      this.chairLayer.addChild(chair)
    } else {
      this.drawChairFallback()
    }
  }

  private drawShadow() {
    const g = this.shadowGfx
    g.clear()
    g.ellipse(0, SEAT_OFFSET_Y + 20, 54, 14)
    g.fill(STYLE.shadow)
  }

  private drawChairFallback() {
    const g = new Graphics()
    const seatY = 30
    const backTop = 40
    const backBottom = 58
    const baseY = 64

    g.ellipse(0, baseY, 30, 11)
    g.fill(STYLE.chairDark)
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2
      g.circle(Math.cos(a) * 24, baseY + Math.sin(a) * 6, 3.5)
      g.fill(STYLE.chairWheel)
    }
    g.roundRect(-24, backTop, 48, backBottom - backTop, 14)
    g.fill(STYLE.chair)
    g.roundRect(-22, seatY, 44, 14, 8)
    g.fill(STYLE.chair)

    g.position.set(0, SEAT_OFFSET_Y - 36)
    this.chairLayer.addChild(g)
  }

  private drawDeskFallback() {
    const g = new Graphics()

    g.roundRect(-46, -6, 92, 34, 10)
    g.fill(STYLE.deskTop)
    g.stroke({ color: STYLE.deskStroke, width: 1.5, alpha: 0.55 })
    g.roundRect(-44, 22, 88, 8, 4)
    g.fill(STYLE.deskEdge)

    g.roundRect(-22, -48, 44, 30, 6)
    g.fill(STYLE.monitor)

    const screenGrad = new FillGradient({
      type: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: STYLE.screenTop },
        { offset: 1, color: STYLE.screenBottom },
      ],
      textureSpace: 'local',
    })
    g.roundRect(-18, -44, 36, 22, 4)
    g.fill(screenGrad)

    g.roundRect(-20, 0, 40, 8, 4)
    g.fill(STYLE.keyboard)

    g.ellipse(18, 6, 5, 7)
    g.fill(STYLE.mouse)

    this.deskLayer.addChild(g)
  }
}
