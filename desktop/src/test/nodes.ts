import { expect } from 'vitest'

/**
 * These are the very same nodes, in this order.
 *
 * `toEqual` will not do for DOM nodes: it compares them with `isEqualNode`, so two
 * elements with the same markup are "equal" — and a test that asks whether the old
 * canvas or frame is still on screen would pass with its replacement standing there.
 */
export function expectSameNodes(actual: readonly Node[], expected: readonly Node[]): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((node, index) => expect(actual[index]).toBe(node))
}
