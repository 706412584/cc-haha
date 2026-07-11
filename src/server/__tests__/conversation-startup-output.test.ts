import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConversationService,
  ConversationStartupError,
} from '../services/conversationService.js'

describe('ConversationService startup output', () => {
  let service: ConversationService
  let tmpDir: string
  const originalEnv = new Map<string, string | undefined>()
  const envKeys = [
    'CLAUDE_CLI_PATH',
    'CLAUDE_CONFIG_DIR',
    'CC_HAHA_DISABLE_TERMINAL_SHELL_ENV',
    'MOCK_SDK_STARTUP_STDOUT',
  ]

  beforeEach(async () => {
    service = new ConversationService()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-startup-output-'))
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key])
    }

    process.env.CLAUDE_CLI_PATH = fileURLToPath(
      new URL('./fixtures/mock-startup-exit-cli.ts', import.meta.url),
    )
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
    process.env.MOCK_SDK_STARTUP_STDOUT = 'provider rejected request: invalid model id'
  })

  afterEach(async () => {
    await service.stopAllSessionsAndWait(1_000)
    for (const key of envKeys) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    originalEnv.clear()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('includes CLI stdout when the process exits before SDK messages', async () => {
    let startupError: unknown

    try {
      await service.startSession(
        `startup-output-${crypto.randomUUID()}`,
        tmpDir,
        'ws://127.0.0.1:1/sdk/startup-output?token=test-token',
      )
    } catch (error) {
      startupError = error
    }

    expect(startupError).toBeInstanceOf(ConversationStartupError)
    expect(startupError).toMatchObject({ code: 'CLI_START_FAILED' })
    expect((startupError as Error).message).toContain(
      'CLI exited during startup (code 1): provider rejected request: invalid model id',
    )
  }, 10_000)
})
