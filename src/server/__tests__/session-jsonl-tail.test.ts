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
})
