import type { FileHandle } from 'node:fs/promises'
import { resolveSessionEffortLevel } from './transcriptReducer.js'
import type { IndexedSessionRow } from './sessionIndex.js'

export type RuntimeOverlay = Pick<
  IndexedSessionRow,
  'runtimeProviderId' | 'runtimeModelId' | 'effortLevel' | 'thinkingEnabled' | 'openAIFastMode'
>

const CHUNK_BYTES = 1024 * 1024
// session-meta records are small; anything larger is a message body and is skipped unbuffered.
const MAX_META_LINE_BYTES = 64 * 1024
const MARKER = Buffer.from('"session-meta"')

function parseSessionMeta(line: Buffer | null): Record<string, unknown> | null {
  if (!line || line.length === 0 || line.indexOf(MARKER) < 0) return null
  try {
    const value: unknown = JSON.parse(line.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'session-meta'
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function isCompleteRuntimeSelection(record: Record<string, unknown>): boolean {
  return (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') &&
    typeof record.runtimeModelId === 'string' && record.runtimeModelId.length > 0
}

/** Applies one session-meta record with the transcript reducer's semantics. */
export function foldRuntimeOverlay(base: RuntimeOverlay, record: Record<string, unknown>): RuntimeOverlay {
  const next: RuntimeOverlay = { ...base }
  if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
    next.runtimeProviderId = record.runtimeProviderId as string | null
  }
  if (typeof record.runtimeModelId === 'string') next.runtimeModelId = record.runtimeModelId
  next.effortLevel = resolveSessionEffortLevel(record, next.effortLevel)
  if (typeof record.thinkingEnabled === 'boolean') next.thinkingEnabled = record.thinkingEnabled
  if (typeof record.openAIFastMode === 'boolean') next.openAIFastMode = record.openAIFastMode
  return next
}

/**
 * Folds the session-meta records in `[floor, size)` onto `base`, reading
 * backwards from the end and stopping at the newest complete runtime selection,
 * which replaces everything before it. `floor` must be a line start. An
 * unterminated last line is left for a later read; `end` is where it begins.
 */
export async function foldTrailingRuntime(
  handle: FileHandle,
  floor: number,
  size: number,
  base: RuntimeOverlay,
): Promise<{ overlay: RuntimeOverlay; end: number }> {
  const newestFirst: Record<string, unknown>[] = []
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  // Bytes of the line currently open to the left; null once it is too large to be metadata.
  let tail: Buffer | null = Buffer.alloc(0)
  let end: number | null = null
  let done = false
  const take = (line: Buffer | null): void => {
    if (end === null) return
    const meta = parseSessionMeta(line)
    if (!meta) return
    newestFirst.push(meta)
    if (isCompleteRuntimeSelection(meta)) done = true
  }
  const join = (head: Buffer, rest: Buffer | null): Buffer | null =>
    rest === null || head.length + rest.length > MAX_META_LINE_BYTES
      ? null
      : Buffer.concat([head, rest])

  for (let position = size; position > floor && !done;) {
    const start = Math.max(floor, position - CHUNK_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, position - start, start)
    if (bytesRead !== position - start) throw new Error('Transcript changed during runtime read')
    const view = buffer.subarray(0, bytesRead)
    let cursor = view.length
    while (!done) {
      const newline = cursor > 0 ? view.lastIndexOf(10, cursor - 1) : -1
      if (newline < 0) {
        tail = join(view.subarray(0, cursor), tail)
        break
      }
      if (end === null) end = start + newline + 1
      else take(join(view.subarray(newline + 1, cursor), tail))
      tail = Buffer.alloc(0)
      cursor = newline
    }
    position = start
  }
  // The line that begins at `floor`.
  if (!done) take(tail)

  let overlay = base
  for (let index = newestFirst.length - 1; index >= 0; index -= 1) {
    overlay = foldRuntimeOverlay(overlay, newestFirst[index]!)
  }
  return { overlay, end: end ?? floor }
}
