import { describe, expect, it } from 'vitest'
import {
  isHorizontalWalk,
  resolveTalkViewFacing,
  resolveWalkViewFacing,
  talkFacingToward,
  viewFacingToLR,
} from './movementFacing'

describe('movement facing', () => {
  it.each([
    [0, 0, 'front'],
    [-10, 2, 'left'],
    [10, 10, 'right'],
    [1, -10, 'back'],
    [1, 10, 'front'],
  ] as const)('resolves walk vector (%s, %s) as %s', (dx, dy, expected) => {
    expect(resolveWalkViewFacing(dx, dy)).toBe(expected)
  })

  it.each([
    [0, 0, -7, 0, 'left'],
    [0, 0, 7, 0, 'right'],
    [0, 0, 6, -1, 'back'],
    [0, 0, -6, 1, 'front'],
  ] as const)('faces a conversation target', (fx, fy, tx, ty, expected) => {
    expect(resolveTalkViewFacing(fx, fy, tx, ty)).toBe(expected)
  })

  it('converts view direction to legacy left/right facing', () => {
    expect(viewFacingToLR('left')).toBe(-1)
    expect(viewFacingToLR('back')).toBe(1)
    expect(talkFacingToward(10, 0, 0, 0)).toEqual({
      viewFacing: 'left',
      facing: -1,
    })
  })

  it('treats ties as horizontal movement', () => {
    expect(isHorizontalWalk(4, -4)).toBe(true)
    expect(isHorizontalWalk(3, 4)).toBe(false)
  })
})
