/**
 * A minimal FIFO concurrency gate.
 *
 * `parallel()` and `pipeline()` hand the runtime as many items as the script
 * asks for; this is what keeps only N model streams alive at a time. Queued
 * work runs in submission order so a fan-out's progress view fills top-down
 * instead of at random.
 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

export function createLimiter(concurrency: number): Limiter {
  const max = Math.max(1, Math.floor(concurrency))
  const queue: Array<() => void> = []
  let active = 0

  // Release hands the slot directly to the next waiter instead of decrementing
  // and letting it re-check: a caller that arrives during the microtask gap
  // would otherwise see a free slot that is already spoken for.
  const release = (): void => {
    const next = queue.shift()
    if (next) next()
    else active--
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++
    else await new Promise<void>(resolve => queue.push(resolve))
    try {
      return await task()
    } finally {
      release()
    }
  }
}
