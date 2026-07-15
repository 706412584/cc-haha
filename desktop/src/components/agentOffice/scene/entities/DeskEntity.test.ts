import { Texture } from 'pixi.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  vi.mocked(getOfficeDeskTexture).mockReturnValue(Texture.WHITE)
  vi.mocked(getOfficeChairTexture).mockReturnValue(Texture.WHITE)
})

describe('DeskEntity ambient screen', () => {
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
