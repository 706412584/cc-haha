import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedValue } from './useDebouncedValue'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDebouncedValue', () => {
  it('returns the first value at once, so nothing is delayed on mount', () => {
    const { result } = renderHook(() => useDebouncedValue(1.5, 120))

    expect(result.current).toBe(1.5)
  })

  it('holds the old value until the new one has stopped changing for the delay', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 120), {
      initialProps: { value: 1 },
    })

    rerender({ value: 2 })
    expect(result.current).toBe(1)

    act(() => { vi.advanceTimersByTime(119) })
    expect(result.current).toBe(1)

    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toBe(2)
  })

  it('restarts the wait on every change, so a gesture in progress never commits', () => {
    // A wheel zoom changes the value many times a second. Committing mid-gesture
    // is the re-rasterising the delay exists to avoid.
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 120), {
      initialProps: { value: 1 },
    })

    for (const value of [1.1, 1.25, 1.5, 1.75]) {
      rerender({ value })
      act(() => { vi.advanceTimersByTime(100) })
    }
    expect(result.current).toBe(1)

    act(() => { vi.advanceTimersByTime(120) })
    expect(result.current).toBe(1.75)
  })

  it('skips values that came and went inside the delay', () => {
    const seen: number[] = []
    const { rerender } = renderHook(({ value }) => {
      const settled = useDebouncedValue(value, 120)
      seen.push(settled)
      return settled
    }, { initialProps: { value: 1 } })

    rerender({ value: 2 })
    act(() => { vi.advanceTimersByTime(50) })
    rerender({ value: 3 })
    act(() => { vi.advanceTimersByTime(120) })

    expect(new Set(seen)).toEqual(new Set([1, 3]))
  })

  it('does nothing when the value comes back to what was already settled', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 120), {
      initialProps: { value: 1 },
    })

    rerender({ value: 2 })
    rerender({ value: 1 })
    act(() => { vi.advanceTimersByTime(500) })

    expect(result.current).toBe(1)
  })

  it('leaves no timer running after unmount', () => {
    const { rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value, 120), {
      initialProps: { value: 1 },
    })
    rerender({ value: 2 })

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })
})
