import { describe, expect, it } from 'vitest'
import { DESKS } from '../layout/officeLayout'
import {
  computeChairLayerZ,
  computeDeskLayerZ,
  getChairDepthSplitY,
  getDeskDepthSplitY,
} from './deskDepthSort'

describe('desk depth sorting', () => {
  it('keeps base depth when no nearby agent changes the overlap', () => {
    const desk = DESKS[0]!

    expect(computeDeskLayerZ(desk, [])).toBe(desk.y)
    expect(computeChairLayerZ(desk, [{ x: desk.x + 100, y: desk.y }])).toBe(desk.seatY + 2)
  })

  it('places desk and chair between agents on opposite sides of the split', () => {
    const desk = DESKS[0]!
    const split = getDeskDepthSplitY(desk)
    const chairSplit = getChairDepthSplitY(desk)

    expect(computeDeskLayerZ(desk, [{ x: desk.x, y: split - 10 }])).toBe(split - 9.5)
    expect(computeDeskLayerZ(desk, [{ x: desk.x, y: split + 10 }])).toBe(desk.y)
    expect(computeChairLayerZ(desk, [
      { x: desk.x, y: chairSplit - 0.1 },
      { x: desk.x, y: chairSplit + 0.1 },
    ])).toBeCloseTo(chairSplit + 0.5)
  })

  it('is independent of agent iteration order when agents straddle a desk', () => {
    const desk = DESKS[0]!
    const agents = [
      { x: desk.x, y: getDeskDepthSplitY(desk) - 0.1 },
      { x: desk.x, y: getDeskDepthSplitY(desk) + 0.1 },
    ]

    expect(computeDeskLayerZ(desk, agents)).toBe(computeDeskLayerZ(desk, [...agents].reverse()))

    const chairAgents = [
      { x: desk.x, y: getChairDepthSplitY(desk) - 0.1 },
      { x: desk.x, y: getChairDepthSplitY(desk) + 0.1 },
    ]
    expect(computeChairLayerZ(desk, chairAgents)).toBe(
      computeChairLayerZ(desk, [...chairAgents].reverse()),
    )
  })
})
