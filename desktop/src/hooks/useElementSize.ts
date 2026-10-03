import { useCallback, useEffect, useRef, useState } from 'react'

export type ElementSize = { width: number; height: number }

/**
 * Tracks an element's rendered content-box size.
 *
 * The two-dimensional sibling of {@link useElementWidth}, for a viewer that fits
 * content to its container. It shares that hook's contract: `null` — not a zero
 * size — until a real measurement lands, so a caller can tell "not measured yet"
 * from "measured as empty" and keep its CSS-driven fallback instead of flashing a
 * layout the first paint would replace. jsdom has no ResizeObserver and lays
 * nothing out, so under test the size stays `null`.
 *
 * Measure a node whose own size does not depend on the decision it feeds: a
 * container that the resulting scale resizes turns the observer into a feedback
 * loop.
 */
export function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, ElementSize | null] {
  const [size, setSize] = useState<ElementSize | null>(null)
  const nodeRef = useRef<T | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  const observeNode = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return

    const measure = () => {
      const width = node.clientWidth
      const height = node.clientHeight
      setSize((current) => {
        if (width <= 0 || height <= 0) return null
        return current?.width === width && current.height === height ? current : { width, height }
      })
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    observerRef.current = observer
  }, [])

  const measuredRef = useCallback((node: T | null) => {
    nodeRef.current = node
    observeNode(node)
  }, [observeNode])

  useEffect(() => {
    // StrictMode replays effect setup after cleanup without reattaching the
    // callback ref. Reconnect to the retained node so later resizes still arrive.
    if (!observerRef.current) observeNode(nodeRef.current)
    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [observeNode])

  return [measuredRef, size]
}
