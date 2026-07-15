import { describe, expect, it } from 'vitest'
import { DESKS } from '../layout/officeLayout'
import {
  getDeskVisitStandPoint,
  planWalkTo,
  planWalkToDeskSeat,
  planWalkToDeskVisit,
} from './officeNavigation'

describe('office navigation blocked fallbacks', () => {
  it('reaches every other desk visit stand without truncating the route', () => {
    for (const visitorDesk of DESKS) {
      for (const hostDesk of DESKS) {
        if (visitorDesk.id === hostDesk.id) continue

        const path = planWalkToDeskVisit(
          visitorDesk.seatX,
          visitorDesk.seatY,
          hostDesk,
          visitorDesk,
        )
        const expected = getDeskVisitStandPoint(
          visitorDesk,
          hostDesk,
          visitorDesk.seatX,
          visitorDesk.seatY,
        )

        expect(path.at(-1), `${visitorDesk.id} -> ${hostDesk.id}`).toEqual(expected)
      }
    }
  })
  it('returns no route instead of an unvalidated direct destination when the graph is blocked', () => {
    const blockers = DESKS.map((desk, index) => ({
      id: `blocker-${index}`,
      name: `Blocker ${index}`,
      color: 0,
      x: desk.seatX,
      y: desk.seatY,
      state: 'working' as const,
      assignedDeskId: desk.id,
      facing: 1 as const,
    }))
    const context = { agents: blockers, selfAgentId: 'visitor' }
    const from = { x: 330, y: 180 }
    const target = DESKS[5]!

    const path = planWalkTo(from.x, from.y, target.seatX, target.seatY, context)

    expect(path).toEqual([])
  })

  it('never appends a blocked seat after rejecting its approach segments', () => {
    const target = DESKS[0]!
    const blockers = DESKS.map((desk, index) => ({
      id: `blocker-${index}`,
      name: `Blocker ${index}`,
      color: 0,
      x: desk.seatX,
      y: desk.seatY,
      state: 'working' as const,
      assignedDeskId: desk.id,
      facing: 1 as const,
    }))
    const from = { x: target.seatX, y: target.seatY + 100 }
    const context = { agents: blockers, selfAgentId: 'visitor' }

    const path = planWalkToDeskSeat(from.x, from.y, target, context)

    expect(path.at(-1)).not.toEqual({ x: target.seatX, y: target.seatY })
  })
})
