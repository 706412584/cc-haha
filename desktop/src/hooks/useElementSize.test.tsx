import { act, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { useElementSize } from './useElementSize'

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

function Probe() {
  const [measuredRef, size] = useElementSize<HTMLDivElement>()
  return (
    <div ref={measuredRef}>
      <span data-testid="size">{size === null ? 'unmeasured' : `${size.width}x${size.height}`}</span>
    </div>
  )
}

describe('useElementSize', () => {
  const observers = new Set<() => void>()
  let box = { width: 0, height: 0 }

  function stubLayout(width: number, height: number) {
    box = { width, height }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => box.width })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => box.height })
  }

  function stubResizeObserver() {
    class StubResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe() { observers.add(this.callback) }
      unobserve() { observers.delete(this.callback) }
      disconnect() { observers.delete(this.callback) }
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
  }

  function resizeTo(width: number, height: number) {
    box = { width, height }
    act(() => {
      observers.forEach((notify) => notify())
    })
  }

  afterEach(() => {
    observers.clear()
    box = { width: 0, height: 0 }
    vi.unstubAllGlobals()
    for (const [property, original] of [
      ['clientWidth', originalClientWidth],
      ['clientHeight', originalClientHeight],
    ] as const) {
      if (original) Object.defineProperty(HTMLElement.prototype, property, original)
      else Reflect.deleteProperty(HTMLElement.prototype, property)
    }
  })

  it('measures the node as soon as it mounts', () => {
    stubLayout(640, 480)
    stubResizeObserver()

    render(<Probe />)

    expect(screen.getByTestId('size')).toHaveTextContent('640x480')
  })

  it('reports null rather than a zero size before layout, so callers keep their fallback', () => {
    // jsdom lays nothing out: everything measures 0.
    render(<Probe />)

    expect(screen.getByTestId('size')).toHaveTextContent('unmeasured')
  })

  it('follows the element as it resizes', () => {
    stubLayout(640, 480)
    stubResizeObserver()
    render(<Probe />)

    resizeTo(320, 200)

    expect(screen.getByTestId('size')).toHaveTextContent('320x200')
  })

  it('goes back to null when the element collapses to nothing', () => {
    stubLayout(640, 480)
    stubResizeObserver()
    render(<Probe />)

    resizeTo(0, 0)

    expect(screen.getByTestId('size')).toHaveTextContent('unmeasured')
  })

  it('keeps observing under StrictMode, which replays effects without reattaching the ref', () => {
    stubLayout(640, 480)
    stubResizeObserver()
    render(<StrictMode><Probe /></StrictMode>)

    resizeTo(100, 50)

    expect(screen.getByTestId('size')).toHaveTextContent('100x50')
  })

  it('stops observing on unmount', () => {
    stubLayout(640, 480)
    stubResizeObserver()
    const { unmount } = render(<Probe />)
    expect(observers.size).toBe(1)

    unmount()

    expect(observers.size).toBe(0)
  })
})
