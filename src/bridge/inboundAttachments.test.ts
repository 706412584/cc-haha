import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId } from '../bootstrap/state.js'
import {
  extractInboundAttachments,
  MAX_INBOUND_ATTACHMENT_BYTES,
  MAX_INBOUND_ATTACHMENT_CONCURRENCY,
  MAX_INBOUND_ATTACHMENTS,
  MAX_INBOUND_ATTACHMENT_TOTAL_BYTES,
  resolveInboundAttachments,
  type InboundAttachment,
  type InboundAttachmentDownloader,
} from './inboundAttachments.js'

const originalEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  USER_TYPE: process.env.USER_TYPE,
  CLAUDE_BRIDGE_OAUTH_TOKEN: process.env.CLAUDE_BRIDGE_OAUTH_TOKEN,
  CLAUDE_BRIDGE_BASE_URL: process.env.CLAUDE_BRIDGE_BASE_URL,
}
let configDir = ''

function attachments(count: number): InboundAttachment[] {
  return Array.from({ length: count }, (_, index) => ({
    file_uuid: `file-${index}`,
    file_name: `file-${index}.txt`,
  }))
}

async function uploadedFiles(): Promise<string[]> {
  return await readdir(join(configDir, 'uploads', getSessionId())).catch(() => [])
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'inbound-attachments-test-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_BRIDGE_OAUTH_TOKEN = 'test-token'
  process.env.CLAUDE_BRIDGE_BASE_URL = 'https://bridge.example.test'
})

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(configDir, { recursive: true, force: true })
})

describe('inbound bridge attachment limits', () => {
  it('rejects a message with more than 10 attachments before downloading', () => {
    const file_attachments = attachments(MAX_INBOUND_ATTACHMENTS + 1)

    expect(extractInboundAttachments({ file_attachments })).toEqual([])
  })

  it('does not invoke the downloader when a direct resolver call exceeds the item limit', async () => {
    let downloadCalls = 0
    const download: InboundAttachmentDownloader = async () => {
      downloadCalls += 1
      return { status: 200, data: Buffer.from('unexpected') }
    }

    expect(await resolveInboundAttachments(
      attachments(MAX_INBOUND_ATTACHMENTS + 1),
      { download },
    )).toBe('')
    expect(downloadCalls).toBe(0)
  })

  it('bounds download concurrency and passes a per-response byte limit', async () => {
    let active = 0
    let maxActive = 0
    const seenLimits: number[] = []
    const download: InboundAttachmentDownloader = async (_url, config) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      seenLimits.push(config.maxContentLength as number)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return { status: 200, data: Buffer.from('ok') }
    }

    const prefix = await resolveInboundAttachments(attachments(6), { download })

    expect(maxActive).toBe(MAX_INBOUND_ATTACHMENT_CONCURRENCY)
    expect(seenLimits).toEqual(Array(6).fill(MAX_INBOUND_ATTACHMENT_BYTES))
    expect(prefix.match(/@"/g)?.length).toBe(6)
  })

  it('rejects an oversized response before writing it', async () => {
    const oversized = Buffer.alloc(MAX_INBOUND_ATTACHMENT_BYTES + 1)
    const download: InboundAttachmentDownloader = async () => ({
      status: 200,
      data: oversized,
    })

    expect(await resolveInboundAttachments(attachments(1), { download })).toBe('')
    expect(await uploadedFiles()).toEqual([])
  })

  it('cleans up files from the message when actual aggregate bytes exceed the limit', async () => {
    const chunk = Buffer.alloc(
      Math.floor(MAX_INBOUND_ATTACHMENT_TOTAL_BYTES / 3) + 1,
    )
    const download: InboundAttachmentDownloader = async () => ({
      status: 200,
      data: chunk,
    })

    expect(await resolveInboundAttachments(attachments(3), { download })).toBe('')
    expect(await uploadedFiles()).toEqual([])
  })

  it('treats downloader body-limit errors as a failed attachment batch', async () => {
    const download: InboundAttachmentDownloader = async () => {
      throw new Error('maxContentLength exceeded')
    }

    expect(await resolveInboundAttachments(attachments(1), { download })).toBe('')
    expect(await uploadedFiles()).toEqual([])
  })

  it('stages a unique non-overwriting file when the same attachment is resent', async () => {
    const attachment = {
      file_uuid: 'file-0',
      file_name: 'collision',
    }
    let responseNumber = 0
    const download: InboundAttachmentDownloader = async () => ({
      status: 200,
      data: Buffer.from(`safe-${++responseNumber}`),
    })

    const first = await resolveInboundAttachments([attachment], { download })
    const second = await resolveInboundAttachments([attachment], { download })
    const files = await uploadedFiles()

    expect(first).toMatch(/^@"[^"]+" $/)
    expect(second).toMatch(/^@"[^"]+" $/)
    expect(second).not.toBe(first)
    expect(files).toHaveLength(2)
    expect(await Promise.all(files.map((file) =>
      readFile(join(configDir, 'uploads', getSessionId(), file), 'utf8')
    ))).toEqual(expect.arrayContaining(['safe-1', 'safe-2']))
  })
})
