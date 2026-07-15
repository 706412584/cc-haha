import { Texture } from 'pixi.js'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKS } from '../layout/officeLayout'
import { DeskEntity } from './DeskEntity'

vi.mock('../assets/loadOfficeAssets', () => ({
  getOfficeDeskTexture: vi.fn(),
  getOfficeChairTexture: vi.fn(),
}))

import {
  getOfficeChairTexture,
  getOfficeDeskTexture,
} from '../assets/loadOfficeAssets'

beforeAll(() => {
  const gradient = { addColorStop: vi.fn() }
  const context = {
    createLinearGradient: vi.fn(() => gradient),
    createRadialGradient: vi.fn(() => gradient),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    set fillStyle(_value: unknown) {},
    set globalCompositeOperation(_value: string) {},
  } as unknown as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((
    (contextId: string) => contextId === '2d' ? context : null
  ) as HTMLCanvasElement['getContext'])
})

beforeEach(() => {
  vi.mocked(getOfficeDeskTexture).mockReturnValue(Texture.WHITE)
  vi.mocked(getOfficeChairTexture).mockReturnValue(Texture.WHITE)
})

describe('DeskEntity', () => {
  it('mounts textures, reports the seat, and remounts late assets', () => {
    const deskData = DESKS[0]!
    const desk = new DeskEntity(deskData)

    expect(desk.getSeatPosition()).toEqual({ x: deskData.seatX, y: deskData.seatY })
    expect(desk.deskLayer.children).toHaveLength(1)
    expect(desk.chairLayer.children).toHaveLength(1)

    desk.remountSprites()
    expect(desk.deskLayer.children).toHaveLength(1)
    expect(desk.chairLayer.children).toHaveLength(1)
  })

  it('uses vector fallbacks when textures are unavailable', () => {
    vi.mocked(getOfficeDeskTexture).mockReturnValue(null)
    vi.mocked(getOfficeChairTexture).mockReturnValue(null)

    const desk = new DeskEntity(DESKS[0]!)

    expect(desk.deskLayer.children).toHaveLength(1)
    expect(desk.chairLayer.children).toHaveLength(1)
  })

  it('updates layers and occupied indicator from nearby agents', () => {
    const deskData = DESKS[0]!
    const desk = new DeskEntity(deskData)

    desk.updateDepthZ([{ x: deskData.x, y: deskData.seatY }])
    expect(desk.screenActivityLayer.zIndex).toBe(desk.deskLayer.zIndex + 0.5)
    expect(desk.occupiedIndicator.zIndex).toBe(desk.chairLayer.zIndex + 0.5)

    desk.setOccupied(true)
    expect(desk.occupiedIndicator.context.instructions.length).toBeGreaterThan(0)
    desk.setOccupied(false)
    expect(desk.occupiedIndicator.context.instructions).toHaveLength(0)
  })

  it('shows the selected leisure content and clears it when the event ends', () => {
    const desk = new DeskEntity(DESKS[0]!)

    desk.setScreenActivity('watch')
    expect(desk.screenActivity).toBe('watch')
    expect(desk.screenActivityLayer.visible).toBe(true)

    desk.setScreenActivity('game')
    expect(desk.screenActivity).toBe('game')

    desk.setScreenActivity(undefined)
    expect(desk.screenActivity).toBeUndefined()
    expect(desk.screenActivityLayer.visible).toBe(false)
  })
})
