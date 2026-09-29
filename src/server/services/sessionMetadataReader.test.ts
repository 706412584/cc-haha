import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HISTORY_SEMANTIC_RECORD_BYTES } from './boundedSessionHistory.js'
import { isSessionMetadataTextTruncated, streamSessionMetadata } from './sessionMetadataReader.js'

let directory: string
let file: string
const large = 'x'.repeat(HISTORY_SEMANTIC_RECORD_BYTES + 1)
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'metadata-reader-'))
  file = join(directory, 'history.jsonl')
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function read(content: string) {
  await writeFile(file, content)
  const entries: {
    entry: Record<string, unknown>
    complete: boolean
    offset: number
  }[] = []
  let skipped = 0
  const scan = await streamSessionMetadata(file, (entry, complete, offset) => entries.push({ entry, complete, offset }), undefined, { onSkipped: () => skipped++ })
  return { entries, scan, skipped }
}

test('large image bodies retain launch and context fields, including metadata after the body', async () => {
  const entry = { type: 'user', message: { content: [{ type: 'image', source: { data: large } }, { type: 'text', text: '你好 🌎' }], role: 'user' }, cwd: '/tmp/正确', uuid: 'turn', parentUuid: 'previous', parent_tool_use_id: 'agent', isSidechain: true, isMeta: false }
  const content = JSON.stringify(entry) + '\n'
  const result = await read(content)
  expect(result.scan).toMatchObject({ omittedRecords: 0, projectedRecords: 1 })
  expect(result.entries[0]).toMatchObject({ complete: true, offset: 0, entry: { ...entry, message: { content: [{ type: 'image' }, { type: 'text', text: '你好 🌎' }], role: 'user' } } })
  expect(isSessionMetadataTextTruncated(result.entries[0]!.entry)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(content)
})

test('ordinary records remain byte-semantically complete, including long notification text', async () => {
  const entry = { message: { role: 'user', content: 'x'.repeat(70_000) }, custom: { untouched: true } }
  const { entries, scan } = await read(JSON.stringify(entry))
  expect(entries[0]).toEqual({ entry, complete: false, offset: 0 })
  expect(scan.projectedRecords).toBe(0)
  expect(isSessionMetadataTextTruncated(entries[0]!.entry)).toBe(false)
})

test('long text is bounded and explicitly marked as incomplete for semantic classifiers', async () => {
  const { entries } = await read(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: large }] } }))
  const entry = entries[0]!.entry
  expect(isSessionMetadataTextTruncated(entry)).toBe(true)
  expect(JSON.stringify(entry).length).toBeLessThan(5000)
})

test('tool payloads are discarded while all Agent identity blocks remain available', async () => {
  const { entries } = await read(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', input: { prompt: large }, id: 'task-1', name: 'Agent' }, { type: 'tool_result', tool_use_id: 'tool-2', content: large }] } }))
  expect(entries[0]!.entry).toEqual({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'task-1', name: 'Agent' }, { type: 'tool_result', tool_use_id: 'tool-2' }] } })
  expect(isSessionMetadataTextTruncated(entries[0]!.entry)).toBe(false)
})

test('duplicate keys use JSON last-value semantics and prototype keys cannot mutate objects', async () => {
  const { entries } = await read('{"unused":"' + large + '","type":"user","type":"system","repository":{"__proto__":{"polluted":true}},"message":{"role":"user"},"message":null}')
  expect(entries[0]!.entry.type).toBe('system')
  expect(entries[0]!.entry.message).toBe(null)
  expect(Object.prototype.hasOwnProperty.call(entries[0]!.entry.repository, '__proto__')).toBe(true)
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
})

test('malformed large records are skipped without accepting their partial projected metadata', async () => {
  const { entries, scan, skipped } = await read('{"type":"session-meta","workDir":"/wrong","body":"' + large + '",}\n' + JSON.stringify({ type: 'session-meta', workDir: '/right' }) + '\n')
  expect(scan.omittedRecords).toBe(1)
  expect(skipped).toBe(1)
  expect(entries.map(item => item.entry)).toEqual([{ type: 'session-meta', workDir: '/right' }])
})

test('unterminated large JSON is skipped but a valid non-newline tail is retained', async () => {
  const bad = await read('{"message":{"content":"' + large)
  expect(bad.entries).toEqual([])
  expect(bad.scan.omittedRecords).toBe(1)
  const good = await read(JSON.stringify({ unused: large, cwd: '/tail' }))
  expect(good.entries).toEqual([{ entry: { cwd: '/tail' }, complete: false, offset: 0 }])
})

test('real oversized launch metadata and excessive structure fail explicitly', async () => {
  await writeFile(file, JSON.stringify({ unused: large, workDir: 'x'.repeat(128 * 1024 + 1) }))
  await expect(streamSessionMetadata(file, () => {})).rejects.toMatchObject({ code: 'SESSION_METADATA_TOO_LARGE' })
  await writeFile(file, '{"unused":"' + large + '","repository":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}')
  await expect(streamSessionMetadata(file, () => {})).rejects.toMatchObject({ code: 'SESSION_METADATA_TOO_LARGE' })
})

test('honors byte ranges and propagates consumer errors and cancellation', async () => {
  const prefix = JSON.stringify({ type: 'before' }) + '\n'
  const body = JSON.stringify({ type: 'user', unused: large }) + '\n'
  await writeFile(file, prefix + body + '{"type":"after"}\n')
  const offsets: number[] = []
  const scan = await streamSessionMetadata(file, (_entry, _complete, offset) => offsets.push(offset), undefined, { startOffset: Buffer.byteLength(prefix), endOffset: Buffer.byteLength(prefix + body) })
  expect(offsets).toEqual([Buffer.byteLength(prefix)])
  expect(scan.nextOffset).toBe(Buffer.byteLength(prefix + body))
  await expect(streamSessionMetadata(file, () => {
    throw new Error('consumer failure')
  })).rejects.toThrow('consumer failure')
  await expect(streamSessionMetadata(file, () => {}, AbortSignal.abort())).rejects.toThrow()
})

test('overlong retained metadata keys are rejected instead of being silently renamed', async () => {
  await writeFile(file, JSON.stringify({ unused: large, repository: { ['x'.repeat(257)]: 'value' } }))
  await expect(streamSessionMetadata(file, () => {})).rejects.toMatchObject({ code: 'SESSION_METADATA_TOO_LARGE' })
  const { entries } = await read(JSON.stringify({ ['x'.repeat(HISTORY_SEMANTIC_RECORD_BYTES + 1)]: 'unused', cwd: '/right' }))
  expect(entries[0]!.entry).toEqual({ cwd: '/right' })
})

test('duplicate message, content, and text keys discard obsolete truncation flags', async () => {
  for (const record of [
    '{"message":{"content":"' + large + '"},"message":{"role":"user","content":"final"}}',
    '{"message":{"role":"user","content":"' + large + '","content":"final"}}',
    '{"message":{"role":"user","content":[{"type":"text","text":"' + large + '","text":"final"}]}}',
  ]) {
    const { entries } = await read(record)
    expect(isSessionMetadataTextTruncated(entries[0]!.entry)).toBe(false)
  }
})
