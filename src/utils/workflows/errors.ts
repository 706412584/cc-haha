/**
 * Describe a thrown value that may have crossed the VM boundary.
 *
 * An `Error` constructed inside the workflow sandbox belongs to that realm, so
 * `instanceof Error` is false in the host and the usual `err.message` narrowing
 * never fires — the value would render as `{}`. Reading the fields
 * defensively is the only way to keep the script author's own error text.
 */
export function describeThrown(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return String(value)

  const message = readString(value, 'message')
  const name = readString(value, 'name')
  if (message) return name && name !== 'Error' ? `${name}: ${message}` : message
  if (name) return name

  try {
    return JSON.stringify(value) ?? '[object]'
  } catch {
    return '[unprintable thrown value]'
  }
}

/** The `name` of a thrown value, used to recognise the runtime's own errors. */
export function thrownName(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  return readString(value, 'name')
}

function readString(target: object, key: string): string | undefined {
  try {
    const value = (target as Record<string, unknown>)[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}
