import { describe, expect, it } from 'vitest'
import { computeWebviewBounds } from './computeWebviewBounds'

describe('computeWebviewBounds', () => {
  it('maps a DOMRect to logical bounds without rounding away high-DPI fractions', () => {
    const rect = { left: 100.4, top: 50.6, width: 800.2, height: 600.9 } as DOMRect
    expect(computeWebviewBounds(rect)).toEqual({ x: 100.4, y: 50.6, width: 800.2, height: 600.9 })
  })

  it('clamps negative/zero sizes to 0', () => {
    const rect = { left: -5, top: -5, width: -10, height: 0 } as DOMRect
    expect(computeWebviewBounds(rect)).toEqual({ x: -5, y: -5, width: 0, height: 0 })
  })
})
