import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  enqueueSessionEntryAfterPendingForTesting,
  flushSessionStorage,
  getTranscriptPathForSession,
  recordTranscript,
  resetProjectForTesting,
} from '../sessionStorage.js'
import { switchSession } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import type { CustomTitleMessage } from '../../types/logs.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTranscriptEntrypoint = process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT
const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `session-storage-flush-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe('sessionStorage flush', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
  })

  afterEach(async () => {
    resetProjectForTesting()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalTranscriptEntrypoint === undefined) {
      delete process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT
    } else {
      process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT = originalTranscriptEntrypoint
    }
    if (originalEntrypoint === undefined) {
      delete process.env.CLAUDE_CODE_ENTRYPOINT
    } else {
      process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
    }
    if (originalTestPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('records the desktop transcript entrypoint without changing the runtime entrypoint', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222'
    switchSession(sessionId as SessionId)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
    process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT = 'claude-desktop'
    resetProjectForTesting()

    await recordTranscript([{
      type: 'user',
      uuid: '33333333-3333-4333-8333-333333333333',
      message: { role: 'user', content: 'desktop resume visibility' },
    } as never])
    await flushSessionStorage()

    const transcript = await fs.readFile(getTranscriptPathForSession(sessionId), 'utf-8')
    const userEntry = transcript
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.type === 'user')

    expect(userEntry?.entrypoint).toBe('claude-desktop')
    expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-cli')
  })

  it('drains writes that are queued by pending operations during flush', async () => {
    const transcriptPath = path.join(tmpDir, 'late-enqueue.jsonl')
    const entry: CustomTitleMessage = {
      type: 'custom-title',
      customTitle: 'late enqueue',
      sessionId: '11111111-1111-4111-8111-111111111111',
    }
    const writePromise = enqueueSessionEntryAfterPendingForTesting(
      transcriptPath,
      entry,
      10,
    )

    await flushSessionStorage()
    await writePromise

    const content = await fs.readFile(transcriptPath, 'utf-8')
    expect(content).toContain('"customTitle":"late enqueue"')
  })
})
