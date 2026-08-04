import { useCallback, useLayoutEffect, useState, type CSSProperties } from 'react'

export type AnchoredPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export type UseAnchoredPositionOptions = {
  open: boolean
  anchorRef: { current: HTMLElement | null }
  floatingRef: { current: HTMLElement | null }
  placement?: AnchoredPlacement
  /** Gap between anchor and overlay, in pixels. */
  offset?: number
  /** Minimum distance to keep from the viewport edge. */
  viewportMargin?: number
  /** Flip to the opposite side when the preferred one would overflow. */
  flip?: boolean
  /** Slide along the cross axis to stay inside the viewport. */
  shift?: boolean
}

export type AnchoredPosition = {
  style: CSSProperties
  placement: AnchoredPlacement
  /**
   * False on the first frame, before the overlay has been measured. Render the
   * overlay with `visibility: hidden` until this flips, or it visibly jumps
   * from the initial guess to the corrected position.
   */
  ready: boolean
}

const DEFAULT_MARGIN = 8

/**
 * Positions a fixed-position overlay next to an anchor, flipping and clamping
 * to stay on screen.
 *
 * Replaces four independent viewport calculations that had drifted apart — the
 * margins were 8, 8, 12 and 0, and only one of them flipped.
 *
 * Measurement happens in a layout effect so the correction lands before paint.
 */
export function useAnchoredPosition({
  open,
  anchorRef,
  floatingRef,
  placement = 'bottom-start',
  offset = 6,
  viewportMargin = DEFAULT_MARGIN,
  flip = true,
  shift = true,
}: UseAnchoredPositionOptions): AnchoredPosition {
  const [state, setState] = useState<{ top: number; left: number; placement: AnchoredPlacement; ready: boolean }>(
    () => ({ top: 0, left: 0, placement, ready: false }),
  )

  const measure = useCallback(() => {
    const anchor = anchorRef.current
    const floating = floatingRef.current
    if (!anchor || !floating) return

    const anchorBox = anchor.getBoundingClientRect()
    const { width, height } = floating.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    const wantsTop = placement.startsWith('top')
    const wantsEnd = placement.endsWith('end')

    let resolved: AnchoredPlacement = placement
    let top = wantsTop ? anchorBox.top - height - offset : anchorBox.bottom + offset

    if (flip && height > 0) {
      const overflowsBottom = !wantsTop && top + height > viewportHeight - viewportMargin
      const overflowsTop = wantsTop && top < viewportMargin
      if (overflowsBottom) {
        const flipped = anchorBox.top - height - offset
        if (flipped >= viewportMargin) {
          top = flipped
          resolved = (wantsEnd ? 'top-end' : 'top-start')
        } else {
          // Neither side fits; keep it on screen at the bottom edge.
          top = Math.max(viewportMargin, viewportHeight - height - viewportMargin)
        }
      } else if (overflowsTop) {
        const flipped = anchorBox.bottom + offset
        if (flipped + height <= viewportHeight - viewportMargin) {
          top = flipped
          resolved = (wantsEnd ? 'bottom-end' : 'bottom-start')
        } else {
          top = viewportMargin
        }
      }
    }

    let left = wantsEnd ? anchorBox.right - width : anchorBox.left
    if (shift && width > 0) {
      left = Math.max(viewportMargin, Math.min(left, viewportWidth - width - viewportMargin))
    }

    setState({ top, left, placement: resolved, ready: true })
  }, [anchorRef, floatingRef, placement, offset, viewportMargin, flip, shift])

  useLayoutEffect(() => {
    if (!open) {
      setState((previous) => (previous.ready ? { ...previous, ready: false } : previous))
      return
    }
    measure()
  }, [open, measure])

  return {
    style: {
      position: 'fixed',
      top: state.top,
      left: state.left,
      visibility: state.ready ? 'visible' : 'hidden',
    },
    placement: state.placement,
    ready: state.ready,
  }
}
