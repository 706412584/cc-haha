import { Inflate, unzipSync } from 'fflate'

/**
 * A .docx or .xlsx is a zip, and both engines unpack it whole in the page's own
 * thread: a small file that inflates to gigabytes would freeze or kill the app on the
 * reader's first click. This checks an archive before either of them is let near it.
 *
 * Two passes. The first reads only the table of contents, never a byte of what is
 * compressed, and refuses an archive that promises to be enormous. The second does
 * not take that promise on trust: an archive can declare any size it likes, and a
 * few hundred kilobytes that declare a hundred bytes inflate to hundreds of
 * megabytes inside the parser that believed them. So each deflated entry is inflated
 * in small steps, counted, and dropped, and the pass stops the moment the real total
 * passes a limit — or an entry turns out not to be the size it said.
 *
 * What it cannot follow it lets through (an archive it cannot read the layout of,
 * data that does not inflate): the parser is the one to report those.
 */

const MIB = 1024 * 1024

export type OfficeZipLimits = {
  /** Files in the archive. */
  maxEntries: number
  /** What any one file may inflate to. */
  maxEntryBytes: number
  /** What all of them together may inflate to. */
  maxTotalBytes: number
  /**
   * Below this, the compression ratio is not looked at: a small, very regular file
   * (a blank bitmap) compresses hundreds of times over and is harmless.
   */
  ratioFloorBytes: number
  /** Above the floor, an archive may not inflate to more than this many times its own size. */
  maxRatio: number
}

export const DEFAULT_OFFICE_ZIP_LIMITS: OfficeZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 256 * MIB,
  maxTotalBytes: 512 * MIB,
  ratioFloorBytes: 64 * MIB,
  maxRatio: 500,
}

export type OfficeZipFailure =
  | 'not-a-zip'
  | 'too-many-entries'
  | 'entry-too-large'
  | 'too-large'
  | 'suspicious-ratio'
  | 'size-mismatch'

export class OfficeZipError extends Error {
  readonly reason: OfficeZipFailure

  constructor(reason: OfficeZipFailure, message: string) {
    super(message)
    this.name = 'OfficeZipError'
    this.reason = reason
  }
}

export type OfficeZipSummary = {
  entries: number
  /** What the archive says everything inflates to. */
  uncompressedBytes: number
}

/** Thrown from inside a walk to stop it early. */
class Refused extends Error {
  constructor(readonly failure: OfficeZipError) {
    super(failure.message)
  }
}

/**
 * Check an archive against `limits`. Returns what its table of contents says, or
 * throws an {@link OfficeZipError} saying which limit it broke.
 */
export function inspectOfficeZip(
  bytes: Uint8Array,
  limits: OfficeZipLimits = DEFAULT_OFFICE_ZIP_LIMITS,
): OfficeZipSummary {
  let entries = 0
  let uncompressed = 0
  let compressed = 0

  try {
    // A filter that never accepts a file: fflate reads the central directory and
    // decompresses nothing.
    unzipSync(bytes, {
      filter: (file) => {
        entries += 1
        uncompressed += file.originalSize
        compressed += file.size
        if (entries > limits.maxEntries) {
          throw new Refused(new OfficeZipError('too-many-entries', `The archive holds more than ${limits.maxEntries} files`))
        }
        if (file.originalSize > limits.maxEntryBytes) {
          throw new Refused(new OfficeZipError('entry-too-large', `${file.name} would inflate to ${file.originalSize} bytes`))
        }
        if (uncompressed > limits.maxTotalBytes) {
          throw new Refused(new OfficeZipError('too-large', `The archive would inflate to more than ${limits.maxTotalBytes} bytes`))
        }
        return false
      },
    })
  } catch (error) {
    if (error instanceof Refused) throw error.failure
    throw new OfficeZipError('not-a-zip', error instanceof Error ? error.message : String(error))
  }

  if (uncompressed > limits.ratioFloorBytes && uncompressed > Math.max(compressed, 1) * limits.maxRatio) {
    throw new OfficeZipError(
      'suspicious-ratio',
      `The archive inflates ${Math.round(uncompressed / Math.max(compressed, 1))} times over`,
    )
  }

  try {
    verifyInflation(bytes, limits)
  } catch (error) {
    if (error instanceof Refused) throw error.failure
    // Not something this pass could follow: leave it to the parser.
  }
  return { entries, uncompressedBytes: uncompressed }
}

/**
 * How much compressed input is inflated at a time. Deflate expands at most about a
 * thousandfold, so this bounds what one step can put in memory (16 MiB) before the
 * count sees it, however hostile the entry.
 */
const INFLATE_STEP_BYTES = 16 * 1024

type DirectoryEntry = {
  name: string
  method: number
  compressedSize: number
  declaredSize: number
  dataStart: number
}

const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50
const ZIP64_MARKER = 0xffffffff

/**
 * The entries of the central directory — the part of an archive a reader believes when
 * it disagrees with the rest — with where each one's compressed bytes start. `null`
 * for a layout this does not read (a zip64 archive, a directory that runs off the end).
 */
function readDirectory(bytes: Uint8Array): DirectoryEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const earliest = Math.max(0, bytes.length - 22 - 0xffff)
  let end = -1
  for (let at = bytes.length - 22; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) {
      end = at
      break
    }
  }
  if (end < 0) return null

  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  if (count === 0xffff || cursor === ZIP64_MARKER) return null

  const entries: DirectoryEntry[] = []
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== DIRECTORY_ENTRY) return null
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const declaredSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    if (compressedSize === ZIP64_MARKER || declaredSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) return null
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_HEADER) return null

    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    if (dataStart + compressedSize > bytes.length) return null
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
      method,
      compressedSize,
      declaredSize,
      dataStart,
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Inflate every deflated entry in steps, counting what comes out and keeping none of
 * it. Throws {@link Refused} when the real sizes break `limits`, or an entry is not
 * the size the directory said it was; throws anything else when it cannot follow the
 * archive, which the caller lets through.
 */
function verifyInflation(bytes: Uint8Array, limits: OfficeZipLimits): void {
  const entries = readDirectory(bytes)
  if (!entries) return

  let total = 0
  for (const entry of entries) {
    // Stored entries cannot grow; anything else is a method this does not inflate.
    if (entry.method !== 8) continue

    let produced = 0
    const inflate = new Inflate((chunk) => {
      produced += chunk.length
      total += chunk.length
      if (produced > limits.maxEntryBytes) {
        throw new Refused(new OfficeZipError('entry-too-large', `${entry.name} inflates to more than ${limits.maxEntryBytes} bytes`))
      }
      if (total > limits.maxTotalBytes) {
        throw new Refused(new OfficeZipError('too-large', `The archive inflates to more than ${limits.maxTotalBytes} bytes`))
      }
    })
    for (let at = 0; at < entry.compressedSize; at += INFLATE_STEP_BYTES) {
      const end = Math.min(at + INFLATE_STEP_BYTES, entry.compressedSize)
      inflate.push(bytes.subarray(entry.dataStart + at, entry.dataStart + end), end === entry.compressedSize)
    }
    if (produced !== entry.declaredSize) {
      throw new Refused(new OfficeZipError('size-mismatch', `${entry.name} inflates to ${produced} bytes, not the ${entry.declaredSize} it says`))
    }
  }
}
