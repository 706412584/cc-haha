/** Preserve invalid provider arguments without turning them into executable {}. */
export type UnparsedToolInput = {
  __unparsedToolInput: { raw: string; len: number }
}

export function createUnparsedToolInput(raw: string): UnparsedToolInput {
  return { __unparsedToolInput: { raw: raw.slice(0, 2048), len: raw.length } }
}

export function isUnparsedToolInput(input: unknown): input is UnparsedToolInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, '__unparsedToolInput')) return false
  const value = (input as UnparsedToolInput).__unparsedToolInput
  return typeof value === 'object' && value !== null
    && typeof value.raw === 'string' && typeof value.len === 'number'
}
