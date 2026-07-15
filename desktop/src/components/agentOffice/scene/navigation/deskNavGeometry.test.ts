import { describe, expect, it } from 'vitest'
import { DESKS } from '../layout/officeLayout'
import {
  DESK_DISPLAY_HEIGHT,
  DESK_DISPLAY_WIDTH,
  getDeskBounds,
  getRowCorridorY,
  isFrontRowDesk,
} from './deskNavGeometry'

describe('desk navigation geometry', () => {
  it('returns sprite-aligned bounds around a desk', () => {
    const desk = DESKS[0]!
    const bounds = getDeskBounds(desk)

    expect(bounds.right - bounds.left).toBeCloseTo(DESK_DISPLAY_WIDTH)
    expect(bounds.bottom - bounds.top).toBeCloseTo(DESK_DISPLAY_HEIGHT)
    expect(bounds.left).toBeLessThan(desk.x)
    expect(bounds.right).toBeGreaterThan(desk.x)
  })

  it('uses the seat row as its corridor and applies the front-row tolerance', () => {
    const desk = DESKS[0]!
    expect(getRowCorridorY(desk)).toBe(desk.seatY)
    expect(isFrontRowDesk(desk, desk.seatY + 7.9)).toBe(true)
    expect(isFrontRowDesk(desk, desk.seatY + 8)).toBe(false)
  })
})
