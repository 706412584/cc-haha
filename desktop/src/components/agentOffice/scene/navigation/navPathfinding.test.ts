import { describe, expect, it } from 'vitest'
import type { Agent } from '../../types/agent'
import { DESKS } from '../layout/officeLayout'
import {
  createNavContext,
  polylineCrossesSeat,
  segmentCrossesSeat,
  shortestPath,
} from './navPathfinding'

describe('navigation pathfinding', () => {
  it('detects seat intersections and honors excluded desks', () => {
    const desk = DESKS[0]!

    expect(segmentCrossesSeat(
      desk.seatX - 50,
      desk.seatY,
      desk.seatX + 50,
      desk.seatY,
    )).toBe(true)
    expect(segmentCrossesSeat(
      desk.seatX,
      desk.seatY,
      desk.seatX,
      desk.seatY,
      undefined,
      { excludeDeskIds: [desk.id] },
    )).toBe(false)
  })

  it('ignores the moving agent while treating seated active agents as obstacles', () => {
    const desk = DESKS[0]!
    const seated: Agent = {
      id: 'host',
      name: 'Host',
      color: 0,
      x: desk.seatX,
      y: desk.seatY,
      state: 'thinking',
      assignedDeskId: desk.id,
      facing: 1,
    }
    const context = createNavContext([seated], 'host')

    expect(context).toEqual({ agents: [seated], selfAgentId: 'host' })
    expect(segmentCrossesSeat(
      desk.seatX - 10,
      desk.seatY,
      desk.seatX + 10,
      desk.seatY,
      context,
      { excludeDeskIds: [desk.id] },
    )).toBe(false)
  })

  it('chooses the shortest available graph route', () => {
    const nodes = new Map([
      ['a', { id: 'a', x: 0, y: 0 }],
      ['b', { id: 'b', x: 10, y: 0 }],
      ['c', { id: 'c', x: 0, y: 20 }],
      ['d', { id: 'd', x: 20, y: 0 }],
    ])
    const adjacency = new Map([
      ['a', ['b', 'c']],
      ['b', ['a', 'd']],
      ['c', ['a', 'd']],
      ['d', ['b', 'c']],
    ])

    expect(shortestPath(nodes, adjacency, 'a', 'd')).toEqual(['a', 'b', 'd'])
    expect(shortestPath(nodes, adjacency, 'a', 'a')).toEqual(['a'])
  })

  it('returns null when no graph route reaches the target', () => {
    const nodes = new Map([
      ['a', { id: 'a', x: 0, y: 0 }],
      ['b', { id: 'b', x: 10, y: 0 }],
    ])

    expect(shortestPath(nodes, new Map([['a', []]]), 'a', 'b')).toBeNull()
  })

  it('checks every segment in a polyline', () => {
    const desk = DESKS[0]!
    expect(polylineCrossesSeat([
      { x: 0, y: 0 },
      { x: desk.seatX - 50, y: desk.seatY },
      { x: desk.seatX + 50, y: desk.seatY },
    ])).toBe(true)
    expect(polylineCrossesSeat([{ x: 0, y: 0 }])).toBe(false)
  })
})
