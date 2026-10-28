import { afterEach, describe, expect, test } from 'bun:test'
import { CLAUDE_CODE_COMPAT_VERSION } from '../constants/claudeCodeCompatibility.js'
import { getMCPUserAgent, getUserAgent } from './http.js'
import { getClaudeCodeUserAgent } from './userAgent.js'

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
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    delete process.env.CLAUDE_AGENT_SDK_VERSION
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP

    expect(getUserAgent()).toBe(
      `claude-cli/${CLAUDE_CODE_COMPAT_VERSION} (external, cli)`,
    )
  })

  test('preserves an explicit runtime label', () => {
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'

    expect(getUserAgent()).toContain('(ant, cli')
  })

  test('reports the CLI entrypoint regardless of the host entrypoint switch', () => {
    // The desktop host sets claude-desktop internally; upstream must still see
    // the Claude Code CLI, which is what this app is built on.
    delete process.env.USER_TYPE
    delete process.env.CLAUDE_AGENT_SDK_VERSION
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    for (const hostValue of ['claude-desktop', 'sdk-cli', undefined]) {
      if (hostValue === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
      else process.env.CLAUDE_CODE_ENTRYPOINT = hostValue
      expect(getUserAgent()).toBe(
        `claude-cli/${CLAUDE_CODE_COMPAT_VERSION} (external, cli)`,
      )
    }
  })
})

describe('Claude Code user agents', () => {
  test('MCP and generic user agents carry the compatibility version and CLI entrypoint', () => {
    delete process.env.CLAUDE_AGENT_SDK_VERSION
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'

    expect(getMCPUserAgent()).toBe(`claude-code/${CLAUDE_CODE_COMPAT_VERSION} (cli)`)
    expect(getClaudeCodeUserAgent()).toBe(`claude-code/${CLAUDE_CODE_COMPAT_VERSION}`)
  })
})
