import type { VoiceFailure, VoiceFailureReason } from '../types.js'

/** A download that could not complete; `failure` is safe to show in the UI. */
export class VoiceDownloadError extends Error {
  readonly failure: VoiceFailure

  constructor(failure: VoiceFailure, options?: { cause?: unknown }) {
    super(failure.message, options)
    this.name = 'VoiceDownloadError'
    this.failure = failure
  }
}

/** Origin only: drops credentials, path and query so tokens never reach the UI or logs. */
export function sanitizeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'invalid-url'
  }
}

/** Replaces any URL inside a message with its credential-free origin + path. */
export function scrubUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"')]+/g, raw => {
    try {
      const url = new URL(raw)
      return `${url.origin}${url.pathname}`
    } catch {
      return 'url'
    }
  })
}

const STORAGE_CODES = new Set([
  'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE', 'EIO', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EBUSY', 'EEXIST',
])
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL', 'DNS_FAILURE'])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'Timeout', 'TimeoutError'])
const CERTIFICATE_PATTERN =
  /CERT_|CERTIFICATE|UNABLE_TO_VERIFY|SELF.SIGNED|ERR_TLS|SSL|UnknownIssuer|InvalidCertificate|UNABLE_TO_GET_ISSUER/i

function errorCodes(error: unknown): string[] {
  const codes: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
    if (current.name) codes.push(current.name)
    current = (current as { cause?: unknown }).cause
  }
  return codes
}

function messageChain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    parts.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join(' | ')
}

/** Maps a thrown network/fs error to a stable reason. Unknown shapes stay `unknown`. */
export function classifyError(error: unknown): VoiceFailureReason {
  if (error instanceof VoiceDownloadError) return error.failure.reason
  const codes = errorCodes(error)
  const text = messageChain(error)
  if (codes.some(code => STORAGE_CODES.has(code))) return 'storage'
  if (codes.some(code => DNS_CODES.has(code)) || /getaddrinfo|dns/i.test(text)) return 'dns'
  if (codes.some(code => CERTIFICATE_PATTERN.test(code)) || CERTIFICATE_PATTERN.test(text)) return 'certificate'
  if (codes.some(code => TIMEOUT_CODES.has(code)) || /timed? ?out/i.test(text)) return 'timeout'
  if (
    codes.some(code => /^(ECONN|EPIPE|ENET|EHOST|UND_ERR|ConnectionRefused|ConnectionClosed|ConnectionReset|FailedToOpenSocket)/i.test(code))
    || /fetch failed|socket|connection|network|closed|terminated|unable to connect|ECONN|EPIPE/i.test(text)
  ) {
    return 'network'
  }
  return 'unknown'
}

/** Failures worth another attempt against the same source, resuming from `.part`. */
export function isTransient(reason: VoiceFailureReason): boolean {
  return reason === 'network' || reason === 'timeout'
}

/** Failures another source cannot fix: local disk problems and programming errors. */
export function isTerminal(reason: VoiceFailureReason): boolean {
  return reason === 'storage' || reason === 'unknown' || reason === 'unsupported-platform'
}

export function toDownloadError(
  error: unknown,
  context: { source: string; resource: string },
): VoiceDownloadError {
  if (error instanceof VoiceDownloadError) return error
  const reason = classifyError(error)
  const raw = error instanceof Error ? error.message : String(error)
  return new VoiceDownloadError(
    { reason, source: context.source, resource: context.resource, message: scrubUrls(raw) },
    { cause: error },
  )
}
