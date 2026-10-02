import { describe, expect, it } from 'vitest'
import {
  DOUBLE_PRESS_MS,
  DOUBLE_PRESS_SLOP,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  anchoredScroll,
  anchoredScrollLeft,
  clampZoom,
  continuesDoublePress,
  fitScale,
  fitWidthScale,
  stepZoom,
  wheelZoom,
  zoomPercent,
} from './zoomPan'

describe('ZOOM_STEPS', () => {
  it('is strictly increasing and spans the whole zoom range, with 100% on it', () => {
    expect(ZOOM_STEPS[0]).toBe(ZOOM_MIN)
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(ZOOM_MAX)
    expect(ZOOM_STEPS).toContain(1)
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual([...ZOOM_STEPS])
    expect(new Set(ZOOM_STEPS).size).toBe(ZOOM_STEPS.length)
  })
})

describe('clampZoom', () => {
  it('holds a value inside the limits', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN)
    expect(clampZoom(99)).toBe(ZOOM_MAX)
    expect(clampZoom(1.5)).toBe(1.5)
    expect(clampZoom(0.1, { min: 0.3 })).toBe(0.3)
  })

  it('falls back to 100% for a value that is not a number', () => {
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('stepZoom', () => {
  it('steps to the adjacent rung', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(2, 1)).toBe(2.5)
    expect(stepZoom(0.5, -1)).toBe(0.33)
  })

  it('goes from an off-ladder value to the nearest rung in the requested direction', () => {
    // A wheel zoom can leave 1.37: "+" must go up to 1.5, "−" down to 1.25 — not skip a rung.
    expect(stepZoom(1.37, 1)).toBe(1.5)
    expect(stepZoom(1.37, -1)).toBe(1.25)
  })

  it('does not treat float noise as a different rung', () => {
    expect(stepZoom(1.0000001, 1)).toBe(1.1)
    expect(stepZoom(0.9999999, -1)).toBe(0.9)
  })

  it('stays put at either end of the ladder', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
  })

  it('respects narrower limits', () => {
    expect(stepZoom(0.5, -1, { min: 0.5 })).toBe(0.5)
    expect(stepZoom(2, 1, { max: 2 })).toBe(2)
    expect(stepZoom(0.4, 1, { min: 0.3 })).toBe(0.5)
  })
})

describe('wheelZoom', () => {
  it('zooms in for a negative delta and out for a positive one', () => {
    expect(wheelZoom(1.3, -10)).toBeGreaterThan(1.3)
    expect(wheelZoom(1.3, 10)).toBeLessThan(1.3)
  })

  it('caps how far one event can move, so a large mouse notch cannot jump the view', () => {
    const huge = wheelZoom(1.3, 5000)
    const capped = wheelZoom(1.3, 20)
    expect(huge).toBeCloseTo(capped, 6)
  })

  it('snaps to a rung within 2% so 100% is reachable by wheel', () => {
    // exp(-0.005 * -3) ≈ 1.0151 → 1.0151 is within 2% of 1
    expect(wheelZoom(1, -3)).toBe(1)
    expect(wheelZoom(1, 3)).toBe(1)
  })

  it('stays inside the limits', () => {
    expect(wheelZoom(ZOOM_MAX, -20)).toBe(ZOOM_MAX)
    expect(wheelZoom(ZOOM_MIN, 20)).toBe(ZOOM_MIN)
    expect(wheelZoom(0.31, 20, { min: 0.3 })).toBeGreaterThanOrEqual(0.3)
  })
})

describe('fitScale', () => {
  const box = { containerWidth: 800, containerHeight: 600 }

  it('fits the whole content inside the container', () => {
    expect(fitScale({ ...box, contentWidth: 1600, contentHeight: 400 })).toBe(0.5)
    expect(fitScale({ ...box, contentWidth: 400, contentHeight: 1800 })).toBeCloseTo(1 / 3, 5)
  })

  it('does not enlarge small content beyond 100% by default', () => {
    expect(fitScale({ ...box, contentWidth: 100, contentHeight: 100 })).toBe(1)
    expect(fitScale({ ...box, contentWidth: 100, contentHeight: 100, maxScale: 3 })).toBe(3)
  })

  it('keeps padding clear on every side', () => {
    // 800 − 2×100 = 600 available: 600 / 1600. Without the padding it would be 0.5.
    expect(fitScale({ ...box, contentWidth: 1600, contentHeight: 400, padding: 100 })).toBe(0.375)
    expect(fitScale({ ...box, contentWidth: 1600, contentHeight: 400, padding: 50 })).toBe(0.4375)
  })

  it('is 100% for content with no size, and never zero for a collapsed container', () => {
    expect(fitScale({ ...box, contentWidth: 0, contentHeight: 0 })).toBe(1)
    expect(fitScale({ containerWidth: 0, containerHeight: 0, contentWidth: 100, contentHeight: 100 })).toBeGreaterThan(0)
  })
})

describe('fitWidthScale', () => {
  it('fits a page to the container width, capped at 100% by default', () => {
    expect(fitWidthScale({ containerWidth: 400, contentWidth: 800 })).toBe(0.5)
    expect(fitWidthScale({ containerWidth: 1600, contentWidth: 800 })).toBe(1)
    expect(fitWidthScale({ containerWidth: 1600, contentWidth: 800, maxScale: 2 })).toBe(2)
  })

  it('accounts for padding and a lower bound', () => {
    expect(fitWidthScale({ containerWidth: 500, contentWidth: 800, padding: 50 })).toBe(0.5)
    expect(fitWidthScale({ containerWidth: 50, contentWidth: 2000, min: 0.3 })).toBe(0.3)
  })
})

describe('anchoredScroll', () => {
  it('keeps the content point under the pointer still when zooming in', () => {
    const before = { scrollLeft: 200, scrollTop: 100, anchorX: 300, anchorY: 150 }
    const oldScale = 1
    const newScale = 2
    const after = anchoredScroll({ ...before, oldScale, newScale })

    // The content coordinate under the pointer, in unscaled units, must not move.
    const contentBefore = { x: (before.scrollLeft + before.anchorX) / oldScale, y: (before.scrollTop + before.anchorY) / oldScale }
    const contentAfter = { x: (after.scrollLeft + before.anchorX) / newScale, y: (after.scrollTop + before.anchorY) / newScale }
    expect(contentAfter.x).toBeCloseTo(contentBefore.x, 6)
    expect(contentAfter.y).toBeCloseTo(contentBefore.y, 6)
  })

  it('round-trips: zooming in and back out restores the original offset', () => {
    const start = { scrollLeft: 137, scrollTop: 411, anchorX: 90, anchorY: 60 }
    const zoomedIn = anchoredScroll({ ...start, oldScale: 1, newScale: 1.75 })
    const back = anchoredScroll({ ...start, ...zoomedIn, oldScale: 1.75, newScale: 1 })

    expect(back.scrollLeft).toBeCloseTo(start.scrollLeft, 6)
    expect(back.scrollTop).toBeCloseTo(start.scrollTop, 6)
  })

  it('anchors at the origin when zooming from the very top-left', () => {
    expect(anchoredScroll({ scrollLeft: 0, scrollTop: 0, anchorX: 0, anchorY: 0, oldScale: 1, newScale: 3 })).toEqual({
      scrollLeft: 0,
      scrollTop: 0,
    })
  })

  it('leaves the offset alone for a degenerate scale', () => {
    expect(anchoredScroll({ scrollLeft: 5, scrollTop: 6, anchorX: 1, anchorY: 1, oldScale: 0, newScale: 2 })).toEqual({
      scrollLeft: 5,
      scrollTop: 6,
    })
  })
})

describe('zoomPercent', () => {
  it('rounds to the whole percentage a person reads', () => {
    expect(zoomPercent(1)).toBe(100)
    expect(zoomPercent(1.1)).toBe(110)
    expect(zoomPercent(0.333)).toBe(33)
    expect(zoomPercent(0.675)).toBe(68)
  })
})

describe('anchoredScrollLeft', () => {
  const VIEWPORT = 700
  const PAD = 16
  /** The scrollable width the viewer gives a column: the column and its padding, or the viewport if wider. */
  const contentWidth = (pageWidth: number) => Math.max(VIEWPORT, pageWidth + PAD * 2)

  it('keeps a column that fits centred when zoomed to a size that still fits', () => {
    const next = anchoredScrollLeft({
      scrollLeft: 0,
      anchorX: VIEWPORT / 2,
      oldScale: 0.5,
      newScale: 0.75,
      oldContentWidth: contentWidth(400),
      newContentWidth: contentWidth(600),
    })

    expect(next).toBeCloseTo(0, 6)
  })

  it('zooms a column that fitted into one that overflows without sliding to either side', () => {
    // 500 → 1000 wide: the column filled the viewport before and now overflows it.
    // The middle of the viewport was the middle of the page, and still is.
    const next = anchoredScrollLeft({
      scrollLeft: 0,
      anchorX: VIEWPORT / 2,
      oldScale: 1,
      newScale: 2,
      oldContentWidth: contentWidth(500),
      newContentWidth: contentWidth(1000),
    })

    expect(next + VIEWPORT / 2).toBeCloseTo(contentWidth(1000) / 2, 6)
  })

  it('does not treat the viewport centre as the page centre once the column overflows', () => {
    // Scrolled to the far left of an 832px column in a 700px viewport, the viewport
    // centre is 66px left of the page centre. Doubling the zoom doubles that gap.
    const next = anchoredScrollLeft({
      scrollLeft: 0,
      anchorX: VIEWPORT / 2,
      oldScale: 1,
      newScale: 2,
      oldContentWidth: contentWidth(800),
      newContentWidth: contentWidth(1600),
    })

    expect(next + VIEWPORT / 2).toBeCloseTo(contentWidth(1600) / 2 - 2 * 66, 6)
  })

  it('keeps the point under the pointer under the pointer', () => {
    const oldWidth = contentWidth(1200)
    const newWidth = contentWidth(2400)
    const scrollLeft = 200
    const anchorX = 120

    const next = anchoredScrollLeft({
      scrollLeft,
      anchorX,
      oldScale: 1,
      newScale: 2,
      oldContentWidth: oldWidth,
      newContentWidth: newWidth,
    })

    // Distance from the centre of the content, at the pointer, before and after.
    const before = scrollLeft + anchorX - oldWidth / 2
    const after = next + anchorX - newWidth / 2
    expect(after).toBeCloseTo(before * 2, 6)
  })

  it('is not thrown by padding: a ratio of the raw offsets would be', () => {
    const oldWidth = contentWidth(1200)
    const newWidth = contentWidth(2400)
    const scrollLeft = 100
    const anchorX = 0

    const exact = anchoredScrollLeft({
      scrollLeft,
      anchorX,
      oldScale: 1,
      newScale: 2,
      oldContentWidth: oldWidth,
      newContentWidth: newWidth,
    })
    const naive = (scrollLeft + anchorX) * 2 - anchorX

    // The left edge of the page is `PAD` from the left edge of the content at both
    // zooms, but the naive answer doubles that gutter.
    expect(exact).toBeCloseTo(naive - PAD, 6)
  })

  it('leaves the offset where it is when only the width of the content changes', () => {
    // A rewritten document with a wider page: same zoom, same distance from the centre.
    const next = anchoredScrollLeft({
      scrollLeft: 150,
      anchorX: 0,
      oldScale: 1,
      newScale: 1,
      oldContentWidth: 1000,
      newContentWidth: 1200,
    })

    expect(next).toBeCloseTo(250, 6)
  })

  it('round-trips a zoom in and back out', () => {
    const one = contentWidth(1000)
    const two = contentWidth(1750)
    const start = 137

    const zoomedIn = anchoredScrollLeft({ scrollLeft: start, anchorX: 90, oldScale: 1, newScale: 1.75, oldContentWidth: one, newContentWidth: two })
    const back = anchoredScrollLeft({ scrollLeft: zoomedIn, anchorX: 90, oldScale: 1.75, newScale: 1, oldContentWidth: two, newContentWidth: one })

    expect(back).toBeCloseTo(start, 6)
  })

  it.each([0, -1])('ignores a nonsensical scale of %d rather than producing NaN', (scale) => {
    expect(anchoredScrollLeft({
      scrollLeft: 42,
      anchorX: 10,
      oldScale: scale,
      newScale: 1,
      oldContentWidth: 800,
      newContentWidth: 800,
    })).toBe(42)
  })
})

describe('continuesDoublePress', () => {
  const first = { time: 1000, x: 100, y: 100 }

  it('is a second press soon after the first, on the same spot', () => {
    expect(continuesDoublePress(first, { time: 1200, x: 100, y: 100 })).toBe(true)
    expect(continuesDoublePress(first, { time: 1000 + DOUBLE_PRESS_MS, x: 103, y: 104 })).toBe(true)
  })

  it('is never the second press when there was no first', () => {
    expect(continuesDoublePress(null, { time: 1000, x: 100, y: 100 })).toBe(false)
  })

  it('is not one when the gap is too long', () => {
    expect(continuesDoublePress(first, { time: 1000 + DOUBLE_PRESS_MS + 1, x: 100, y: 100 })).toBe(false)
  })

  it('is not one when the pointer has moved away', () => {
    expect(continuesDoublePress(first, { time: 1100, x: 100 + DOUBLE_PRESS_SLOP + 1, y: 100 })).toBe(false)
    expect(continuesDoublePress(first, { time: 1100, x: 106, y: 106 })).toBe(false)
  })
})
