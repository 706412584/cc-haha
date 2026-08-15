import { describe, expect, it } from 'bun:test'
import type { ToolUseContext } from '../Tool.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { resolveAgentMessageToolUseContext } from './queryContext.js'

function cacheParams(toolUseContext: ToolUseContext): CacheSafeParams {
  return {
    systemPrompt: [] as unknown as CacheSafeParams['systemPrompt'],
    userContext: {},
    systemContext: {},
    toolUseContext,
    forkContextMessages: [],
  }
}

describe('resolveAgentMessageToolUseContext', () => {
  it('reuses the live parent context without rebuilding it', async () => {
    const liveContext = { marker: 'live' } as unknown as ToolUseContext
    let fallbackCalls = 0

    const resolved = await resolveAgentMessageToolUseContext(
      cacheParams(liveContext),
      async () => {
        fallbackCalls += 1
        return cacheParams({ marker: 'fallback' } as unknown as ToolUseContext)
      },
    )

    expect(resolved).toBe(liveContext)
    expect(fallbackCalls).toBe(0)
  })

  it('rebuilds the parent context after a completed session is restarted', async () => {
    const rebuiltContext = { marker: 'rebuilt' } as unknown as ToolUseContext

    const resolved = await resolveAgentMessageToolUseContext(
      null,
      async () => cacheParams(rebuiltContext),
    )

    expect(resolved).toBe(rebuiltContext)
  })
})
