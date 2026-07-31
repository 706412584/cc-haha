import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { IMAGE_MAX_BYTES, checkAttachmentLimit } from './attachment-limits.js'
import type { PendingUpload } from './attachment-types.js'

export type SafeOutboundImage =
  | { ok: true; buffer: Buffer; mime: string }
  | { ok: false; reason: string }

export async function loadSafeOutboundImage(
  pending: PendingUpload,
  sessionWorkDir: string | null | undefined,
): Promise<SafeOutboundImage> {
  if (!sessionWorkDir) {
    return { ok: false, reason: 'missing session work directory' }
  }

  if (pending.source.kind === 'url') {
    return { ok: false, reason: 'remote image URLs are not fetched from Agent output' }
  }

  if (pending.source.kind === 'base64') {
    const mime = pending.source.mime
    const estimatedBytes = Math.ceil(pending.source.data.length * 3 / 4)
    const preflight = checkAttachmentLimit('image', estimatedBytes, mime)
    if (!preflight.ok) return { ok: false, reason: preflight.hint }

    const buffer = Buffer.from(pending.source.data, 'base64')
    const exact = checkAttachmentLimit('image', buffer.length, mime)
    return exact.ok
      ? { ok: true, buffer, mime }
      : { ok: false, reason: exact.hint }
  }

  let canonicalRoot: string
  let canonicalFile: string
  try {
    canonicalRoot = await fs.realpath(sessionWorkDir)
    canonicalFile = await fs.realpath(pending.source.path)
  } catch {
    return { ok: false, reason: 'image path does not exist' }
  }

  const relative = path.relative(canonicalRoot, canonicalFile)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'image path is outside the active session work directory' }
  }

  const mime = pending.source.mime ?? 'image/png'
  const file = await fs.open(canonicalFile, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) {
      return { ok: false, reason: 'image path is not a regular file' }
    }
    const preflight = checkAttachmentLimit('image', stat.size, mime)
    if (!preflight.ok) return { ok: false, reason: preflight.hint }

    const chunks: Buffer[] = []
    let total = 0
    const stream = file.createReadStream({ autoClose: false })
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > IMAGE_MAX_BYTES) {
        stream.destroy()
        return { ok: false, reason: 'image exceeded the 10 MB limit while reading' }
      }
      chunks.push(buffer)
    }

    return { ok: true, buffer: Buffer.concat(chunks, total), mime }
  } finally {
    await file.close()
  }
}

export async function sendSafeOutboundImage(
  pending: PendingUpload,
  sessionWorkDir: string | null | undefined,
  send: (buffer: Buffer, mime: string) => Promise<unknown>,
): Promise<SafeOutboundImage> {
  const loaded = await loadSafeOutboundImage(pending, sessionWorkDir)
  if (!loaded.ok) return loaded
  await send(loaded.buffer, loaded.mime)
  return loaded
}
