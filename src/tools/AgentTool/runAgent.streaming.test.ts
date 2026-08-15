import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunMessageEvent } from '../../utils/sdkEventQueue.js'

let queryMessages: unknown[] = []

mock.module('../../query.js', () => ({
  query: async function* () {
    for (const message of queryMessages) yield message
  },
}))

type RouteOptions =
  | { spawningToolUseId: string; isAsync?: boolean }
  | { querySource: 'workflow_agent' }
  | { streamTargetAgentId: string }

describe('runAgent live stream bridge', () => {
  let configDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    configDir = await mkdtemp(join(tmpdir(), 'agent-stream-test-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    queryMessages = [
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'agent-message', usage: {} } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'live token' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'thinking', thinking: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'thinking_delta', thinking: 'live thought' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 2,
          content_block: {
            type: 'tool_use',
            id: 'tool-call',
            name: 'Read',
            input: {},
          },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/a"}' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 2 },
      },
      {
        type: 'system',
        subtype: 'streaming_fallback',
        cause: 'stream_retry',
      },
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 3,
        retry_delay_ms: 50,
        error_status: 503,
        error: 'server_error',
      },
      {
        type: 'user',
        uuid: '11111111-1111-4111-8111-111111111111',
        timestamp: '2026-08-11T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-call',
            content: 'tool output',
            is_error: false,
          }],
        },
      },
    ]
  })

  afterEach(async () => {
    const queue = await import('../../utils/sdkEventQueue.js')
    queue.setAgentRunMessageSink(undefined)
    queue.drainSdkEvents()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })

  async function createRun(routeOptions: RouteOptions) {
    const [
      { getDefaultAppState },
      { createFileStateCacheWithSizeLimit },
      { asSystemPrompt },
      agentModule,
    ] = await Promise.all([
      import('../../state/AppStateStore.js'),
      import('../../utils/fileStateCache.js'),
      import('../../utils/systemPromptType.js'),
      import('./runAgent.js'),
    ])
    const agentDefinition = {
      agentType: 'stream-reviewer',
      whenToUse: 'Verify streaming',
      rawSystemPrompt: 'Stream.',
      getSystemPrompt: () => 'Stream.',
      source: 'projectSettings',
    } as const
    const parentState = getDefaultAppState()
    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [agentDefinition], allAgents: [agentDefinition] },
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(),
      getAppState: () => parentState,
      setAppState: () => {},
      setResponseLength: () => {},
      messages: [],
      toolUseId: 'parent-agent-tool',
    }

    return agentModule.runAgent({
      agentDefinition,
      promptMessages: [],
      toolUseContext: toolUseContext as never,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      isAsync: 'isAsync' in routeOptions ? routeOptions.isAsync ?? false : false,
      querySource: 'querySource' in routeOptions
        ? routeOptions.querySource
        : 'agent:custom',
      override: {
        userContext: {},
        systemContext: {},
        systemPrompt: asSystemPrompt([]),
        agentId: 'physical-run-agent' as never,
      },
      availableTools: [],
      ...('spawningToolUseId' in routeOptions
        ? { spawningToolUseId: routeOptions.spawningToolUseId }
        : {}),
      ...('streamTargetAgentId' in routeOptions
        ? { streamTargetAgentId: routeOptions.streamTargetAgentId }
        : {}),
    })
  }

  test.each([
    ['foreground SubAgent', { spawningToolUseId: 'agent-tool' }],
    ['background Agent', { spawningToolUseId: 'background-tool', isAsync: true }],
    ['workflow Agent', { querySource: 'workflow_agent' }],
    ['teammate Agent', { streamTargetAgentId: 'worker@team' }],
  ] as const)('forwards text, thinking, tool, result, and retry events for %s', async (_kind, routeOptions) => {
    const [print, remoteIoModule, structuredIoModule, teammate] = await Promise.all([
      import('../../cli/print.js'),
      import('../../cli/remoteIO.js'),
      import('../../cli/structuredIO.js'),
      import('../../utils/teammateContext.js'),
    ])
    const remote = new structuredIoModule.StructuredIO((async function* () {})())
    Object.setPrototypeOf(remote, remoteIoModule.RemoteIO.prototype)
    const events: Array<AgentRunMessageEvent & { uuid: string; session_id: string }> = []
    const removeSink = print.bindAgentRunMessageSink(remote)
    const yielded: unknown[] = []
    const consume = async () => {
      for await (const message of await createRun(routeOptions)) {
        yielded.push(message)
      }
    }

    try {
      if ('streamTargetAgentId' in routeOptions) {
        const context = {
          ...teammate.createTeammateContext({
            agentId: routeOptions.streamTargetAgentId,
            agentName: 'worker',
            teamName: 'team',
            planModeRequired: false,
            parentSessionId: 'leader-session',
            abortController: new AbortController(),
          }),
          streamScopeId: 'team-stream-scope',
        }
        await teammate.runWithTeammateContext(context, consume)
      } else {
        await consume()
      }
    } finally {
      removeSink()
    }
    remote.outbound.done()
    while (true) {
      const next = await remote.outbound.next()
      if (next.done) break
      events.push(next.value as AgentRunMessageEvent & { uuid: string; session_id: string })
    }

    expect(yielded).toEqual([queryMessages.at(-1)])
    expect(events.map(event => event.event_kind)).toEqual([
      ...queryMessages.map(() => 'message' as const),
      'complete',
    ])
    expect(events.slice(0, -1).map(event => event.message)).toEqual(queryMessages)
    expect(events.every(event => event.run_agent_id === 'physical-run-agent')).toBe(true)
    expect(new Set(events.map(event => event.stream_id)).size).toBe(1)
    expect(events[0]?.stream_id).toBeString()
    expect(events.every(event => event.target_agent_id === (
      'streamTargetAgentId' in routeOptions
        ? routeOptions.streamTargetAgentId
        : 'physical-run-agent'
    ))).toBe(true)
    expect(events.every(event => event.target_agent_scope_id === (
      'streamTargetAgentId' in routeOptions ? 'team-stream-scope' : undefined
    ))).toBe(true)
  })

  test('emits one terminal event when the consumer returns the generator early', async () => {
    const queue = await import('../../utils/sdkEventQueue.js')
    queryMessages = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'before return' },
        },
      },
      {
        type: 'attachment',
        attachment: { type: 'structured_output', data: { stop: true } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'must not be consumed' },
        },
      },
    ]
    const events: Array<AgentRunMessageEvent> = []
    const removeSink = queue.setAgentRunMessageSink(event => events.push(event))

    try {
      const generator = await createRun({ spawningToolUseId: 'agent-tool' })
      expect((await generator.next()).value).toEqual(queryMessages[1])
      expect(events.map(event => event.event_kind)).toEqual(['message'])
      await generator.return()
    } finally {
      removeSink()
    }

    expect(events.map(event => event.event_kind)).toEqual(['message', 'cancelled'])
  })

  test('drops directed stream events without occupying the generic SDK queue', async () => {
    const queue = await import('../../utils/sdkEventQueue.js')
    queue.drainSdkEvents()

    queue.emitAgentRunMessage({
      runAgentId: 'physical-run-agent',
      streamId: 'isolated-stream',
      targetAgentId: 'worker@team',
    }, {
      kind: 'message',
      message: queryMessages[2],
    })
    queue.enqueueSdkEvent({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
    })

    expect(queue.drainSdkEvents()).toEqual([
      expect.objectContaining({
        subtype: 'session_state_changed',
        state: 'running',
      }),
    ])
  })
})
