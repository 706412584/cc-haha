import { useRef } from 'react'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { useAnchoredPosition, type AnchoredPlacement } from './useAnchoredPosition'

/**
 * jsdom reports a zero rect for every element, so each test stubs the two rects
 * the hook measures. That is the whole input to the calculation.
 */
function stubRect(element: HTMLElement, rect: Partial<DOMRect>) {
  element.getBoundingClientRect = () => ({
    top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
    ...rect,
  }) as DOMRect
}

type Result = { style: React.CSSProperties; placement: AnchoredPlacement; ready: boolean }

function renderAnchored(options: {
  anchor: Partial<DOMRect>
  floating: { width: number; height: number }
  placement?: AnchoredPlacement
  flip?: boolean
  shift?: boolean
  offset?: number
}) {
  const captured: { current: Result | null } = { current: null }

  function Harness() {
    const anchorRef = useRef<HTMLDivElement | null>(null)
    const floatingRef = useRef<HTMLDivElement | null>(null)

    captured.current = useAnchoredPosition({
      open: true,
      anchorRef,
      floatingRef,
      placement: options.placement,
      flip: options.flip,
      shift: options.shift,
      offset: options.offset,
    })

    // Stub through a ref callback: those run synchronously as the DOM is
    // attached, before the layout effect that measures. Assigning in the render
    // body would be a frame too late — the first measurement would read jsdom's
    // all-zero rect and never re-run.
    return (
      <>
        <div
          ref={(element) => {
            anchorRef.current = element
            if (element) stubRect(element, options.anchor)
          }}
          data-testid="anchor"
        />
        <div
          ref={(element) => {
            floatingRef.current = element
            if (element) stubRect(element, options.floating)
          }}
          data-testid="floating"
        />
      </>
    )
  }

  render(<Harness />)
  return captured.current!
}

describe('useAnchoredPosition', () => {
  beforeEach(() => {
    window.innerWidth = 1000
    window.innerHeight = 800
  })

  it('places the overlay below the anchor by default', () => {
    const result = renderAnchored({
      anchor: { top: 100, bottom: 130, left: 200, right: 300 },
      floating: { width: 180, height: 120 },
    })

    expect(result.style.top).toBe(136)
    expect(result.style.left).toBe(200)
    expect(result.placement).toBe('bottom-start')
  })

  it('aligns to the anchor right edge for an -end placement', () => {
    const result = renderAnchored({
      anchor: { top: 100, bottom: 130, left: 200, right: 300 },
      floating: { width: 180, height: 120 },
      placement: 'bottom-end',
    })

    expect(result.style.left).toBe(120)
  })

  it('flips above the anchor when it would overflow the bottom', () => {
    const result = renderAnchored({
      anchor: { top: 700, bottom: 740, left: 200, right: 300 },
      floating: { width: 180, height: 200 },
    })

    expect(result.placement).toBe('top-start')
    expect(result.style.top).toBe(494)
  })

  it('clamps to the bottom edge when the overlay is too tall to flip', () => {
    const result = renderAnchored({
      anchor: { top: 300, bottom: 340, left: 200, right: 300 },
      floating: { width: 180, height: 780 },
    })

    // Flipping would put it at -486, so it clamps: 800 - 780 - 8.
    expect(result.style.top).toBe(12)
  })

  it('pins to the top margin when the overlay is taller than the viewport', () => {
    const result = renderAnchored({
      anchor: { top: 300, bottom: 340, left: 200, right: 300 },
      floating: { width: 180, height: 900 },
    })

    // Nothing fits; showing the top of the overlay beats showing its middle.
    expect(result.style.top).toBe(8)
  })

  it('shifts back inside the viewport on the right edge', () => {
    const result = renderAnchored({
      anchor: { top: 100, bottom: 130, left: 950, right: 990 },
      floating: { width: 300, height: 100 },
    })

    expect(result.style.left).toBe(692)
  })

  it('shifts back inside the viewport on the left edge', () => {
    const result = renderAnchored({
      anchor: { top: 100, bottom: 130, left: -40, right: 20 },
      floating: { width: 300, height: 100 },
    })

    expect(result.style.left).toBe(8)
  })

  it('can be told not to flip', () => {
    const result = renderAnchored({
      anchor: { top: 700, bottom: 740, left: 200, right: 300 },
      floating: { width: 180, height: 200 },
      flip: false,
    })

    expect(result.placement).toBe('bottom-start')
    expect(result.style.top).toBe(746)
  })

  it('can be told not to shift', () => {
    const result = renderAnchored({
      anchor: { top: 100, bottom: 130, left: 950, right: 990 },
      floating: { width: 300, height: 100 },
      shift: false,
    })

    expect(result.style.left).toBe(950)
  })

  it('honors a custom offset', () => {
    const result = renderAnchored({
      anchor: { top: 100, bottom: 130, left: 200, right: 300 },
      floating: { width: 180, height: 100 },
      offset: 20,
    })

    expect(result.style.top).toBe(150)
  })

  it('hides the overlay until it has been measured', () => {
    // Rendering at the initial guess and then correcting is visible as a jump;
    // the caller relies on `visibility` to avoid painting the wrong spot.
    function Harness() {
      const anchorRef = useRef<HTMLDivElement | null>(null)
      const floatingRef = useRef<HTMLDivElement | null>(null)
      const result = useAnchoredPosition({ open: true, anchorRef, floatingRef })
      return <div data-visibility={String(result.style.visibility)} data-ready={String(result.ready)} />
    }

    const { container } = render(<Harness />)
    const probe = container.firstElementChild!
    expect(probe.getAttribute('data-ready')).toBe('false')
    expect(probe.getAttribute('data-visibility')).toBe('hidden')
  })
})
