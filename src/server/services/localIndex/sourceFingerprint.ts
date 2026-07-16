import { createHash } from 'node:crypto'
import { open, stat, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'

export type SourceChange =
  | { kind: 'unchanged' }
  | { kind: 'append'; readFrom: number }
  | { kind: 'rebuild'; reason: 'replace' | 'truncate' | 'rewrite' | 'parser-version' }
  | { kind: 'deleted' }
  | { kind: 'retry'; reason: 'changed-during-read' | 'transient-io' }

export type LocalIndexIoMetrics = {
  filesOpened: number
  bytesRead: number
  statCalls: number
}

export type FileIdentityResolver = (
  stats: Pick<Stats, 'dev' | 'ino'>,
) => string | null

type StatsLike = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'dev' | 'ino'>

export type SourceFingerprintFileHandle = {
  stat(): Promise<StatsLike>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export type SourceFingerprintIo = {
  openReadonly(path: string, flags: 'r'): Promise<SourceFingerprintFileHandle>
  statPath(path: string): Promise<StatsLike>
}

export type SourceFingerprint = {
  size: number
  mtimeMs: number
  ctimeMs: number
  fileIdentity: string | null
  firstWindowHash: string
  lastWindowHash: string
  boundaryWindowHash: string
  indexedBytes: number
  parserVersion: number
}

type FingerprintOptions = {
  path: string
  indexedBytes: number
  parserVersion: number
  metrics?: LocalIndexIoMetrics
  identityResolver?: FileIdentityResolver
  io?: SourceFingerprintIo
}

type DetectSourceChangeOptions = {
  path: string
  previous: SourceFingerprint
  parserVersion: number
  metrics?: LocalIndexIoMetrics
  identityResolver?: FileIdentityResolver
  io?: SourceFingerprintIo
}

type VerifySourceFingerprintOptions = {
  path: string
  expected: SourceFingerprint
  metrics?: LocalIndexIoMetrics
  identityResolver?: FileIdentityResolver
  io?: SourceFingerprintIo
}

const FINGERPRINT_WINDOW_BYTES = 64 * 1024
const STORED_FINGERPRINT_PREFIX = 'cc-haha-source-fingerprint:v2:'

const defaultIo: SourceFingerprintIo = {
  openReadonly(path, flags): Promise<FileHandle> {
    return open(path, flags)
  },
  statPath(path) {
    return stat(path)
  },
}

class SourceChangedDuringFingerprintError extends Error {}
class SourceMissingBeforeFingerprintError extends Error {}

function defaultFileIdentity(stats: Pick<Stats, 'dev' | 'ino'>): string | null {
  if (process.platform === 'win32' || stats.ino === 0) return null
  return `${stats.dev}:${stats.ino}`
}

function increment(
  metrics: LocalIndexIoMetrics | undefined,
  key: keyof LocalIndexIoMetrics,
  value = 1,
): void {
  if (metrics) metrics[key] += value
}

async function handleStat(
  handle: SourceFingerprintFileHandle,
  metrics?: LocalIndexIoMetrics,
): Promise<StatsLike> {
  increment(metrics, 'statCalls')
  return handle.stat()
}

async function pathStat(
  path: string,
  io: SourceFingerprintIo,
  metrics?: LocalIndexIoMetrics,
): Promise<StatsLike> {
  increment(metrics, 'statCalls')
  return io.statPath(path)
}

function sameIdentity(
  left: StatsLike,
  right: StatsLike,
  identityResolver: FileIdentityResolver,
): boolean {
  const leftIdentity = identityResolver(left)
  const rightIdentity = identityResolver(right)
  return leftIdentity === null || rightIdentity === null || leftIdentity === rightIdentity
}

function sameSnapshot(
  left: StatsLike,
  right: StatsLike,
  identityResolver: FileIdentityResolver,
): boolean {
  return left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    sameIdentity(left, right, identityResolver)
}

function windowRange(end: number): { start: number; length: number } {
  const length = Math.min(FINGERPRINT_WINDOW_BYTES, end)
  return { start: end - length, length }
}

async function readExactly(
  handle: SourceFingerprintFileHandle,
  start: number,
  length: number,
  metrics?: LocalIndexIoMetrics,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      start + offset,
    )
    increment(metrics, 'bytesRead', bytesRead)
    if (bytesRead === 0) {
      throw new SourceChangedDuringFingerprintError()
    }
    offset += bytesRead
  }
  return buffer
}

async function hashWindow(
  handle: SourceFingerprintFileHandle,
  end: number,
  metrics?: LocalIndexIoMetrics,
): Promise<string> {
  const { start, length } = windowRange(end)
  const bytes = await readExactly(handle, start, length, metrics)
  return createHash('sha256').update(bytes).digest('hex')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function openReadonly(
  path: string,
  io: SourceFingerprintIo,
  metrics?: LocalIndexIoMetrics,
): Promise<SourceFingerprintFileHandle> {
  let handle: SourceFingerprintFileHandle
  try {
    handle = await io.openReadonly(path, 'r')
  } catch (error) {
    if (isMissing(error)) throw new SourceMissingBeforeFingerprintError()
    throw error
  }
  increment(metrics, 'filesOpened')
  return handle
}

async function assertStableHandle(
  path: string,
  handle: SourceFingerprintFileHandle,
  before: StatsLike,
  io: SourceFingerprintIo,
  metrics: LocalIndexIoMetrics | undefined,
  identityResolver: FileIdentityResolver,
): Promise<void> {
  const after = await handleStat(handle, metrics)
  let currentPath: StatsLike
  try {
    currentPath = await pathStat(path, io, metrics)
  } catch (error) {
    if (isMissing(error)) throw new SourceChangedDuringFingerprintError()
    throw error
  }
  if (
    !sameSnapshot(before, after, identityResolver) ||
    !sameSnapshot(after, currentPath, identityResolver)
  ) {
    throw new SourceChangedDuringFingerprintError()
  }
}

export async function captureSourceFingerprint(
  options: FingerprintOptions,
): Promise<SourceFingerprint> {
  if (
    !Number.isSafeInteger(options.indexedBytes) ||
    options.indexedBytes < 0
  ) {
    throw new Error('indexedBytes must be a non-negative safe integer')
  }

  const identityResolver = options.identityResolver ?? defaultFileIdentity
  const io = options.io ?? defaultIo
  const handle = await openReadonly(options.path, io, options.metrics)
  try {
    const before = await handleStat(handle, options.metrics)
    if (options.indexedBytes > before.size) {
      throw new Error('indexedBytes exceeds source size')
    }
    const firstWindowHash = await hashWindow(
      handle,
      Math.min(FINGERPRINT_WINDOW_BYTES, before.size),
      options.metrics,
    )
    const lastWindowHash = await hashWindow(handle, before.size, options.metrics)
    const boundaryWindowHash = await hashWindow(
      handle,
      options.indexedBytes,
      options.metrics,
    )
    await assertStableHandle(
      options.path,
      handle,
      before,
      io,
      options.metrics,
      identityResolver,
    )
    return {
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      fileIdentity: identityResolver(before),
      firstWindowHash,
      lastWindowHash,
      boundaryWindowHash,
      indexedBytes: options.indexedBytes,
      parserVersion: options.parserVersion,
    }
  } catch (error) {
    if (isMissing(error)) throw new SourceChangedDuringFingerprintError()
    throw error
  } finally {
    await handle.close()
  }
}

async function detectPresentSourceChange(
  options: DetectSourceChangeOptions,
): Promise<SourceChange> {
  const identityResolver = options.identityResolver ?? defaultFileIdentity
  const io = options.io ?? defaultIo
  const handle = await openReadonly(options.path, io, options.metrics)
  try {
    const current = await handleStat(handle, options.metrics)
    const currentIdentity = identityResolver(current)
    if (
      options.previous.fileIdentity !== null &&
      currentIdentity !== null &&
      options.previous.fileIdentity !== currentIdentity
    ) {
      return { kind: 'rebuild', reason: 'replace' }
    }
    if (current.size < options.previous.size) {
      return { kind: 'rebuild', reason: 'truncate' }
    }

    const firstWindowHash = await hashWindow(
      handle,
      Math.min(FINGERPRINT_WINDOW_BYTES, options.previous.size),
      options.metrics,
    )
    const previousTailHash = await hashWindow(
      handle,
      options.previous.size,
      options.metrics,
    )
    const previousBoundaryHash = await hashWindow(
      handle,
      options.previous.indexedBytes,
      options.metrics,
    )
    await assertStableHandle(
      options.path,
      handle,
      current,
      io,
      options.metrics,
      identityResolver,
    )

    if (
      firstWindowHash !== options.previous.firstWindowHash ||
      previousTailHash !== options.previous.lastWindowHash ||
      previousBoundaryHash !== options.previous.boundaryWindowHash
    ) {
      return { kind: 'rebuild', reason: 'rewrite' }
    }
    if (current.size === options.previous.size) {
      if (
        current.mtimeMs !== options.previous.mtimeMs ||
        current.ctimeMs !== options.previous.ctimeMs
      ) {
        return { kind: 'rebuild', reason: 'rewrite' }
      }
      return { kind: 'unchanged' }
    }
    return { kind: 'append', readFrom: options.previous.indexedBytes }
  } catch (error) {
    if (isMissing(error)) throw new SourceChangedDuringFingerprintError()
    throw error
  } finally {
    await handle.close()
  }
}

export async function detectSourceChange(
  options: DetectSourceChangeOptions,
): Promise<SourceChange> {
  if (options.parserVersion !== options.previous.parserVersion) {
    return { kind: 'rebuild', reason: 'parser-version' }
  }
  try {
    return await detectPresentSourceChange(options)
  } catch (error) {
    if (error instanceof SourceMissingBeforeFingerprintError) {
      return { kind: 'deleted' }
    }
    if (error instanceof SourceChangedDuringFingerprintError) {
      return { kind: 'retry', reason: 'changed-during-read' }
    }
    return { kind: 'retry', reason: 'transient-io' }
  }
}

function fingerprintsMatch(
  expected: SourceFingerprint,
  actual: SourceFingerprint,
): boolean {
  return expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs &&
    (
      expected.fileIdentity === null ||
      actual.fileIdentity === null ||
      expected.fileIdentity === actual.fileIdentity
    ) &&
    expected.firstWindowHash === actual.firstWindowHash &&
    expected.lastWindowHash === actual.lastWindowHash &&
    expected.boundaryWindowHash === actual.boundaryWindowHash &&
    expected.indexedBytes === actual.indexedBytes &&
    expected.parserVersion === actual.parserVersion
}

export function serializeSourceFingerprint(fingerprint: SourceFingerprint): string {
  const fields = [
    fingerprint.size,
    fingerprint.mtimeMs,
    fingerprint.ctimeMs,
    fingerprint.fileIdentity,
    fingerprint.firstWindowHash,
    fingerprint.lastWindowHash,
    fingerprint.boundaryWindowHash,
    fingerprint.indexedBytes,
    fingerprint.parserVersion,
  ]
  return `${STORED_FINGERPRINT_PREFIX}${Buffer.from(JSON.stringify(fields)).toString('base64url')}`
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export function deserializeSourceFingerprint(value: string): SourceFingerprint | null {
  if (!value.startsWith(STORED_FINGERPRINT_PREFIX)) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(STORED_FINGERPRINT_PREFIX.length), 'base64url').toString('utf8'),
    ) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 9) return null
    const [
      size,
      mtimeMs,
      ctimeMs,
      fileIdentity,
      firstWindowHash,
      lastWindowHash,
      boundaryWindowHash,
      indexedBytes,
      parserVersion,
    ] = parsed
    if (
      !Number.isSafeInteger(size) || size < 0 ||
      typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) ||
      typeof ctimeMs !== 'number' || !Number.isFinite(ctimeMs) ||
      (fileIdentity !== null && typeof fileIdentity !== 'string') ||
      !isHash(firstWindowHash) ||
      !isHash(lastWindowHash) ||
      !isHash(boundaryWindowHash) ||
      !Number.isSafeInteger(indexedBytes) || indexedBytes < 0 || indexedBytes > size ||
      !Number.isSafeInteger(parserVersion) || parserVersion < 0
    ) {
      return null
    }
    return {
      size,
      mtimeMs,
      ctimeMs,
      fileIdentity,
      firstWindowHash,
      lastWindowHash,
      boundaryWindowHash,
      indexedBytes,
      parserVersion,
    }
  } catch {
    return null
  }
}

export async function verifySourceFingerprint(
  options: VerifySourceFingerprintOptions,
): Promise<SourceChange> {
  try {
    const actual = await captureSourceFingerprint({
      path: options.path,
      indexedBytes: options.expected.indexedBytes,
      parserVersion: options.expected.parserVersion,
      metrics: options.metrics,
      identityResolver: options.identityResolver,
      io: options.io,
    })
    return fingerprintsMatch(options.expected, actual)
      ? { kind: 'unchanged' }
      : { kind: 'retry', reason: 'changed-during-read' }
  } catch (error) {
    return error instanceof SourceMissingBeforeFingerprintError ||
      error instanceof SourceChangedDuringFingerprintError
      ? { kind: 'retry', reason: 'changed-during-read' }
      : { kind: 'retry', reason: 'transient-io' }
  }
}
