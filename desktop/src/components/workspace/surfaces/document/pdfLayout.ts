/**
 * The geometry of a PDF laid out as one continuous column of pages.
 *
 * Every page's size is known before any of them is drawn, so which pages are on
 * screen is arithmetic on the scroll offset, not something to discover by
 * observing the DOM. Keeping it pure keeps the parts that are easy to get subtly
 * wrong — the binary searches, and where the scroll offset lands when the zoom
 * changes — under test rather than checked by eye.
 */

/** A PDF page is measured in points (1/72 in); the screen in CSS pixels (1/96 in). */
export const PDF_CSS_UNITS = 96 / 72

/** The viewer's spacing: between two pages, and around the column. Neither grows with the zoom. */
export const PDF_PAGE_GAP = 12
export const PDF_PAGE_PADDING = 16

export type PageSize = { width: number; height: number }

export type PageBox = {
  /** Distance from the top of the page column to the top of this page, in CSS px. */
  top: number
  width: number
  height: number
}

export type PdfColumn = {
  boxes: PageBox[]
  /** Height of the whole column, including its padding. */
  height: number
  /** Width of the widest page (not including padding). */
  width: number
}

/**
 * Lay the pages out top to bottom at `zoom` (1 = 100%).
 *
 * `sizes` are the pages' natural sizes in CSS px at 100%. `gap` separates pages;
 * `padding` surrounds the column. Neither scales with the zoom: a page grows, the
 * gutter between two pages does not.
 */
export function layoutPdfColumn(
  sizes: readonly PageSize[],
  zoom: number,
  { gap, padding }: { gap: number; padding: number },
): PdfColumn {
  const boxes: PageBox[] = []
  let top = padding
  let width = 0
  for (const size of sizes) {
    const box = { top, width: size.width * zoom, height: size.height * zoom }
    boxes.push(box)
    top += box.height + gap
    width = Math.max(width, box.width)
  }
  return {
    boxes,
    width,
    height: boxes.length === 0 ? padding * 2 : top - gap + padding,
  }
}

export type PageRange = { first: number; last: number }

/** Index of the first box whose bottom edge is below `y`, or `boxes.length` if none. */
function firstBoxEndingAfter(boxes: readonly PageBox[], y: number): number {
  let low = 0
  let high = boxes.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (boxes[middle]!.top + boxes[middle]!.height > y) high = middle
    else low = middle + 1
  }
  return low
}

/**
 * The pages that intersect the viewport widened by `margin` on both sides
 * (inclusive indexes), or `null` when none does.
 */
export function visiblePageRange(
  boxes: readonly PageBox[],
  scrollTop: number,
  viewportHeight: number,
  margin = 0,
): PageRange | null {
  if (boxes.length === 0) return null
  const start = scrollTop - margin
  const end = scrollTop + viewportHeight + margin
  const first = firstBoxEndingAfter(boxes, start)
  if (first >= boxes.length) return null
  let last = first
  while (last + 1 < boxes.length && boxes[last + 1]!.top < end) last += 1
  if (boxes[first]!.top >= end) return null
  return { first, last }
}

/**
 * The page a reader would say they are on: the one showing the most of the
 * viewport. Ties go to the earlier page. A viewport over nothing but gutter (or
 * past either end) falls back to the page nearest its centre.
 */
export function currentPageIndex(
  boxes: readonly PageBox[],
  scrollTop: number,
  viewportHeight: number,
): number {
  if (boxes.length === 0) return 0
  const viewportEnd = scrollTop + viewportHeight
  const range = visiblePageRange(boxes, scrollTop, viewportHeight)
  if (!range) return Math.max(positionAt(boxes, scrollTop + viewportHeight / 2).page, 0)
  let best = range.first
  let bestVisible = -1
  for (let index = range.first; index <= range.last; index += 1) {
    const box = boxes[index]!
    const visible = Math.min(box.top + box.height, viewportEnd) - Math.max(box.top, scrollTop)
    if (visible > bestVisible) {
      best = index
      bestVisible = visible
    }
  }
  return best
}

/** Scroll offset that puts page `index` at the top of the viewport, `inset` px below its edge. */
export function scrollTopForPage(boxes: readonly PageBox[], index: number, inset = 0): number {
  const box = boxes[Math.min(Math.max(index, 0), boxes.length - 1)]
  return box ? Math.max(box.top - inset, 0) : 0
}

/** A place in the document that survives a change of zoom: a page, and how far down it. */
export type DocumentPosition = { page: number; fraction: number }

/** Which page, and how far down it, the column offset `y` falls on. */
export function positionAt(boxes: readonly PageBox[], y: number): DocumentPosition {
  if (boxes.length === 0) return { page: 0, fraction: 0 }
  const page = Math.min(firstBoxEndingAfter(boxes, y), boxes.length - 1)
  const box = boxes[page]!
  const fraction = box.height > 0 ? (y - box.top) / box.height : 0
  // A point in the gutter above a page has a negative fraction; keep it, so
  // converting back lands in the same gutter rather than snapping onto the page.
  return { page, fraction }
}

/** The column offset of a {@link DocumentPosition} in a (possibly different) layout. */
export function offsetOf(boxes: readonly PageBox[], position: DocumentPosition): number {
  const box = boxes[Math.min(Math.max(position.page, 0), boxes.length - 1)]
  return box ? box.top + position.fraction * box.height : 0
}

/**
 * The vertical scroll offset that keeps whatever is under viewport row `anchorY`
 * under it after `before` becomes `after`.
 *
 * The column cannot be scaled as a whole: pages grow with the zoom but the gutters
 * between them do not, so a single ratio drifts a little further from the anchor
 * with every page above it. Measuring in "page N, this far down" does not.
 */
export function anchoredScrollTop({
  before,
  after,
  scrollTop,
  anchorY,
}: {
  before: readonly PageBox[]
  after: readonly PageBox[]
  scrollTop: number
  anchorY: number
}): number {
  const position = positionAt(before, scrollTop + anchorY)
  return offsetOf(after, position) - anchorY
}
