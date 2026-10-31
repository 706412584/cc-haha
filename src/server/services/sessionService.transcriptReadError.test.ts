import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './sessionService.js'

let directory: string
let previousConfig: string | undefined
let previousHome: string | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-read-error-'))
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  previousHome = process.env.HOME
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.HOME = directory
})

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(directory, { recursive: true, force: true })
})

async function writeSession(sessionId: string): Promise<string> {
  const projectDir = '-tmp-project'
  await mkdir(join(directory, 'projects', projectDir), { recursive: true })
  const filePath = join(directory, 'projects', projectDir, `${sessionId}.jsonl`)
  await writeFile(filePath, `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'hello' },
    timestamp: '2026-07-15T00:00:00.000Z',
  })}\n`)
  return filePath
}

/**
 * The streaming branch of `readJsonlFileWithDiagnostics` wraps its read loop in
 * `catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') ... }`.
 * A type assertion is erased at runtime, so `err.code` is a real property read:
 * a rejection that is not an object (an abort reason, a string) threw
 * `undefined is not an object (evaluating 'x.code')`, which surfaced as a 500 and
 * buried the original failure. These cases pin the contract that the thrown value
 * is inspected safely and otherwise rethrown untouched.
 */
describe('SessionService streaming transcript reads handle any thrown value', () => {
  type Internals = {
    readJsonlFileWithDiagnostics: (
      filePath: string,
      options?: { mayContainEntry?: (line: string) => boolean },
    ) => Promise<{ entries: unknown[]; exists: boolean; parseComplete: boolean }>
  }

  test('rethrows a thrown undefined instead of raising a TypeError about .code', async () => {
    const filePath = await writeSession('11111111-1111-4111-8111-111111111111')
    const internals = new SessionService() as unknown as Internals

    // `undefined` is exactly what produced the reported
    // "undefined is not an object (evaluating 'x.code')": reading `.code` off an
    // object or a primitive is harmless, off `undefined` it is not.
    const thrown = await internals.readJsonlFileWithDiagnostics(filePath, {
      mayContainEntry: () => { throw undefined },
    }).then(() => 'no-throw', (error: unknown) => error)

    expect(thrown).toBeUndefined()
  })

  test('rethrows the original AbortError from an aborted signal', async () => {
    const filePath = await writeSession('22222222-2222-4222-8222-222222222222')
    const internals = new SessionService() as unknown as Internals
    const controller = new AbortController()
    controller.abort()

    const thrown = await internals.readJsonlFileWithDiagnostics(filePath, {
      mayContainEntry: () => { controller.signal.throwIfAborted(); return true },
    }).then(() => null, (error: unknown) => error)

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).name).toBe('AbortError')
  })

  test('still treats a genuine ENOENT as a missing transcript', async () => {
    const filePath = join(directory, 'projects', '-tmp-project', '33333333-3333-4333-8333-333333333333.jsonl')
    const internals = new SessionService() as unknown as Internals

    const result = await internals.readJsonlFileWithDiagnostics(filePath, {
      mayContainEntry: () => true,
    })

    expect(result).toEqual({ entries: [], exists: false, parseComplete: false })
  })
})
