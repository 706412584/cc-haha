import { afterEach, describe, expect, test } from 'bun:test'
import { CLAUDE_CODE_COMPAT_VERSION } from '../constants/claudeCodeCompatibility.js'
import { getUserAgent } from './http.js'

const USER_AGENT_ENV_KEYS = [
  'USER_TYPE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
] as const

const originalEnv = Object.fromEntries(
  USER_AGENT_ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof USER_AGENT_ENV_KEYS)[number], string | undefined>

afterEach(() => {
  for (const key of USER_AGENT_ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('getUserAgent', () => {
  test('uses the external runtime label when USER_TYPE is absent', () => {
    delete process.env.USER_TYPE
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
    delete process.env.CLAUDE_AGENT_SDK_VERSION
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP

    expect(getUserAgent()).toBe(
      `claude-cli/${CLAUDE_CODE_COMPAT_VERSION} (external, sdk-cli)`,
    )
  })

  test('preserves an explicit runtime label', () => {
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'

    expect(getUserAgent()).toContain('(ant, cli')
  })
})
