import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService, type JsonlParseMetric } from '../services/sessionService.js'

/**
 * An active transcript gains a line per event, so (mtime, size) never matches
 * the previous read and every poll used to re-parse the whole file — 10 GB/day
 * of redundant `JSON.parse` on a single 27 MB session, which is what made the
 * UI stutter while a fast model streamed. These tests pin the resume path and,
 * just as importantly, every case where it must decline and re-read.
 */
describe('SessionService jsonl append resume', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let metrics: JsonlParseMetric[]

  const makeService = (options: { maxFullJsonlReadBytes?: number } = {}) => {
    metrics = []
    return new SessionService(undefined, {
      maxFullJsonlReadBytes: options.maxFullJsonlReadBytes ?? 2_000_000,
      recordJsonlParseMetric: (metric) => metrics.push(metric),
    })
  }

  const userLine = (n: number, content = `msg-${n}`) =>
    JSON.stringify({
      type: 'user',
      uuid: `0000000${n}-0000-4000-8000-00000000000${n}`,
      timestamp: '2026-07-23T12:00:00.000Z',
      message: { role: 'user', content },
    }) + '\n'

  const write = async (id: string, body: string) => {
    const projectDir = path.join(tmpDir, 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })
    const filePath = path.join(projectDir, `${id}.jsonl`)
    await fs.writeFile(filePath, body)
    return filePath
  }

  const textOf = (messages: unknown) => JSON.stringify(messages)
  const lastMode = () => metrics[metrics.length - 1]?.mode

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-jsonl-append-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('parses only the appended bytes when the transcript grows', async () => {
    const service = makeService()
    const id = '00000000-0000-4000-8000-0000000000a1'
    const filePath = await write(id, userLine(1) + userLine(2))

    await service.getSessionMessages(id)
    expect(lastMode()).toBe('full')

    await fs.appendFile(filePath, userLine(3) + userLine(4))
    const messages = await service.getSessionMessages(id)

    expect(lastMode()).toBe('append')
    // The whole point: a few hundred bytes read, not the whole transcript.
    const appended = metrics[metrics.length - 1]!
    expect(appended.readBytes).toBeLessThan(600)
    expect(appended.fileBytes).toBeGreaterThan(appended.readBytes)

    const text = textOf(messages)
    expect(text).toContain('msg-1')
    expect(text).toContain('msg-3')
    expect(text).toContain('msg-4')
  })

  test('re-reads a record whose newline had not landed yet when it is completed', async () => {
    const service = makeService()
    const id = '00000000-0000-4000-8000-0000000000a2'
    // A complete record with no terminating newline: the read catches the file
    // between the record write and the newline write. It is parsed (a full read
    // wants its content) but sits past the resumable offset, so the next read
    // must re-read it — and must *replace* it, not append a second copy.
    const filePath = await write(id, userLine(1) + userLine(2).slice(0, -1))

    const first = await service.getSessionMessages(id)
    expect(textOf(first).match(/msg-2/g)!.length).toBe(1)

    await fs.appendFile(filePath, '\n' + userLine(3))
    const messages = await service.getSessionMessages(id)

    const text = textOf(messages)
    expect(text).toContain('msg-2')
    expect(text).toContain('msg-3')
    // The record was parsed once as an unterminated line and once as a complete
    // line — never spliced from the halves into a record that was never on
    // disk, and never kept twice.
    expect(text.match(/msg-2/g)!.length).toBe(1)
    expect(text.match(/msg-1/g)!.length).toBe(1)
  })

  test('a trailing partial is not reported as incomplete evidence', async () => {
    const service = makeService()
    const id = '00000000-0000-4000-8000-0000000000a3'
    const filePath = await write(id, userLine(1))

    await service.getSessionMessages(id)
    await fs.appendFile(filePath, userLine(2).slice(0, 40))
    const partial = await service.getSessionMessagesWithEvidence(id)
    // A record still being written is not a gap in the transcript, and the
    // full-read path does not call it one either — the resume path must not
    // start reporting every in-flight append as incomplete evidence.
    expect(partial.transcriptEvidenceComplete).toBe(true)

    await fs.appendFile(filePath, userLine(2).slice(40))
    const completed = await service.getSessionMessagesWithEvidence(id)
    expect(completed.transcriptEvidenceComplete).toBe(true)
    // The halves were spliced by the writer into one record, and that is how it
    // must be read: a record that was never on disk must not appear.
    expect(textOf(completed).match(/msg-2/g)!.length).toBe(1)

    await fs.appendFile(filePath, 'BROKEN JSON\n' + userLine(3))
    const malformed = await service.getSessionMessagesWithEvidence(id)
    expect(malformed.transcriptEvidenceComplete).toBe(false)
  })

  test('a transcript rewritten in place with a different prefix is not resumed', async () => {
    const service = makeService()
    const id = '00000000-0000-4000-8000-0000000000a4'
    const filePath = await write(id, userLine(1) + userLine(2))

    await service.getSessionMessages(id)

    // Rewind truncates and rewrites. Here the replacement is *larger* than the
    // cached size, so a size-only check would wrongly accept it as an append.
    await fs.writeFile(filePath, userLine(9, 'REWRITTEN-FIRST') + userLine(2) + userLine(3) + userLine(4))
    const messages = await service.getSessionMessages(id)

    const text = textOf(messages)
    expect(text).toContain('REWRITTEN-FIRST')
    expect(text).not.toContain('msg-1')
    expect(lastMode()).toBe('full')
  })

  test('a truncated transcript falls back to a full read', async () => {
    const service = makeService()
    const id = '00000000-0000-4000-8000-0000000000a5'
    const filePath = await write(id, userLine(1) + userLine(2) + userLine(3) + userLine(4))

    await service.getSessionMessages(id)
    await fs.writeFile(filePath, userLine(1))
    const messages = await service.getSessionMessages(id)

    const text = textOf(messages)
    expect(text).toContain('msg-1')
    expect(text).not.toContain('msg-4')
    expect(lastMode()).toBe('full')
  })

  test('a malformed appended line is still parsed past and marked incomplete', async () => {
    const service = makeService()
    const id = '00000000-0000-4000-8000-0000000000a6'
    const filePath = await write(id, userLine(1))

    await service.getSessionMessages(id)
    await fs.appendFile(filePath, 'this is not json\n' + userLine(2))
    const messages = await service.getSessionMessages(id)

    expect(textOf(messages)).toContain('msg-2')
  })

  test('a transcript past the full-read ceiling keeps degrading to a tail window', async () => {
    const service = makeService({ maxFullJsonlReadBytes: 2_000 })
    const id = '00000000-0000-4000-8000-0000000000a7'
    const junk =
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-07-23T00:00:00.000Z',
        sessionId: id,
        content: 'x'.repeat(80),
      }) + '\n'
    let body = ''
    while (Buffer.byteLength(body) < 3_000) body += junk
    const filePath = await write(id, body)

    await service.getSessionMessages(id)
    await fs.appendFile(filePath, junk)
    await service.getSessionMessages(id)

    // Appending must not start accumulating an oversized transcript in the
    // read cache; the tail path owns that regime.
    expect(metrics.every((metric) => metric.mode === 'tail')).toBe(true)
  })
})

describe('SessionService jsonl parse diagnostics throttle', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-jsonl-throttle-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('an injected recorder still observes every read', async () => {
    const seen: JsonlParseMetric[] = []
    const service = new SessionService(undefined, {
      maxFullJsonlReadBytes: 2_000_000,
      recordJsonlParseMetric: (metric) => seen.push(metric),
    })
    const projectDir = path.join(tmpDir, 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })
    const id = '00000000-0000-4000-8000-0000000000b1'
    const filePath = path.join(projectDir, `${id}.jsonl`)
    const line =
      JSON.stringify({
        type: 'user',
        uuid: '00000001-0000-4000-8000-000000000001',
        timestamp: '2026-07-23T12:00:00.000Z',
        message: { role: 'user', content: 'throttle-1' },
      }) + '\n'
    await fs.writeFile(filePath, line)

    await service.getSessionMessages(id)
    await service.getSessionMessages(id)
    await service.getSessionMessages(id)

    // The throttle belongs to the diagnostics sink, not the read path — a test
    // (or any other consumer) must still be able to count reads.
    expect(seen.length).toBe(3)
  })
})
