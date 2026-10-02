import { describe, expect, it } from 'vitest'
import {
  PDF_CSS_UNITS,
  anchoredScrollTop,
  currentPageIndex,
  layoutPdfColumn,
  offsetOf,
  positionAt,
  scrollTopForPage,
  visiblePageRange,
  type PageSize,
} from './pdfLayout'

const A4: PageSize = { width: 800, height: 1000 }
const GAP = 10
const PADDING = 20

function column(pages: number, zoom = 1, size: PageSize = A4) {
  return layoutPdfColumn(Array.from({ length: pages }, () => size), zoom, { gap: GAP, padding: PADDING })
}

describe('PDF_CSS_UNITS', () => {
  it('converts PDF points (1/72 in) to CSS pixels (1/96 in)', () => {
    expect(PDF_CSS_UNITS).toBeCloseTo(1.3333, 4)
    // A US Letter page is 612 × 792 pt = 816 × 1056 CSS px.
    expect(612 * PDF_CSS_UNITS).toBe(816)
    expect(792 * PDF_CSS_UNITS).toBe(1056)
  })
})

describe('layoutPdfColumn', () => {
  it('stacks pages with a gap between them and padding around the whole column', () => {
    const { boxes, height, width } = column(3)

    expect(boxes.map((box) => box.top)).toEqual([20, 1030, 2040])
    expect(height).toBe(20 + 1000 + 10 + 1000 + 10 + 1000 + 20)
    expect(width).toBe(800)
  })

  it('scales the pages with the zoom but not the gutters between them', () => {
    const { boxes, height } = column(2, 2)

    expect(boxes[0]).toEqual({ top: 20, width: 1600, height: 2000 })
    expect(boxes[1]!.top).toBe(20 + 2000 + GAP)
    expect(height).toBe(20 + 2000 + GAP + 2000 + 20)
  })

  it('sizes each page on its own, so a landscape page in a portrait document is not squashed', () => {
    const { boxes, width } = layoutPdfColumn(
      [{ width: 800, height: 1000 }, { width: 1200, height: 700 }],
      1,
      { gap: GAP, padding: PADDING },
    )

    expect(boxes[1]).toEqual({ top: 20 + 1000 + GAP, width: 1200, height: 700 })
    expect(width).toBe(1200)
  })

  it('has just its padding when there are no pages', () => {
    expect(column(0)).toEqual({ boxes: [], width: 0, height: PADDING * 2 })
  })
})

describe('visiblePageRange', () => {
  const { boxes } = column(10)

  it('finds the pages that intersect the viewport', () => {
    // Viewport 900..1700 covers the second page (1030..2030) and the last sliver of the first.
    expect(visiblePageRange(boxes, 900, 800)).toEqual({ first: 0, last: 1 })
    expect(visiblePageRange(boxes, 1100, 800)).toEqual({ first: 1, last: 1 })
  })

  it('reaches into neighbouring pages by the margin', () => {
    // A 1100..1900 viewport sits inside page 1; a 1000px margin pulls page 2 and page 0 in.
    expect(visiblePageRange(boxes, 1100, 800, 1000)).toEqual({ first: 0, last: 2 })
  })

  it('starts at the first page at the top of the document', () => {
    expect(visiblePageRange(boxes, 0, 800)).toEqual({ first: 0, last: 0 })
  })

  it('ends at the last page at the bottom of the document', () => {
    const bottom = boxes[9]!.top + boxes[9]!.height + PADDING - 800
    expect(visiblePageRange(boxes, bottom, 800)).toEqual({ first: 9, last: 9 })
  })

  it('finds nothing over the gutter between two pages when there is no margin', () => {
    // The gutter is 1020..1030; a 4px viewport inside it shows no page.
    expect(visiblePageRange(boxes, 1023, 4)).toBeNull()
  })

  it('finds nothing for an empty column or a viewport past the end', () => {
    expect(visiblePageRange([], 0, 800)).toBeNull()
    expect(visiblePageRange(boxes, 1e9, 800)).toBeNull()
  })

  it('agrees with a plain scan over every scroll offset', () => {
    // The binary search is the part worth cross-checking against the obvious O(n) answer.
    const sizes: PageSize[] = Array.from({ length: 40 }, (_, i) => ({ width: 800, height: 300 + (i % 7) * 90 }))
    const { boxes: mixed } = layoutPdfColumn(sizes, 1.3, { gap: 12, padding: 24 })
    for (let scrollTop = 0; scrollTop < 20000; scrollTop += 137) {
      for (const margin of [0, 250]) {
        const start = scrollTop - margin
        const end = scrollTop + 700 + margin
        const hits = mixed.flatMap((box, index) => (box.top + box.height > start && box.top < end ? [index] : []))
        const range = visiblePageRange(mixed, scrollTop, 700, margin)
        expect(range === null ? [] : [range.first, range.last]).toEqual(hits.length ? [hits[0], hits[hits.length - 1]] : [])
      }
    }
  })
})

describe('currentPageIndex', () => {
  const { boxes } = column(5)

  it('is the page showing the most of the viewport', () => {
    // 800px viewport from 1200: 830px of page 1 (1030..2030) vs none of page 0.
    expect(currentPageIndex(boxes, 1200, 800)).toBe(1)
    // From 700: page 0 shows 700..1020 (320px), page 1 shows 1030..1500 (470px).
    expect(currentPageIndex(boxes, 700, 800)).toBe(1)
    // From 300: page 0 shows 300..1020 (720px), page 1 shows 1030..1100 (70px).
    expect(currentPageIndex(boxes, 300, 800)).toBe(0)
  })

  it('goes to the earlier page on a tie', () => {
    // A viewport centred on the gutter (centre 1025) shows the same amount of
    // both pages: 295px of page 0 above it, 295px of page 1 below.
    expect(currentPageIndex(boxes, 1025 - 300, 600)).toBe(0)
  })

  it('is the first page at the top and the last page at the bottom', () => {
    expect(currentPageIndex(boxes, 0, 800)).toBe(0)
    const bottom = boxes[4]!.top + boxes[4]!.height + PADDING - 800
    expect(currentPageIndex(boxes, bottom, 800)).toBe(4)
  })

  it('falls back to the page nearest the centre when the viewport is over nothing but gutter', () => {
    // 1023..1027 is inside the 1020..1030 gutter: its centre belongs to the page below.
    expect(currentPageIndex(boxes, 1023, 4)).toBe(1)
  })

  it('stays on a real page when scrolled past either end', () => {
    expect(currentPageIndex(boxes, 1e9, 800)).toBe(4)
    expect(currentPageIndex(boxes, -500, 100)).toBe(0)
  })

  it('is 0 for an empty column', () => {
    expect(currentPageIndex([], 0, 800)).toBe(0)
  })
})

describe('scrollTopForPage', () => {
  const { boxes } = column(4)

  it('puts a page at the top of the viewport, optionally inset', () => {
    expect(scrollTopForPage(boxes, 2)).toBe(2040)
    expect(scrollTopForPage(boxes, 2, 20)).toBe(2020)
  })

  it('never scrolls above the start, and tolerates an out-of-range index', () => {
    // Page 0 starts at the column's padding (20), so an inset larger than that clamps to 0.
    expect(scrollTopForPage(boxes, 0)).toBe(20)
    expect(scrollTopForPage(boxes, 0, 100)).toBe(0)
    expect(scrollTopForPage(boxes, 99)).toBe(scrollTopForPage(boxes, 3))
    expect(scrollTopForPage(boxes, -5)).toBe(scrollTopForPage(boxes, 0))
    expect(scrollTopForPage([], 0)).toBe(0)
  })
})

describe('document positions', () => {
  const { boxes } = column(4)

  it('names a place as a page and how far down it', () => {
    expect(positionAt(boxes, 1030 + 250)).toEqual({ page: 1, fraction: 0.25 })
    expect(positionAt(boxes, 20)).toEqual({ page: 0, fraction: 0 })
  })

  it('round-trips through the same layout', () => {
    for (const y of [0, 20, 500, 1025, 1030, 1900, 3000, 4100]) {
      expect(offsetOf(boxes, positionAt(boxes, y))).toBeCloseTo(y, 6)
    }
  })

  it('keeps a point in a gutter in the gutter, above the page below it', () => {
    const position = positionAt(boxes, 1025)
    expect(position.page).toBe(1)
    expect(position.fraction).toBeLessThan(0)
  })
})

describe('anchoredScrollTop', () => {
  it('keeps the same spot in the same page under the anchor when zooming in', () => {
    const before = column(6, 1).boxes
    const after = column(6, 2).boxes
    const scrollTop = 3400
    const anchorY = 300

    const next = anchoredScrollTop({ before, after, scrollTop, anchorY })

    // Whatever page and fraction was under the anchor row before is under it now.
    const was = positionAt(before, scrollTop + anchorY)
    const is = positionAt(after, next + anchorY)
    expect(is.page).toBe(was.page)
    expect(is.fraction).toBeCloseTo(was.fraction, 6)
  })

  it('does not drift with the page count the way a single scale ratio would', () => {
    const before = column(50, 1).boxes
    const after = column(50, 3).boxes
    const scrollTop = before[40]!.top + 400 // deep in the document, 400px into page 40
    const anchorY = 0

    const exact = anchoredScrollTop({ before, after, scrollTop, anchorY })
    const naive = scrollTop * 3

    expect(exact).toBeCloseTo(after[40]!.top + 400 * 3, 6)
    // Forty gutters that did not scale: the naive answer is hundreds of pixels off.
    expect(Math.abs(naive - exact)).toBeGreaterThan(500)
  })

  it('round-trips a zoom in and back out', () => {
    const one = column(20, 1).boxes
    const two = column(20, 1.75).boxes
    const start = 5000

    const zoomedIn = anchoredScrollTop({ before: one, after: two, scrollTop: start, anchorY: 220 })
    const back = anchoredScrollTop({ before: two, after: one, scrollTop: zoomedIn, anchorY: 220 })

    expect(back).toBeCloseTo(start, 6)
  })

  it('is unchanged when the layout is', () => {
    const boxes = column(8).boxes

    expect(anchoredScrollTop({ before: boxes, after: boxes, scrollTop: 1234, anchorY: 90 })).toBeCloseTo(1234, 6)
  })
})
