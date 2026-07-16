import { open, stat, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { TranscriptChunk } from './types.js'
import type { LocalIndexIoMetrics, SourceChange } from './sourceFingerprint.js'

export type { LocalIndexIoMetrics } from './sourceFingerprint.js'

export type FileStatSnapshot = Pick<Stats, 'size' | 'mtimeMs' | 'dev' | 'ino'>

export type ReadonlyFileHandle = {
  stat(): Promise<FileStatSnapshot>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export type FileReaderIo = {
  openReadonly(path: string, flags: 'r'): Promise<ReadonlyFileHandle>
  statPath(path: string): Promise<FileStatSnapshot>
}

const READ_BUFFER_BYTES = 64 * 1024

const defaultIo: FileReaderIo = {
  openReadonly(path, flags): Promise<FileHandle> {
    return open(path, flags)
  },
  statPath(path) {
    return stat(path)
  },
}

export class SourceReadRetryError extends Error {
  readonly change: Extract<SourceChange, { kind: 'retry' }>

  constructor(reason: 'changed-during-read' | 'transient-io') {
    super(`Source read must be retried: ${reason}`)
    this.name = 'SourceReadRetryError'
    this.change = { kind: 'retry', reason }
  }
}

function increment(
  metrics: LocalIndexIoMetrics | undefined,
  key: keyof LocalIndexIoMetrics,
  value = 1,
): void {
  if (metrics) metrics[key] += value
}

async function readStat(
  operation: () => Promise<FileStatSnapshot>,
  metrics?: LocalIndexIoMetrics,
): Promise<FileStatSnapshot> {
  increment(metrics, 'statCalls')
  return operation()
}

function identity(stats: FileStatSnapshot): string | null {
  if (process.platform === 'win32' || stats.ino === 0) return null
  return `${stats.dev}:${stats.ino}`
}

function sameSnapshot(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  const leftIdentity = identity(left)
  const rightIdentity = identity(right)
  return left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    (leftIdentity === null || rightIdentity === null || leftIdentity === rightIdentity)
}

function concatSegments(segments: Buffer[]): Buffer {
  if (segments.length === 1) return segments[0]!
  return Buffer.concat(segments)
}

function asRetry(error: unknown): SourceReadRetryError {
  return error instanceof SourceReadRetryError
    ? error
    : new SourceReadRetryError('transient-io')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export async function readCompleteJsonlRange(
  options: {
    path: string
    start: number
    metrics?: LocalIndexIoMetrics
  },
  io: FileReaderIo = defaultIo,
): Promise<{
  chunks: TranscriptChunk[]
  nextOffset: number
  pendingTailBytes: number
}> {
  if (!Number.isSafeInteger(options.start) || options.start < 0) {
    throw new SourceReadRetryError('changed-during-read')
  }

  let handle: ReadonlyFileHandle | undefined
  let thrown: unknown
  try {
    handle = await io.openReadonly(options.path, 'r')
    increment(options.metrics, 'filesOpened')
    const before = await readStat(() => handle!.stat(), options.metrics)
    if (options.start > before.size) {
      throw new SourceReadRetryError('changed-during-read')
    }

    const chunks: TranscriptChunk[] = []
    const pendingSegments: Buffer[] = []
    let lineByteStart = options.start
    let position = options.start
    while (position < before.size) {
      const requested = Math.min(READ_BUFFER_BYTES, before.size - position)
      const buffer = Buffer.allocUnsafe(requested)
      const { bytesRead } = await handle.read(buffer, 0, requested, position)
      increment(options.metrics, 'bytesRead', bytesRead)
      if (bytesRead === 0) {
        throw new SourceReadRetryError('changed-during-read')
      }

      const bytes = buffer.subarray(0, bytesRead)
      let segmentStart = 0
      while (segmentStart < bytes.length) {
        const newline = bytes.indexOf(0x0a, segmentStart)
        if (newline === -1) {
          pendingSegments.push(bytes.subarray(segmentStart))
          break
        }
        pendingSegments.push(bytes.subarray(segmentStart, newline + 1))
        const line = concatSegments(pendingSegments.splice(0))
        chunks.push({
          text: line.toString('utf8'),
          byteStart: lineByteStart,
          completeLine: true,
        })
        lineByteStart += line.length
        segmentStart = newline + 1
      }
      position += bytesRead
    }

    const pending = pendingSegments.length > 0
      ? concatSegments(pendingSegments)
      : Buffer.alloc(0)
    if (pending.length > 0) {
      chunks.push({
        text: pending.toString('utf8'),
        byteStart: lineByteStart,
        completeLine: false,
      })
    }

    const after = await readStat(() => handle!.stat(), options.metrics)
    let currentPath: FileStatSnapshot
    try {
      currentPath = await readStat(() => io.statPath(options.path), options.metrics)
    } catch (error) {
      if (isMissing(error)) {
        throw new SourceReadRetryError('changed-during-read')
      }
      throw error
    }
    if (!sameSnapshot(before, after) || !sameSnapshot(after, currentPath)) {
      throw new SourceReadRetryError('changed-during-read')
    }

    return {
      chunks,
      nextOffset: lineByteStart,
      pendingTailBytes: pending.length,
    }
  } catch (error) {
    thrown = error
    throw asRetry(error)
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch (error) {
        if (!thrown) throw asRetry(error)
      }
    }
  }
}
