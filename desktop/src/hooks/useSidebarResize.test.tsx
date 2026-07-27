import { useState } from 'react'
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSidebarResize } from './useSidebarResize'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useUIStore,
} from '../stores/uiStore'

/**
 * `mounted` models AppShell's startup gate: the shell is absent on the first
 * render and appears only once the workspace bootstrap resolves.
 */
function Harness({ enabled = true, mounted = true }: { enabled?: boolean; mounted?: boolean }) {
  const { shellRef, handleProps } = useSidebarResize(enabled)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)

  if (!mounted) return <div>starting…</div>

  return (
    <div ref={shellRef} data-testid="shell" data-state={sidebarOpen ? 'open' : 'closed'}>
      <div data-testid="handle" tabIndex={0} {...handleProps} />
    </div>
  )
}

/** Flips `mounted` from false to true on demand, like the bootstrap finishing. */
function GatedHarness() {
  const [mounted, setMounted] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setMounted(true)}>boot</button>
      <Harness mounted={mounted} />
    </>
  )
}

function shellWidth(): number {
  return Number.parseInt(screen.getByTestId('shell').style.getPropertyValue('--sidebar-width'), 10)
}

/**
 * jsdom has no PointerEvent, so `button` and `clientX` never survive a plain
 * fireEvent.pointerDown init — they have to be pinned onto the event by hand.
 */
function pressHandle(button = 0) {
  const event = createEvent.pointerDown(screen.getByTestId('handle'))
  Object.defineProperty(event, 'button', { value: button })
  fireEvent(screen.getByTestId('handle'), event)
}

function movePointerTo(clientX: number) {
  const event = createEvent.pointerMove(window)
  Object.defineProperty(event, 'clientX', { value: clientX })
  fireEvent(window, event)
}

function releasePointer() {
  fireEvent(window, createEvent.pointerUp(window))
}

function drag(...points: number[]) {
  pressHandle()
  for (const point of points) movePointerTo(point)
  releasePointer()
}

describe('useSidebarResize', () => {
  beforeEach(() => {
    localStorage.clear()
    useUIStore.setState({ sidebarOpen: true, sidebarWidth: SIDEBAR_DEFAULT_WIDTH })
  })

  it('publishes the stored width onto the shell', () => {
    render(<Harness />)
    expect(shellWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('publishes the stored width to a shell that mounts after the first render', async () => {
    useUIStore.setState({ sidebarWidth: 380 })
    render(<GatedHarness />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'boot' }))
    })

    // Regression: the shell lives behind AppShell's startup gate, so a plain
    // object ref reads null on the pass that publishes the width and the
    // remembered size silently falls back to the stylesheet default.
    expect(shellWidth()).toBe(380)
  })

  it('tracks the pointer while dragging and commits the width on release', () => {
    render(<Harness />)
    drag(360)

    expect(shellWidth()).toBe(360)
    expect(useUIStore.getState().sidebarWidth).toBe(360)
    expect(localStorage.getItem('cc-haha-sidebar-width')).toBe('360')
  })

  it('clamps the width to the safe range instead of following the pointer past it', () => {
    render(<Harness />)

    drag(SIDEBAR_MAX_WIDTH + 200)
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH)

    // Just inside the collapse threshold: pinned at the minimum, still open.
    drag(SIDEBAR_MIN_WIDTH - 30)
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH)
    expect(useUIStore.getState().sidebarOpen).toBe(true)
  })

  it('collapses once the pointer crosses the threshold past the minimum', () => {
    render(<Harness />)
    drag(120)

    expect(useUIStore.getState().sidebarOpen).toBe(false)
  })

  it('keeps the remembered width when a drag ends in a collapse', () => {
    useUIStore.setState({ sidebarWidth: 420 })
    render(<Harness />)

    drag(300, 120)

    expect(useUIStore.getState().sidebarOpen).toBe(false)
    // Both the store and the live variable still describe the chosen width, so
    // re-opening from the toggle button restores it rather than a mid-drag one.
    expect(useUIStore.getState().sidebarWidth).toBe(420)
    expect(shellWidth()).toBe(420)
  })

  it('re-expands when the pointer comes back out past the expand threshold', () => {
    render(<Harness />)

    pressHandle()
    movePointerTo(120)
    expect(useUIStore.getState().sidebarOpen).toBe(false)

    // Inside the hysteresis gap the sidebar must stay collapsed.
    movePointerTo(SIDEBAR_MIN_WIDTH - 50)
    expect(useUIStore.getState().sidebarOpen).toBe(false)

    movePointerTo(320)
    releasePointer()

    expect(useUIStore.getState().sidebarOpen).toBe(true)
    expect(useUIStore.getState().sidebarWidth).toBe(320)
  })

  it('ignores pointer movement that is not part of a drag', () => {
    render(<Harness />)
    movePointerTo(400)

    expect(shellWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('restores the default width on a double click', () => {
    useUIStore.setState({ sidebarWidth: 440 })
    render(<Harness />)

    fireEvent.doubleClick(screen.getByTestId('handle'))

    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(shellWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('ignores non-primary buttons', () => {
    render(<Harness />)

    pressHandle(2)
    movePointerTo(400)

    expect(shellWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('leaves the width to the stylesheet and does not drag when disabled', () => {
    render(<Harness enabled={false} />)

    expect(screen.getByTestId('shell').style.getPropertyValue('--sidebar-width')).toBe('')

    pressHandle()
    movePointerTo(400)

    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('clears the drag styling on the body when the pointer is cancelled', () => {
    render(<Harness />)

    pressHandle()
    expect(document.body).toHaveClass('sidebar-resizing')

    fireEvent(window, createEvent.pointerCancel(window))
    expect(document.body).not.toHaveClass('sidebar-resizing')
  })

  describe('keyboard', () => {
    it('steps the width with the arrow keys', () => {
      render(<Harness />)
      const handle = screen.getByTestId('handle')

      fireEvent.keyDown(handle, { key: 'ArrowRight' })
      expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH + 20)

      fireEvent.keyDown(handle, { key: 'ArrowLeft' })
      expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH)
    })

    it('collapses at the minimum and re-expands from the rail', () => {
      useUIStore.setState({ sidebarWidth: SIDEBAR_MIN_WIDTH })
      render(<Harness />)
      const handle = screen.getByTestId('handle')

      fireEvent.keyDown(handle, { key: 'ArrowLeft' })
      expect(useUIStore.getState().sidebarOpen).toBe(false)
      expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH)

      fireEvent.keyDown(handle, { key: 'ArrowRight' })
      expect(useUIStore.getState().sidebarOpen).toBe(true)
    })
  })
})
