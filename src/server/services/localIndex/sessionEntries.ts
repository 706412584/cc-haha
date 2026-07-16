import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'
import type { ReadonlyFileHandle } from './fileReader.js'
import type { SessionEntryLocatorPage } from './sessionIndex.js'
import {
  deserializeSourceFingerprint,
  verifySourceFingerprint,
  type LocalIndexIoMetrics,
  type SourceFingerprint,
  type SourceFingerprintIo,
} from './sourceFingerprint.js'
import type { TranscriptEntryLocator } from './types.js'

export type SessionEntryRangeIo = {
  lstatPath(path: string): Promise<Stats>
  realpathPath(path: string): Promise<string>
  openReadonly(path: string): Promise<ReadonlyFileHandle>
}

export type TargetedSessionEntryRead = {
  entries: Array<Record<string, unknown>>
  bytesRead: number
  rangesRead: number
}

const MAX_TARGETED_BYTES = 16 * 1024 * 1024

const defaultIo: SessionEntryRangeIo = {
  lstatPath: path => lstat(path),
  realpathPath: path => realpath(path),
  openReadonly(path): Promise<FileHandle> {
    return open(path, 'r')
  },
}

type LocatorRange = {
  start: number
  length: number
  locators: TranscriptEntryLocator[]
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function identity(snapshot: Pick<Stats, 'dev' | 'ino'>): string | null {
  if (process.platform === 'win32' || snapshot.ino === 0) return null
  return `${snapshot.dev}:${snapshot.ino}`
}

function snapshotMatchesPage(
  snapshot: Pick<Stats, 'size' | 'mtimeMs' | 'dev' | 'ino'>,
  page: SessionEntryLocatorPage,
): boolean {
  const actualIdentity = identity(snapshot)
  return snapshot.size === page.source.size &&
    snapshot.mtimeMs === page.source.mtimeMs &&
    (
      page.source.fileIdentity === null ||
      actualIdentity === null ||
      page.source.fileIdentity === actualIdentity
    )
}

function fingerprintMatchesPage(
  fingerprint: SourceFingerprint,
  page: SessionEntryLocatorPage,
): boolean {
  return fingerprint.size === page.source.size &&
    fingerprint.mtimeMs === page.source.mtimeMs &&
    fingerprint.fileIdentity === page.source.fileIdentity &&
    fingerprint.indexedBytes === page.source.indexedBytes &&
    fingerprint.parserVersion === page.source.parserVersion
}

function fingerprintIo(io: SessionEntryRangeIo): SourceFingerprintIo {
  return {
    openReadonly(path) {
      return io.openReadonly(path)
    },
    statPath(path) {
      return io.lstatPath(path)
    },
  }
}

function pathIsInExpectedProject(
  transcriptRealPath: string,
  projectsRealPath: string,
  expectedProjectDir: string,
): boolean {
  const child = relative(projectsRealPath, transcriptRealPath)
  const parts = child.split(sep)
  return child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    parts.length === 2 &&
    parts[0] === expectedProjectDir &&
    Boolean(parts[1]) &&
    parts[1]!.endsWith('.jsonl') &&
    basename(transcriptRealPath) === parts[1]
}

function validateLocators(
  page: SessionEntryLocatorPage,
): LocatorRange[] | null {
  if (
    !safeInteger(page.source.size) ||
    !safeInteger(page.source.indexedBytes) ||
    page.source.indexedBytes > page.source.size ||
    page.source.parserVersion < 2 ||
    (page.source.state !== 'ready' && page.source.state !== 'pending')
  ) {
    return null
  }

  const ranges: LocatorRange[] = []
  let previousOrdinal = -1
  let previousJsonlLine = 0
  let previousEnd = 0
  let totalBytes = 0
  for (const locator of page.entries) {
    const end = locator.byteStart + locator.byteLength
    if (
      !safeInteger(locator.ordinal) ||
      !safeInteger(locator.jsonlLine) ||
      locator.jsonlLine < 1 ||
      !safeInteger(locator.byteStart) ||
      !safeInteger(locator.byteLength) ||
      locator.byteLength < 1 ||
      !Number.isSafeInteger(end) ||
      end > page.source.indexedBytes ||
      locator.ordinal <= previousOrdinal ||
      locator.jsonlLine <= previousJsonlLine ||
      locator.byteStart < previousEnd ||
      !locator.entryType
    ) {
      return null
    }

    const previousRange = ranges.at(-1)
    if (previousRange && previousRange.start + previousRange.length === locator.byteStart) {
      previousRange.length += locator.byteLength
      previousRange.locators.push(locator)
    } else {
      ranges.push({
        start: locator.byteStart,
        length: locator.byteLength,
        locators: [locator],
      })
    }
    totalBytes += locator.byteLength
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TARGETED_BYTES) return null
    previousOrdinal = locator.ordinal
    previousJsonlLine = locator.jsonlLine
    previousEnd = end
  }
  return ranges
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function locatorMatchesEntry(
  locator: TranscriptEntryLocator,
  entry: Record<string, unknown>,
): boolean {
  const message = entry.message && typeof entry.message === 'object'
    ? entry.message as Record<string, unknown>
    : null
  const entryType = typeof entry.type === 'string' ? entry.type : 'unknown'
  const messageId = typeof entry.uuid === 'string'
    ? entry.uuid
    : nullableString(entry.messageId)
  return entryType === locator.entryType &&
    messageId === locator.messageId &&
    nullableString(message?.role) === locator.role &&
    nullableString(entry.timestamp) === locator.timestamp &&
    nullableString(entry.parent_tool_use_id) === locator.parentToolUseId
}

async function readExactRange(
  handle: ReadonlyFileHandle,
  start: number,
  length: number,
): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(length)
  let consumed = 0
  while (consumed < length) {
    const { bytesRead } = await handle.read(
      buffer,
      consumed,
      length - consumed,
      start + consumed,
    )
    if (bytesRead < 1) return null
    consumed += bytesRead
  }
  return buffer
}

export async function readSessionEntriesByLocator(options: {
  transcriptPath: string
  projectsRoot: string
  expectedProjectDir: string
  page: SessionEntryLocatorPage
  io?: SessionEntryRangeIo
}): Promise<TargetedSessionEntryRead | null> {
  const io = options.io ?? defaultIo
  const transcriptPath = resolve(options.transcriptPath)
  if (options.page.source.path !== transcriptPath) return null

  const ranges = validateLocators(options.page)
  if (!ranges) return null
  const expectedFingerprint = deserializeSourceFingerprint(options.page.source.fingerprint)
  if (
    !expectedFingerprint ||
    !fingerprintMatchesPage(expectedFingerprint, options.page)
  ) {
    return null
  }

  let handle: ReadonlyFileHandle | undefined
  let closeFailed = false
  const fingerprintMetrics: LocalIndexIoMetrics = {
    filesOpened: 0,
    bytesRead: 0,
    statCalls: 0,
  }
  try {
    const [sourceLink, projectsRealPath, transcriptRealPath] = await Promise.all([
      io.lstatPath(transcriptPath),
      io.realpathPath(resolve(options.projectsRoot)),
      io.realpathPath(transcriptPath),
    ])
    if (
      !sourceLink.isFile() ||
      sourceLink.isSymbolicLink() ||
      !snapshotMatchesPage(sourceLink, options.page) ||
      !pathIsInExpectedProject(
        transcriptRealPath,
        projectsRealPath,
        options.expectedProjectDir,
      )
    ) {
      return null
    }

    const entries: Array<Record<string, unknown>> = []
    if (ranges.length > 0) {
      handle = await io.openReadonly(transcriptPath)
      const before = await handle.stat()
      if (!snapshotMatchesPage(before as Stats, options.page)) return null

      for (const range of ranges) {
        const bytes = await readExactRange(handle, range.start, range.length)
        if (!bytes) return null
        for (const locator of range.locators) {
          const relativeStart = locator.byteStart - range.start
          const raw = bytes.subarray(
            relativeStart,
            relativeStart + locator.byteLength,
          )
          let parsed: unknown
          try {
            parsed = JSON.parse(raw.toString('utf8').trim())
          } catch {
            return null
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
          const entry = parsed as Record<string, unknown>
          if (!locatorMatchesEntry(locator, entry)) return null
          entries.push(entry)
        }
      }

      const after = await handle.stat()
      if (!snapshotMatchesPage(after as Stats, options.page)) return null
    }

    // Verify after range I/O so a same-size rewrite between the initial stat
    // and the selected reads cannot be trusted merely because mtime/identity
    // still match. The verifier itself checks handle/path stability.
    const fingerprintVerification = await verifySourceFingerprint({
      path: transcriptPath,
      expected: expectedFingerprint,
      metrics: fingerprintMetrics,
      io: fingerprintIo(io),
    })
    if (fingerprintVerification.kind !== 'unchanged') return null

    const [currentLink, currentRealPath] = await Promise.all([
      io.lstatPath(transcriptPath),
      io.realpathPath(transcriptPath),
    ])
    if (
      !currentLink.isFile() ||
      currentLink.isSymbolicLink() ||
      !snapshotMatchesPage(currentLink, options.page) ||
      currentRealPath !== transcriptRealPath
    ) {
      return null
    }

    return {
      entries,
      bytesRead: fingerprintMetrics.bytesRead +
        ranges.reduce((total, range) => total + range.length, 0),
      rangesRead: ranges.length,
    }
  } catch {
    return null
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        closeFailed = true
      }
    }
    if (closeFailed) return null
  }
}
