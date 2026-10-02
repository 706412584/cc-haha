/**
 * The arithmetic behind every zoomable viewer: the image viewer, and the PDF and
 * Word surfaces after it. Kept free of the DOM so the parts that are easy to get
 * subtly wrong — which rung "+" lands on, where the scroll offset goes when the
 * scale changes under the pointer — can be pinned by tests rather than by eye.
 *
 * A "zoom" here is a scale factor against the content's natural size (1 = 100%).
 */

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 8

/**
 * The rungs "+" and "−" step between. The same ladder as the desktop apps this
 * is modelled on: fine near 100%, where people actually read, coarse at the ends.
 */
export const ZOOM_STEPS: readonly number[] = [
  0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8,
]

export type ZoomLimits = { min?: number; max?: number }

/** Two zoom values closer than this are the same zoom (float noise from wheel maths). */
const EPSILON = 1e-3

export function clampZoom(value: number, { min = ZOOM_MIN, max = ZOOM_MAX }: ZoomLimits = {}): number {
  if (!Number.isFinite(value)) return Math.min(Math.max(1, min), max)
  return Math.min(Math.max(value, min), max)
}

/**
 * The next rung above (`1`) or below (`-1`) `current`, or `current` itself at the
 * end of the ladder. Works from an off-ladder value — a wheel zoom can leave the
 * scale at 1.37 — by moving to the nearest rung in that direction.
 */
export function stepZoom(current: number, direction: 1 | -1, limits: ZoomLimits = {}): number {
  const { min = ZOOM_MIN, max = ZOOM_MAX } = limits
  const rungs = ZOOM_STEPS.filter((step) => step >= min - EPSILON && step <= max + EPSILON)
  const next = direction === 1
    ? rungs.find((step) => step > current + EPSILON)
    : [...rungs].reverse().find((step) => step < current - EPSILON)
  return clampZoom(next ?? current, limits)
}

/**
 * Zoom for a wheel gesture. Ctrl+wheel is also how a trackpad pinch arrives, and
 * it delivers many small deltas, so the change is exponential in the delta (a
 * fixed factor per event would make a fast pinch and a slow one feel different)
 * and each event's delta is clamped so one large mouse-wheel notch cannot jump
 * the page. Landing within 2% of a rung snaps to it, so 100% is reachable.
 */
export function wheelZoom(current: number, deltaY: number, limits: ZoomLimits = {}): number {
  const clampedDelta = Math.min(Math.max(deltaY, -20), 20)
  const scaled = clampZoom(current * Math.exp(-clampedDelta * 0.005), limits)
  const snapped = ZOOM_STEPS.find((step) => Math.abs(step - scaled) / step < 0.02)
  return snapped === undefined ? scaled : clampZoom(snapped, limits)
}

export type FitInput = {
  containerWidth: number
  containerHeight: number
  contentWidth: number
  contentHeight: number
  /** Space kept clear around the content on every side. */
  padding?: number
  /** Fit never enlarges past this (1 = do not upscale a small image). */
  maxScale?: number
}

/** The scale at which the whole content is visible ("fit to window"). */
export function fitScale({
  containerWidth,
  containerHeight,
  contentWidth,
  contentHeight,
  padding = 0,
  maxScale = 1,
}: FitInput): number {
  if (contentWidth <= 0 || contentHeight <= 0) return 1
  const availableWidth = Math.max(containerWidth - padding * 2, 1)
  const availableHeight = Math.max(containerHeight - padding * 2, 1)
  return clampZoom(
    Math.min(availableWidth / contentWidth, availableHeight / contentHeight, maxScale),
  )
}

/**
 * The scale at which the content spans the container's width — the default for a
 * document, which reads top to bottom. Capped so a narrow page is not blown up to
 * fill a wide panel.
 */
export function fitWidthScale({
  containerWidth,
  contentWidth,
  padding = 0,
  maxScale = 1,
  min = ZOOM_MIN,
}: {
  containerWidth: number
  contentWidth: number
  padding?: number
  maxScale?: number
  min?: number
}): number {
  if (contentWidth <= 0) return 1
  return clampZoom(Math.min(Math.max(containerWidth - padding * 2, 1) / contentWidth, maxScale), { min })
}

export type ScrollAnchorInput = {
  scrollLeft: number
  scrollTop: number
  /** The point to keep still, in the scroll container's own (viewport) coordinates. */
  anchorX: number
  anchorY: number
  oldScale: number
  newScale: number
}

/**
 * The scroll offset that keeps the content point under `anchor` where it was.
 *
 * Zooming without this drifts the view toward the top-left, because scroll
 * offsets are in scaled pixels: the point at `(scrollLeft + anchorX)` in the old
 * scale sits at `* newScale / oldScale` in the new one, and the offset has to
 * absorb the difference. The caller applies the result *after* the content has
 * been resized, and the browser clamps it to the new scrollable range.
 */
export function anchoredScroll({
  scrollLeft,
  scrollTop,
  anchorX,
  anchorY,
  oldScale,
  newScale,
}: ScrollAnchorInput): { scrollLeft: number; scrollTop: number } {
  if (oldScale <= 0 || newScale <= 0) return { scrollLeft, scrollTop }
  const ratio = newScale / oldScale
  return {
    scrollLeft: (scrollLeft + anchorX) * ratio - anchorX,
    scrollTop: (scrollTop + anchorY) * ratio - anchorY,
  }
}

/**
 * The horizontal scroll offset that keeps whatever is under viewport column
 * `anchorX` under it after the zoom — and so the width of the content — changes,
 * for content whose pages sit centred in it (a PDF, a Word document).
 *
 * Centred, so how far a point sits from the content's centre scales exactly with
 * the zoom, whatever the widths of the individual pages and whatever padding the
 * content has. Scaling the offset itself would not: the padding does not grow with
 * the zoom. Content narrower than the viewport is itself centred, so the same holds
 * for it, and the result is simply the browser's clamp to zero once the content
 * stops overflowing.
 */
export function anchoredScrollLeft({
  scrollLeft,
  anchorX,
  oldScale,
  newScale,
  oldContentWidth,
  newContentWidth,
}: {
  scrollLeft: number
  anchorX: number
  oldScale: number
  newScale: number
  /** Width of the scrollable content before and after: the pages and their padding, or the viewport if wider. */
  oldContentWidth: number
  newContentWidth: number
}): number {
  if (oldScale <= 0 || newScale <= 0) return scrollLeft
  const fromCentre = scrollLeft + anchorX - oldContentWidth / 2
  return fromCentre * (newScale / oldScale) + newContentWidth / 2 - anchorX
}

/** A zoom as the whole-number percentage a person reads ("110"). */
export function zoomPercent(scale: number): number {
  return Math.round(scale * 100)
}

/** Where and when a pointer went down. */
export type Press = { time: number; x: number; y: number }

/** The longest gap, in ms, and furthest drift, in px, between the two presses of a double click. */
export const DOUBLE_PRESS_MS = 500
export const DOUBLE_PRESS_SLOP = 8

/**
 * Whether `next` is the second press of a double click on the same surface.
 *
 * Read from the surface's own presses rather than from `dblclick`, which names the
 * element under the pointer for the *second* click even when the first landed on
 * something else. Open a viewer with a click on a thumbnail and the second half of
 * that double click arrives at the viewer as a double click of its own.
 */
export function continuesDoublePress(previous: Press | null, next: Press): boolean {
  return previous !== null
    && next.time - previous.time <= DOUBLE_PRESS_MS
    && Math.hypot(next.x - previous.x, next.y - previous.y) <= DOUBLE_PRESS_SLOP
}
