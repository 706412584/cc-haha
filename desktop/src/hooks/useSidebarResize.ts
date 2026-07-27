import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  useUIStore,
} from '../stores/uiStore'

// Dragging left past the minimum keeps the sidebar pinned at that minimum until
// the pointer crosses COLLAPSE_AT, which drops it to the rail; dragging back out
// past EXPAND_AT re-opens it. The gap between the two is hysteresis — with a
// single boundary the sidebar flickers open/closed on every jitter of the hand.
const COLLAPSE_AT = SIDEBAR_MIN_WIDTH - 60
const EXPAND_AT = SIDEBAR_MIN_WIDTH - 40

const RESIZE_STEP = 20
const WIDTH_VAR = '--sidebar-width'
const RESIZING_CLASS = 'sidebar-shell--resizing'

/**
 * Drag-to-resize for the sidebar, with drag-past-the-minimum to collapse.
 *
 * The live width goes onto the shell as a CSS variable written imperatively —
 * never through React state — so the re-render storm from a streaming session
 * cannot fight the drag loop. The store is written only when the drag settles,
 * and a drag that ends in a collapse leaves the remembered width alone so
 * re-opening restores the size the user had chosen.
 */
export function useSidebarResize(enabled: boolean) {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const draggingRef = useRef(false)
  // A callback ref, not a plain one: the shell is behind the startup gate, so
  // it mounts on a later render than this hook. An object ref would still read
  // null on the only pass the width effect ever runs, and the remembered width
  // would never reach the DOM.
  const [shell, setShell] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!shell) return
    // On a narrow viewport the shell is a fixed-position drawer sized off the
    // viewport, so hand the variable back rather than pinning it to a width
    // that was chosen for a desktop window.
    if (!enabled) {
      shell.style.removeProperty(WIDTH_VAR)
      return
    }
    if (draggingRef.current) return
    shell.style.setProperty(WIDTH_VAR, `${sidebarWidth}px`)
  }, [enabled, shell, sidebarWidth])

  const applyWidth = useCallback((width: number) => {
    shell?.style.setProperty(WIDTH_VAR, `${clampSidebarWidth(width)}px`)
  }, [shell])

  const stopDrag = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    document.body.classList.remove('sidebar-resizing')
    if (!shell) return
    shell.classList.remove(RESIZING_CLASS)
    if (!useUIStore.getState().sidebarOpen) return
    const width = Number.parseInt(shell.style.getPropertyValue(WIDTH_VAR), 10)
    if (Number.isFinite(width)) useUIStore.getState().setSidebarWidth(width)
  }, [shell])

  const trackPointer = useCallback((clientX: number) => {
    if (!shell) return
    // The sidebar is flush against the window's left edge, so the pointer's
    // clientX is the requested width outright — no grab-offset to drift.
    const { sidebarOpen, sidebarWidth: storedWidth, setSidebarOpen } = useUIStore.getState()

    if (sidebarOpen && clientX < COLLAPSE_AT) {
      // Restore the remembered width before collapsing: the rail ignores this
      // variable, and leaving the abandoned mid-drag value behind would shrink
      // the sidebar the next time it is opened from the toggle button.
      shell.classList.remove(RESIZING_CLASS)
      shell.style.setProperty(WIDTH_VAR, `${storedWidth}px`)
      setSidebarOpen(false)
      return
    }

    if (!sidebarOpen && clientX <= EXPAND_AT) return

    shell.classList.add(RESIZING_CLASS)
    applyWidth(clientX)
    if (!sidebarOpen) setSidebarOpen(true)
  }, [applyWidth, shell])

  // Listening on the window rather than capturing on the handle keeps the drag
  // alive when the pointer runs past the window edge, which is exactly where a
  // drag-to-collapse gesture tends to end up.
  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      if (!draggingRef.current) return
      trackPointer(event.clientX)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', stopDrag)
      window.removeEventListener('pointercancel', stopDrag)
      stopDrag()
    }
  }, [stopDrag, trackPointer])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0 || !shell) return
    event.preventDefault()
    draggingRef.current = true
    document.body.classList.add('sidebar-resizing')
    if (useUIStore.getState().sidebarOpen) shell.classList.add(RESIZING_CLASS)
  }, [enabled, shell])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!enabled) return
    const { sidebarOpen, sidebarWidth: current, setSidebarOpen, setSidebarWidth } = useUIStore.getState()

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (!sidebarOpen) return
      if (current <= SIDEBAR_MIN_WIDTH) setSidebarOpen(false)
      else setSidebarWidth(current - RESIZE_STEP)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (sidebarOpen) setSidebarWidth(current + RESIZE_STEP)
      else setSidebarOpen(true)
    }
  }, [enabled])

  const onDoubleClick = useCallback(() => {
    if (!enabled || !shell) return
    useUIStore.getState().setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
    // The layout effect is a no-op when the store value did not change, so
    // restate the variable for the drag-then-double-click-back case.
    shell.style.setProperty(WIDTH_VAR, `${SIDEBAR_DEFAULT_WIDTH}px`)
  }, [enabled, shell])

  return {
    shellRef: setShell,
    handleProps: { onPointerDown, onKeyDown, onDoubleClick },
  }
}
