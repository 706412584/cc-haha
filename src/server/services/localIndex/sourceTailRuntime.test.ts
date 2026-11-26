import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { foldTrailingRuntime } from './sourceTailRuntime.js'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tail-runtime-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const line = (value: unknown) => JSON.stringify(value) + '\n'
const meta = (extra: Record<string, unknown>) => line({ type: 'session-meta', ...extra })

async function fold(content: string, floor = 0, base = {}) {
  const file = path.join(dir, 't.jsonl')
  await fs.writeFile(file, content)
  const handle = await fs.open(file, 'r')
  try {
    return await foldTrailingRuntime(handle, floor, Buffer.byteLength(content), base)
  } finally { await handle.close() }
}

describe('foldTrailingRuntime', () => {
  it('returns the newest complete selection and later partial patches', async () => {
    const content = meta({ runtimeProviderId: 'old', runtimeModelId: 'old-model', effortLevel: 'max' }) +
      line({ type: 'user', message: { role: 'user', content: 'x'.repeat(3 * 1024 * 1024) } }) +
      meta({ runtimeProviderId: 'new', runtimeModelId: 'new-model' }) +
      meta({ thinkingEnabled: false })
    const result = await fold(content)
    expect(result.overlay).toEqual({ runtimeProviderId: 'new', runtimeModelId: 'new-model', effortLevel: undefined, thinkingEnabled: false })
    expect(result.end).toBe(Buffer.byteLength(content))
  })

  it('keeps the base when the tail has no session-meta and only patches it otherwise', async () => {
    const base = { runtimeProviderId: 'p', runtimeModelId: 'm', effortLevel: 'high' }
    expect((await fold(line({ type: 'user' }))).overlay).toEqual({})
    expect((await fold(line({ type: 'user' }), 0, base)).overlay).toEqual(base)
    expect((await fold(meta({ effortLevel: 'low' }), 0, base)).overlay).toEqual({ ...base, effortLevel: 'low' })
  })

  it('ignores an unterminated last line and reports where it starts', async () => {
    const complete = meta({ runtimeProviderId: 'a', runtimeModelId: 'a-model' })
    const result = await fold(complete + '{"type":"session-meta","runtimeProviderId":"b","runtimeModelId":"b')
    expect(result.overlay.runtimeModelId).toBe('a-model')
    expect(result.end).toBe(Buffer.byteLength(complete))
  })

  it('reads only from the floor and handles lines split across chunks', async () => {
    const before = meta({ runtimeProviderId: 'skip', runtimeModelId: 'skip' })
    const filler = line({ type: 'assistant', text: 'y'.repeat(1024 * 1024 - 40) })
    const content = before + filler + meta({ runtimeProviderId: 'tail', runtimeModelId: 'tail-model' }) + filler
    const result = await fold(content, Buffer.byteLength(before))
    expect(result.overlay).toMatchObject({ runtimeProviderId: 'tail', runtimeModelId: 'tail-model' })
    expect((await fold(before + filler, Buffer.byteLength(before))).overlay).toEqual({})
  })
})
