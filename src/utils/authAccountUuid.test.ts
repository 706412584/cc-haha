import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
// Static import: the environment below is switched after module load, and
// `getOauthAccountUuid` reads it at call time.
import { getOauthAccountUuid } from './auth.js'

// `metadata.user_id.account_uuid` must be the account the injected token belongs
// to. The CLI cannot work that out itself (an env-injected token has no profile
// scope), so the desktop server hands it over as CLAUDE_CODE_ACCOUNT_UUID.

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const

const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

let configDir: string

beforeAll(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-uuid-test-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-oauth-token'
})

afterAll(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(configDir, { recursive: true, force: true })
})

describe('getOauthAccountUuid', () => {
  test('uses the account uuid the host injected', () => {
    process.env.CLAUDE_CODE_ACCOUNT_UUID = ' 7a1d0f9c-account '

    expect(getOauthAccountUuid()).toBe('7a1d0f9c-account')
  })

  test('is empty when nothing identifies the account', () => {
    delete process.env.CLAUDE_CODE_ACCOUNT_UUID

    expect(getOauthAccountUuid()).toBe('')
  })

  test('is not reported when Anthropic OAuth is not the active auth', () => {
    process.env.CLAUDE_CODE_ACCOUNT_UUID = '7a1d0f9c-account'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    try {
      expect(getOauthAccountUuid()).toBe('')
    } finally {
      delete process.env.CLAUDE_CODE_USE_BEDROCK
    }
  })
})
