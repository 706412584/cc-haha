import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'

describe('SessionService oversized jsonl tail guard', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let service: SessionService

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-jsonl-tail-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    // Low ceiling so the test stays tiny; production default is 50 MiB.
    service = new SessionService(undefined, { maxFullJsonlReadBytes: 2_000 })
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('parses only the tail of an oversized transcript', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })
    const sessionId = '00000000-0000-4000-8000-000000000099'
    const filePath = path.join(projectDir, `${sessionId}.jsonl`)

    const junkLine =
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-07-23T00:00:00.000Z',
        sessionId,
        content: 'x'.repeat(80),
      }) + '\n'
    const earlyUser =
      JSON.stringify({
        type: 'user',
        uuid: '11111111-1111-4111-8111-111111111111',
        timestamp: '2026-07-23T01:00:00.000Z',
        message: { role: 'user', content: 'early-user-should-be-cut' },
      }) + '\n'
    const lateUser =
      JSON.stringify({
        type: 'user',
        uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        timestamp: '2026-07-23T12:00:00.000Z',
        message: { role: 'user', content: 'tail-only-user-message' },
      }) + '\n'

    // Build a file larger than maxFullJsonlReadBytes=2000 so only the tail is read.
    let body = earlyUser
    while (Buffer.byteLength(body + junkLine + lateUser) < 4_000) {
      body += junkLine
    }
    body += lateUser
    await fs.writeFile(filePath, body)

    const messages = await service.getSessionMessages(sessionId)
    const text = messages
      .map((m) =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      )
      .join('\n')
    expect(text).toContain('tail-only-user-message')
    expect(text).not.toContain('early-user-should-be-cut')
  })

  test('drops a cut mid-record when the tail window starts mid-line', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })
    const sessionId = '00000000-0000-4000-8000-000000000098'
    const filePath = path.join(projectDir, `${sessionId}.jsonl`)
    const lateUser =
      JSON.stringify({
        type: 'user',
        uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        timestamp: '2026-07-23T12:00:00.000Z',
        message: { role: 'user', content: 'complete-tail-message' },
      }) + '\n'
    // Prefix with a long partial line (no newline until the end of the junk) so
    // maxBytes=2000 lands mid-record and the first incomplete line is discarded.
    const partial = `{"type":"queue-operation","content":"${'y'.repeat(2500)}"}\n`
    await fs.writeFile(filePath, partial + lateUser)

    const messages = await service.getSessionMessages(sessionId)
    const text = messages
      .map((m) =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      )
      .join('\n')
    expect(text).toContain('complete-tail-message')
  })

  test('returns empty messages for a small valid transcript under the ceiling', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })
    const sessionId = '00000000-0000-4000-8000-000000000097'
    const filePath = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.writeFile(
      filePath,
      JSON.stringify({
        type: 'user',
        uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        timestamp: '2026-07-23T12:00:00.000Z',
        message: { role: 'user', content: 'small-file' },
      }) + '\n',
    )
    const messages = await service.getSessionMessages(sessionId)
    expect(JSON.stringify(messages)).toContain('small-file')
  })

  test('R1: emits parse metrics for oversized tail and small-file cache hit', async () => {
    const metrics: Array<Record<string, unknown>> = []
    service = new SessionService(undefined, {
      maxFullJsonlReadBytes: 2_000,
      recordJsonlParseMetric: (metric) => {
        metrics.push(metric as unknown as Record<string, unknown>)
      },
    })

    const projectDir = path.join(tmpDir, 'projects', 'test-project')
    await fs.mkdir(projectDir, { recursive: true })

    const bigId = '00000000-0000-4000-8000-000000000096'
    const bigPath = path.join(projectDir, `${bigId}.jsonl`)
    const junkLine =
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-07-23T00:00:00.000Z',
        sessionId: bigId,
        content: 'x'.repeat(80),
      }) + '\n'
    const lateUser =
      JSON.stringify({
        type: 'user',
        uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        timestamp: '2026-07-23T12:00:00.000Z',
        message: { role: 'user', content: 'metric-tail-user' },
      }) + '\n'
    let body = ''
    while (Buffer.byteLength(body + junkLine + lateUser) < 4_000) body += junkLine
    body += lateUser
    await fs.writeFile(bigPath, body)

    await service.getSessionMessages(bigId)
    expect(metrics.length).toBe(1)
    expect(metrics[0]).toMatchObject({
      cacheHit: false,
      mode: 'tail',
      cachedAfterRead: false,
      fileName: `${bigId}.jsonl`,
    })
    expect(metrics[0]!.fileBytes).toBeGreaterThan(2_000)
    expect(metrics[0]!.readBytes).toBe(2_000)
    expect(metrics[0]!.entryCount).toBeGreaterThan(0)
    expect(metrics[0]!.durationMs).toBeGreaterThanOrEqual(0)

    metrics.length = 0
    const smallId = '00000000-0000-4000-8000-000000000095'
    await fs.writeFile(
      path.join(projectDir, `${smallId}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        timestamp: '2026-07-23T12:00:00.000Z',
        message: { role: 'user', content: 'metric-small' },
      }) + '\n',
    )

    await service.getSessionMessages(smallId)
    await service.getSessionMessages(smallId)
    expect(metrics.length).toBe(2)
    expect(metrics[0]).toMatchObject({
      cacheHit: false,
      mode: 'full',
      cachedAfterRead: true,
      fileName: `${smallId}.jsonl`,
    })
    expect(metrics[1]).toMatchObject({
      cacheHit: true,
      mode: 'full',
      readBytes: 0,
      cachedAfterRead: false,
      fileName: `${smallId}.jsonl`,
    })
  })

  test('R2: rate-limits oversized console.warn per path', async () => {
    let nowMs = 1_000_000
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }

    try {
      service = new SessionService(undefined, {
        maxFullJsonlReadBytes: 2_000,
        oversizedWarnMinIntervalMs: 60_000,
        now: () => nowMs,
        recordJsonlParseMetric: () => {},
      })

      const projectDir = path.join(tmpDir, 'projects', 'test-project')
      await fs.mkdir(projectDir, { recursive: true })
      const sessionId = '00000000-0000-4000-8000-000000000094'
      const filePath = path.join(projectDir, `${sessionId}.jsonl`)
      const junkLine =
        JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          timestamp: '2026-07-23T00:00:00.000Z',
          sessionId,
          content: 'x'.repeat(80),
        }) + '\n'
      const lateUser =
        JSON.stringify({
          type: 'user',
          uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          timestamp: '2026-07-23T12:00:00.000Z',
          message: { role: 'user', content: 'r2-tail-user' },
        }) + '\n'
      let body = ''
      while (Buffer.byteLength(body + junkLine + lateUser) < 4_000) body += junkLine
      body += lateUser
      await fs.writeFile(filePath, body)

      await service.getSessionMessages(sessionId)
      await service.getSessionMessages(sessionId)
      await service.getSessionMessages(sessionId)
      expect(warnings.filter((w) => w.includes('oversized transcript')).length).toBe(1)

      nowMs += 30_000
      await service.getSessionMessages(sessionId)
      expect(warnings.filter((w) => w.includes('oversized transcript')).length).toBe(1)

      nowMs += 60_000
      await service.getSessionMessages(sessionId)
      expect(warnings.filter((w) => w.includes('oversized transcript')).length).toBe(2)
    } finally {
      console.warn = originalWarn
    }
  })
})
