import type { Token } from 'stream-json/parser.js'

const MAX_DEPTH = 128
const MAX_KEY_CHARS = 256

export type BoundedJsonProjectionOptions = {
  /** Whether the value at this path is kept. The root path is `[]`. */
  selected(path: readonly string[]): boolean
  /** Whether an overlong string at this path is truncated instead of rejected. */
  preview(path: readonly string[]): boolean
  /** Byte budget for every retained key and scalar. */
  metadataBytes: number
  /** Scalar length kept for a preview path. */
  previewChars: number
  limitError(): Error
}

export type BoundedJsonProjection = {
  token(token: Token): void
  /** The assembled root value, or undefined when nothing was projected. */
  root(): unknown
  /** Whether the slot of a retained container was cut to its preview length. */
  wasTruncated(container: object, slot: string): boolean
}

type Frame = {
  path: string[]
  value?: Record<string, unknown> | unknown[]
  key: string
  index: number
}

/**
 * Assemble only the small structural envelope of one JSON value from
 * stream-json tokens; the parser still validates every byte. Unselected
 * subtrees are skipped, preview strings are truncated, and everything else
 * that is retained is charged against a fixed budget.
 */
export function createBoundedJsonProjection(options: BoundedJsonProjectionOptions): BoundedJsonProjection {
  const frames: Frame[] = []
  let root: unknown
  let bytes = 0
  let scalar = ''
  let scalarPath: string[] = []
  let scalarMode: 'key' | 'string' | 'number' | undefined
  let scalarOverflow = false
  const truncatedSlots = new WeakMap<object, Set<string>>()
  const charge = (size: number) => {
    bytes += size
    if (bytes > options.metadataBytes) throw options.limitError()
  }
  const nextPath = (): string[] => {
    const parent = frames.at(-1)
    return parent ? [...parent.path, Array.isArray(parent.value) ? String(parent.index) : parent.key] : []
  }
  const selected = (path: string[]): boolean =>
    !path.includes('\0unselected') && options.selected(path)
  const attach = (value: unknown, path: string[], truncated = false) => {
    const parent = frames.at(-1)
    if (selected(path)) {
      if (!parent) root = value
      else if (parent.value) {
        charge(16 + (Array.isArray(parent.value) ? 0 : Buffer.byteLength(parent.key)))
        const slot = Array.isArray(parent.value) ? String(parent.value.length) : parent.key
        const slots = truncatedSlots.get(parent.value) ?? new Set<string>()
        if (truncated) slots.add(slot)
        else slots.delete(slot)
        truncatedSlots.set(parent.value, slots)
        if (Array.isArray(parent.value)) parent.value.push(value)
        else Object.defineProperty(parent.value, parent.key, { value, writable: true, configurable: true, enumerable: true })
      }
    }
    if (parent) parent.index++
  }
  const token = (token: Token) => {
    switch (token.name) {
      case 'startObject':
      case 'startArray': {
        if (frames.length >= MAX_DEPTH) throw options.limitError()
        const path = nextPath()
        const value = selected(path) ? token.name === 'startArray' ? [] : Object.create(null) : undefined
        attach(value, path)
        frames.push({ path, value, key: '', index: 0 })
        break
      }
      case 'endObject':
      case 'endArray':
        frames.pop()
        break
      case 'startKey':
        scalarMode = 'key'
        scalar = ''
        scalarOverflow = false
        break
      case 'startString':
      case 'startNumber':
        scalarMode = token.name === 'startString' ? 'string' : 'number'
        scalarPath = nextPath()
        scalar = ''
        scalarOverflow = false
        break
      case 'stringChunk':
      case 'numberChunk': {
        if (scalarMode !== 'key' && !selected(scalarPath)) break
        const isPreview = scalarMode !== 'key' && options.preview(scalarPath)
        const bound = scalarMode === 'key' ? MAX_KEY_CHARS : isPreview ? options.previewChars : options.metadataBytes
        const available = bound - scalar.length
        if (token.value.length > available) {
          scalarOverflow = true
          if (scalarMode !== 'key' && !isPreview) throw options.limitError()
        }
        scalar += token.value.slice(0, Math.max(0, available))
        break
      }
      case 'endKey': {
        // A retained metadata map must never silently rename a key. Unknown
        // root/body fields can be discarded without affecting launch state.
        const parent = frames.at(-1)!
        if (scalarOverflow && parent.value && parent.path.length && parent.path[0] !== 'message') throw options.limitError()
        frames.at(-1)!.key = scalarOverflow ? '\0unselected' : scalar
        scalarMode = undefined
        break
      }
      case 'endString':
      case 'endNumber': {
        if (selected(scalarPath)) {
          charge(Buffer.byteLength(scalar))
        }
        attach(token.name === 'endNumber' ? Number(scalar) : scalar, scalarPath, scalarOverflow && scalarPath[0] === 'message')
        scalarMode = undefined
        break
      }
      case 'trueValue':
      case 'falseValue':
      case 'nullValue':
        attach(token.value, nextPath())
        break
    }
  }
  return {
    token,
    root: () => root,
    wasTruncated: (container, slot) => truncatedSlots.get(container)?.has(slot) ?? false,
  }
}
