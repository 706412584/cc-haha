/**
 * Resolve file_uuid attachments on inbound bridge user messages.
 *
 * Web composer uploads via cookie-authed /api/{org}/upload, sends file_uuid
 * alongside the message. Here we fetch each via GET /api/oauth/files/{uuid}/content
 * (oauth-authed, same store), write to ~/.claude/uploads/{sessionId}/, and
 * return @path refs to prepend. Claude's Read tool takes it from there.
 *
 * Best-effort: any failure (no token, network, non-2xx, disk) logs debug and
 * skips that attachment. The message still reaches Claude, just without @path.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import axios, { type AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import { mkdir, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { z } from 'zod/v4'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { lazySchema } from '../utils/lazySchema.js'
import { getBridgeAccessToken, getBridgeBaseUrl } from './bridgeConfig.js'

const DOWNLOAD_TIMEOUT_MS = 30_000
export const MAX_INBOUND_ATTACHMENTS = 10
export const MAX_INBOUND_ATTACHMENT_BYTES = 30 * 1024 * 1024
export const MAX_INBOUND_ATTACHMENT_TOTAL_BYTES = 60 * 1024 * 1024
export const MAX_INBOUND_ATTACHMENT_CONCURRENCY = 2

function debug(msg: string): void {
  logForDebugging(`[bridge:inbound-attach] ${msg}`)
}

const attachmentSchema = lazySchema(() =>
  z.object({
    file_uuid: z.string(),
    file_name: z.string(),
  }),
)
const attachmentsArraySchema = lazySchema(() =>
  z.array(attachmentSchema()).max(MAX_INBOUND_ATTACHMENTS),
)

export type InboundAttachment = z.infer<ReturnType<typeof attachmentSchema>>

export type InboundAttachmentDownloader = (
  url: string,
  config: AxiosRequestConfig,
) => Promise<{ status: number; data: unknown }>

type DownloadBudget = {
  totalBytes: number
  limitExceeded: boolean
}

const defaultDownloader: InboundAttachmentDownloader = (url, config) =>
  axios.get(url, config)

function toBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  throw new Error('attachment response is not binary data')
}

/** Pull file_attachments off a loosely-typed inbound message. */
export function extractInboundAttachments(msg: unknown): InboundAttachment[] {
  if (typeof msg !== 'object' || msg === null || !('file_attachments' in msg)) {
    return []
  }
  const raw = msg.file_attachments
  if (!Array.isArray(raw) || raw.length > MAX_INBOUND_ATTACHMENTS) {
    return []
  }
  const parsed = attachmentsArraySchema().safeParse(raw)
  return parsed.success ? parsed.data : []
}

/**
 * Strip path components and keep only filename-safe chars. file_name comes
 * from the network (web composer), so treat it as untrusted even though the
 * composer controls it.
 */
function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || 'attachment'
}

function uploadsDir(): string {
  return join(getClaudeConfigHomeDir(), 'uploads', getSessionId())
}

/**
 * Fetch + write one attachment. Returns the absolute path on success,
 * undefined on any failure.
 */
async function resolveOne(
  att: InboundAttachment,
  budget: DownloadBudget,
  download: InboundAttachmentDownloader,
): Promise<string | undefined> {
  const token = getBridgeAccessToken()
  if (!token) {
    debug('skip: no oauth token')
    return undefined
  }

  let data: Buffer
  try {
    // getOauthConfig() (via getBridgeBaseUrl) throws on a non-allowlisted
    // CLAUDE_CODE_CUSTOM_OAUTH_URL — keep it inside the try so a bad
    // FedStart URL degrades to "no @path" instead of crashing print.ts's
    // reader loop (which has no catch around the await).
    const url = `${getBridgeBaseUrl()}/api/oauth/files/${encodeURIComponent(att.file_uuid)}/content`
    const response = await download(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxContentLength: MAX_INBOUND_ATTACHMENT_BYTES,
      maxBodyLength: MAX_INBOUND_ATTACHMENT_BYTES,
      validateStatus: () => true,
    })
    if (response.status !== 200) {
      debug(`fetch ${att.file_uuid} failed: status=${response.status}`)
      return undefined
    }
    data = toBuffer(response.data)
    if (data.length > MAX_INBOUND_ATTACHMENT_BYTES) {
      budget.limitExceeded = true
      debug(`skip ${att.file_uuid}: exceeds per-file limit`)
      return undefined
    }
    if (
      budget.totalBytes + data.length >
      MAX_INBOUND_ATTACHMENT_TOTAL_BYTES
    ) {
      budget.limitExceeded = true
      debug(`skip ${att.file_uuid}: exceeds aggregate attachment limit`)
      return undefined
    }
    budget.totalBytes += data.length
  } catch (e) {
    if (/maxContentLength|larger than.*limit/i.test(String(e))) {
      budget.limitExceeded = true
    }
    debug(`fetch ${att.file_uuid} threw: ${e}`)
    return undefined
  }

  // Keep a readable UUID prefix for diagnostics, but add a fresh suffix for
  // every delivery. The same cloud attachment may be intentionally resent in
  // one session, and staging must neither overwrite nor silently drop it.
  const safeName = sanitizeFileName(att.file_name)
  const prefix = (
    att.file_uuid.slice(0, 8) || randomUUID().slice(0, 8)
  ).replace(/[^a-zA-Z0-9_-]/g, '_')
  const dir = uploadsDir()
  const outPath = join(dir, `${prefix}-${randomUUID()}-${safeName}`)

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(outPath, data, { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      await unlink(outPath).catch(() => {})
    }
    debug(`write ${outPath} failed: ${e}`)
    return undefined
  }

  debug(`resolved ${att.file_uuid} → ${outPath} (${data.length} bytes)`)
  return outPath
}

/**
 * Resolve all attachments on an inbound message to a prefix string of
 * @path refs. Empty string if none resolved.
 */
export async function resolveInboundAttachments(
  attachments: InboundAttachment[],
  options: { download?: InboundAttachmentDownloader } = {},
): Promise<string> {
  if (attachments.length === 0) return ''
  if (attachments.length > MAX_INBOUND_ATTACHMENTS) {
    debug(`skip: ${attachments.length} attachments exceeds item limit`)
    return ''
  }
  debug(`resolving ${attachments.length} attachment(s)`)
  const budget: DownloadBudget = { totalBytes: 0, limitExceeded: false }
  const paths: Array<string | undefined> = new Array(attachments.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (!budget.limitExceeded) {
      const index = nextIndex
      nextIndex += 1
      const attachment = attachments[index]
      if (!attachment) return
      paths[index] = await resolveOne(
        attachment,
        budget,
        options.download ?? defaultDownloader,
      )
    }
  }
  const workerCount = Math.min(
    MAX_INBOUND_ATTACHMENT_CONCURRENCY,
    attachments.length,
  )
  await Promise.all(Array.from({ length: workerCount }, worker))
  const ok = paths.filter((p): p is string => p !== undefined)
  if (budget.limitExceeded) {
    await Promise.all(ok.map((filePath) => unlink(filePath).catch(() => {})))
    return ''
  }
  if (ok.length === 0) return ''
  // Quoted form — extractAtMentionedFiles truncates unquoted @refs at the
  // first space, which breaks any home dir with spaces (/Users/John Smith/).
  return ok.map(p => `@"${p}"`).join(' ') + ' '
}

/**
 * Prepend @path refs to content, whichever form it's in.
 * Targets the LAST text block — processUserInputBase reads inputString
 * from processedBlocks[processedBlocks.length - 1], so putting refs in
 * block[0] means they're silently ignored for [text, image] content.
 */
export function prependPathRefs(
  content: string | Array<ContentBlockParam>,
  prefix: string,
): string | Array<ContentBlockParam> {
  if (!prefix) return content
  if (typeof content === 'string') return prefix + content
  const i = content.findLastIndex(b => b.type === 'text')
  if (i !== -1) {
    const b = content[i]!
    if (b.type === 'text') {
      return [
        ...content.slice(0, i),
        { ...b, text: prefix + b.text },
        ...content.slice(i + 1),
      ]
    }
  }
  // No text block — append one at the end so it's last.
  return [...content, { type: 'text', text: prefix.trimEnd() }]
}

/**
 * Convenience: extract + resolve + prepend. No-op when the message has no
 * file_attachments field (fast path — no network, returns same reference).
 */
export async function resolveAndPrepend(
  msg: unknown,
  content: string | Array<ContentBlockParam>,
): Promise<string | Array<ContentBlockParam>> {
  const attachments = extractInboundAttachments(msg)
  if (attachments.length === 0) return content
  const prefix = await resolveInboundAttachments(attachments)
  return prependPathRefs(content, prefix)
}
