import { useEffect, useState } from 'react'

/**
 * `value`, delayed until it has stopped changing for `delayMs`.
 *
 * For work that is expensive to redo and pointless to do mid-gesture: a pinch or a
 * wheel zoom changes a scale dozens of times a second, and re-rasterising a page
 * for every one of them is what makes zooming a PDF stutter. The layout follows
 * the live value; the pixels follow this one.
 *
 * The first render returns `value` itself, so nothing is delayed on mount.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    if (Object.is(settled, value)) return
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs, settled])

  return settled
}
