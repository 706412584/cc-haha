/**
 * Joins class names, dropping falsy entries.
 *
 * Deliberately not `clsx` + `tailwind-merge`: those are dependencies, and the
 * shadcn rollback (e9b53f68) established that this project carries no UI
 * libraries. The tradeoff is that `cx` does NOT resolve conflicting Tailwind
 * utilities — passing `className="px-4"` to a component whose variant already
 * sets `px-2` leaves both in the class list, and which one wins is decided by
 * their order in the generated stylesheet, not by the order here. When callers
 * keep needing to override the same utility, add a variant to the component
 * instead.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
