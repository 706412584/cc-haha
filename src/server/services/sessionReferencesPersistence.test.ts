import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './sessionService.js'
import { SessionCollaborationService, COLLABORATION_READ_MAX_PAGES } from './sessionCollaborationService.js'
import { resolveSessionReferenceContext } from './sessionReferenceContext.js'

let directory: string
let previousConfig: string | undefined
let file: string
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const referenced = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
const historyService = () => new SessionService({ getMode: () => 'off' } as any)
const entry = (uuid: string, content: unknown) => ({
  type: 'user', uuid, message: { role: 'user', content }, sessionId: id,
  timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/reference-fixture',
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-reference-persistence-'))
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const project = join(directory, 'projects', '-tmp-reference-fixture')
  await mkdir(project, { recursive: true })
  file = join(project, `${id}.jsonl`)
})
afterEach(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await rm(directory, { recursive: true, force: true })
})

test('a fresh history service restores reference pills from persisted string and block messages', async () => {
  const text = await resolveSessionReferenceContext('Use the previous result', [{ sessionId: referenced }], async () => true)
  const entries = [entry('string-reference', text), entry('block-reference', [
    { type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } },
  ]), entry('legacy', 'An older message without references')]
  await writeFile(file, entries.map(value => JSON.stringify(value)).join('\n') + '\n')
  const firstRead = await historyService().getSessionHistoryPage(id)
  const restoredRead = await historyService().getSessionHistoryPage(id)
  expect(restoredRead.messages).toEqual(firstRead.messages)
  const stringMessage = restoredRead.messages.find(message => message.id === 'string-reference')!
  expect(stringMessage.content).toBe('Use the previous result')
  expect(stringMessage.sessionReferences).toEqual([{ sessionId: referenced }])
  const blockMessage = restoredRead.messages.find(message => message.id === 'block-reference')!
  expect(blockMessage.sessionReferences).toEqual([{ sessionId: referenced }])
  expect(blockMessage.content).toEqual([
    { type: 'text', text: 'Use the previous result' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } },
  ])
  expect(restoredRead.messages.find(message => message.id === 'legacy')?.sessionReferences).toBeUndefined()
})

test('collaboration cursors traverse real bounded history pages without dropping turns', async () => {
  // One `read` cursor chain is capped at COLLABORATION_READ_MAX_PAGES (8), so the
  // fixture only needs to be longer than one chain can serve: the assertion is
  // that every turn a chain *does* serve is contiguous, and that reaching the
  // cap is reported instead of silently truncating.
  await writeFile(file, Array.from({ length: 130 }, (_, index) => JSON.stringify(entry(`user-${index}`, `turn ${index}`))).join('\n') + '\n')
  const sessions = historyService()
  const collaboration = new SessionCollaborationService({
    statePath: join(directory, 'collaboration.json'),
    sessions: {
      list: async () => ({ sessions: [] }), exists: async () => true,
      create: async () => { throw new Error('Unused fixture operation') },
      read: (sessionId, options) => sessions.getSessionHistoryPage(sessionId, options),
    },
    runtime: { start: async () => {}, enqueue: async () => {}, stop: async () => {} },
  })
  let cursor: string | undefined
  const ids: string[] = []
  let longestCursor = 0
  let last: { page: { hasMore: boolean }; historyComplete: boolean } | undefined
  do {
    last = await collaboration.read(id, { cursor, limit: 10 }) as typeof last & { messages: Array<{ id: string }>; page: { nextCursor: string | null } }
    ids.unshift(...last!.messages.map(message => message.id))
    cursor = last!.page.nextCursor ?? undefined
    longestCursor = Math.max(longestCursor, cursor?.length ?? 0)
  } while (cursor)
  // The chain stops at the cap rather than walking the whole transcript, and the
  // turns it served are the newest ones with no gaps.
  expect(ids).toEqual(Array.from({ length: COLLABORATION_READ_MAX_PAGES * 10 }, (_, index) => `user-${index + 50}`))
  expect(last).toMatchObject({ page: { hasMore: false }, historyComplete: false })
  // A collaboration cursor must stay small: a 500-character model tool schema
  // rejects an oversized continuation request. The chain stops inside the first
  // storage page, so this cursor carries no embedded storage cursor at all.
  expect(longestCursor).toBeGreaterThan(0)
  expect(longestCursor).toBeLessThan(32_000)
})

test('a storage cursor stays small enough for a model tool schema', async () => {
  // The layer that embeds snapshot identity and the three fingerprints is the
  // storage cursor, so characterize its size here rather than through a
  // collaboration chain that no longer reaches it.
  await writeFile(file, Array.from({ length: 130 }, (_, index) => JSON.stringify(entry(`user-${index}`, `turn ${index}`))).join('\n') + '\n')
  const cursor = (await historyService().getSessionHistoryPage(id, { limit: 100 })).page.nextCursor
  expect(cursor).not.toBeNull()
  // Snapshot identity + prefix/tail/boundary fingerprints; still far under the
  // 32k a tool schema would tolerate.
  expect(cursor!.length).toBeGreaterThan(500)
  expect(cursor!.length).toBeLessThan(32_000)
})


test('preserves trailing reference envelopes after long user prompts in both history formats', async () => {
  const prompt = 'Long referenced request. '.repeat(1800)
  const text = await resolveSessionReferenceContext(prompt, [{ sessionId: referenced }], async () => true)
  await writeFile(file, [entry('long-string', text), entry('long-block', [{ type: 'text', text }])].map(value => JSON.stringify(value)).join('\n') + '\n')
  const restored = await historyService().getSessionHistoryPage(id)
  expect(restored.messages.find(message => message.id === 'long-string')).toMatchObject({ content: prompt, sessionReferences: [{ sessionId: referenced }] })
  expect(restored.messages.find(message => message.id === 'long-block')).toMatchObject({ content: [{ type: 'text', text: prompt }], sessionReferences: [{ sessionId: referenced }] })
  expect(restored.page.contentTruncated).toBeUndefined()
})


test('serves a complete tool result above two MiB as a standalone history page', async () => {
  const result = 'complete tool output\n'.repeat(160_000)
  expect(Buffer.byteLength(result)).toBeGreaterThan(2 * 1024 * 1024)
  const content = [{ type: 'tool_result', tool_use_id: 'large-tool', is_error: false, content: result }]
  await writeFile(file, [entry('before', 'earlier request'), entry('large-result', content), entry('after', 'later request')].map(value => JSON.stringify(value)).join('\n') + '\n')
  const service = historyService()
  const latest = await service.getSessionHistoryPage(id)
  expect(latest.messages.map(message => message.id)).toEqual(['after'])
  const large = await service.getSessionHistoryPage(id, { cursor: latest.page.nextCursor! })
  expect(large.messages).toHaveLength(1)
  expect(large.messages[0]).toMatchObject({ id: 'large-result', content })
  expect(large.page.contentTruncated).toBeUndefined()
  const older = await service.getSessionHistoryPage(id, { cursor: large.page.nextCursor! })
  expect(older.messages.map(message => message.id)).toEqual(['before'])
})
