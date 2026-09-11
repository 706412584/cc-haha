import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Tool } from '../Tool.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import { Stream } from '../utils/stream.js'
import { StructuredIO } from './structuredIO.js'

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
process.env.ANTHROPIC_API_KEY = 'test-key'

const mcpClient = { ...await import('../services/mcp/client.js') }
const mcpConfig = { ...await import('../services/mcp/config.js') }

let isDisabled = false
let hasConfig = true
let resolveReconnect: ((result: ReturnType<typeof reconnectResult>) => void) | undefined
const cleanup = mock(async () => {})
const clearServerCache = mock(async () => {})

function reconnectResult(
  client: MCPServerConnection = connectedClient(),
  withAssets = false,
) {
  return {
    name: 'test-server',
    client,
    tools: withAssets ? [{ name: 'mcp__test-server__lookup' } as Tool] : [],
    commands: withAssets
      ? [{ name: 'mcp__test-server__prompt', description: '', argumentHint: '' }]
      : [],
    resources: withAssets
      ? [{
          server: 'test-server',
          uri: 'test://resource',
          name: 'resource',
        }]
      : [],
  }
}

function connectedClient(): ConnectedMCPServer {
  return {
    name: 'test-server',
    type: 'connected',
    client: {} as ConnectedMCPServer['client'],
    capabilities: {},
    config: { type: 'sse', url: 'https://example.com/mcp' },
    cleanup,
  }
}

function failedClient(): MCPServerConnection {
  return {
    name: 'test-server',
    type: 'failed',
    config: { type: 'sse', url: 'https://example.com/mcp' },
    error: 'reconnect failed',
  }
}

mock.module('../services/mcp/client.js', () => ({
  ...mcpClient,
  reconnectMcpServerImpl: () =>
    new Promise<ReturnType<typeof reconnectResult>>(resolve => {
      resolveReconnect = resolve
    }),
  clearServerCache,
}))

mock.module('../services/mcp/config.js', () => ({
  ...mcpConfig,
  getMcpConfigByName: () =>
    hasConfig
      ? {
          type: 'sse',
          url: 'https://example.com/mcp',
        }
      : undefined,
  isMcpServerDisabled: () => isDisabled,
  setMcpServerEnabled: (_name: string, enabled: boolean) => {
    isDisabled = !enabled
  },
}))

const { __runHeadlessStreamingForTests } = await import('./print.js')

function startHeadless(input: Stream<string>, initialClient?: MCPServerConnection) {
  const io = new StructuredIO(input)
  let state = getDefaultAppState()
  state = {
    ...state,
    mcp: {
      ...state.mcp,
      clients: [
        initialClient ?? {
          name: 'test-server',
          type: 'disabled',
          config: { type: 'sse', url: 'https://example.com/mcp' },
        },
        {
          name: 'other-server',
          type: 'pending',
          config: { type: 'stdio', command: 'other' },
        },
      ],
      tools: [{ name: 'mcp__test-server__old' } as Tool],
      commands: [
        { name: 'mcp__test-server__old', description: '', argumentHint: '' },
      ],
      resources: { 'test-server': [] },
    },
  }
  const output = __runHeadlessStreamingForTests(
    io,
    [],
    [],
    [],
    [],
    (() => undefined) as unknown as CanUseToolFn,
    {},
    () => state,
    update => {
      state = update(state)
    },
    [],
    { outputFormat: 'stream-json' },
  )
  return { io, output, getState: () => state }
}

async function nextControlResponse(output: AsyncIterable<unknown>) {
  for await (const message of output) {
    if ((message as { type?: string }).type === 'control_response') return message
  }
  throw new Error('Missing control response')
}

afterEach(() => {
  hasConfig = true
  isDisabled = false
  resolveReconnect = undefined
  clearServerCache.mockClear()
  cleanup.mockClear()
})

afterAll(() => {
  mock.module('../services/mcp/client.js', () => mcpClient)
  mock.module('../services/mcp/config.js', () => mcpConfig)
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
})

describe('headless MCP reconnect races', () => {
  test('keeps a server disabled when reconnect resolves after disable', async () => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'reconnect-1',
        request: { subtype: 'mcp_reconnect', serverName: 'test-server' },
      })}\n`,
    )

    await Bun.sleep(0)
    isDisabled = true
    resolveReconnect?.(reconnectResult(connectedClient(), true))

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: { request_id: 'reconnect-1', subtype: 'success' },
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(clearServerCache).not.toHaveBeenCalled()
    expect(getState().mcp.clients[0]?.type).toBe('disabled')
    expect(getState().mcp.clients[1]?.name).toBe('other-server')
    input.done()
  })

  test('keeps a server disabled when enable reconnect loses to disable', async () => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'toggle-1',
        request: {
          subtype: 'mcp_toggle',
          serverName: 'test-server',
          enabled: true,
        },
      })}\n`,
    )

    await Bun.sleep(0)
    isDisabled = true
    resolveReconnect?.(reconnectResult(connectedClient(), true))

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: { request_id: 'toggle-1', subtype: 'success' },
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(clearServerCache).not.toHaveBeenCalled()
    expect(getState().mcp.clients[0]?.type).toBe('disabled')
    expect(getState().mcp.clients[1]?.name).toBe('other-server')
    input.done()
  })

  test.each([
    ['mcp_reconnect', 'missing-reconnect'],
    ['mcp_toggle', 'missing-toggle'],
  ] as const)('rejects %s when the server config is missing', async (subtype, requestId) => {
    hasConfig = false
    const input = new Stream<string>()
    const { output } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: subtype === 'mcp_reconnect'
          ? { subtype, serverName: 'missing-server' }
          : { subtype, serverName: 'missing-server', enabled: false },
      })}\n`,
    )

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: {
        request_id: requestId,
        subtype: 'error',
        error: 'Server not found: missing-server',
      },
    })
    input.done()
  })

  test('disables and clears a connected server', async () => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input, connectedClient())
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'toggle-disable',
        request: {
          subtype: 'mcp_toggle',
          serverName: 'test-server',
          enabled: false,
        },
      })}\n`,
    )

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: { request_id: 'toggle-disable', subtype: 'success' },
    })
    expect(clearServerCache).toHaveBeenCalledWith(
      'test-server',
      { type: 'sse', url: 'https://example.com/mcp' },
    )
    expect(getState().mcp.clients[0]?.type).toBe('disabled')
    expect(getState().mcp.clients[1]?.name).toBe('other-server')
    input.done()
  })

  test.each([
    ['mcp_reconnect', 'reconnect-success'],
    ['mcp_toggle', 'toggle-success'],
  ] as const)('stores a successful %s result', async (subtype, requestId) => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: subtype === 'mcp_reconnect'
          ? { subtype, serverName: 'test-server' }
          : { subtype, serverName: 'test-server', enabled: true },
      })}\n`,
    )

    await Bun.sleep(0)
    resolveReconnect?.(reconnectResult(connectedClient(), true))

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: { request_id: requestId, subtype: 'success' },
    })
    expect(getState().mcp.clients[0]?.type).toBe('connected')
    expect(getState().mcp.tools).toHaveLength(1)
    expect(getState().mcp.commands).toHaveLength(1)
    expect(getState().mcp.resources['test-server']).toHaveLength(1)
    input.done()
  })

  test.each([
    ['mcp_reconnect', 'reconnect-failed'],
    ['mcp_toggle', 'toggle-failed'],
  ] as const)('reports a failed %s result', async (subtype, requestId) => {
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    input.enqueue(
      `${JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: subtype === 'mcp_reconnect'
          ? { subtype, serverName: 'test-server' }
          : { subtype, serverName: 'test-server', enabled: true },
      })}\n`,
    )

    await Bun.sleep(0)
    resolveReconnect?.(reconnectResult(failedClient()))

    await expect(nextControlResponse(output)).resolves.toMatchObject({
      type: 'control_response',
      response: {
        request_id: requestId,
        subtype: 'error',
        error: 'reconnect failed',
      },
    })
    expect(getState().mcp.clients[0]?.type).toBe('failed')
    input.done()
  })
})

test.each(['mcp_reconnect', 'mcp_toggle'] as const)(
  'preserves a later enable while stale %s cleanup is pending',
  async subtype => {
    let finishCleanup!: () => void
    const cleanupFinished = new Promise<void>(resolve => { finishCleanup = resolve })
    cleanup.mockImplementationOnce(() => cleanupFinished)
    const input = new Stream<string>()
    const { output, getState } = startHeadless(input)
    const iterator = output[Symbol.asyncIterator]()
    const nextResponse = async () => {
      while (true) {
        const { value, done } = await iterator.next()
        if (done) throw new Error('Missing control response')
        if (value.type === 'control_response') return value
      }
    }
    try {
      input.enqueue(`${JSON.stringify({
        type: 'control_request',
        request_id: 'old-reconnect',
        request: subtype === 'mcp_reconnect'
          ? { subtype, serverName: 'test-server' }
          : { subtype, serverName: 'test-server', enabled: true },
      })}\n`)
      await Bun.sleep(0)
      isDisabled = true
      resolveReconnect?.(reconnectResult())
      // Cleanup may wait on transport shutdown. It must not postpone the
      // disabled state write into a future enable operation.
      const response = nextResponse()
      const responded = await Promise.race([
        response.then(() => true),
        Bun.sleep(100).then(() => false),
      ])
      expect(responded).toBe(true)
      expect(getState().mcp.clients[0]?.type).toBe('disabled')
      input.enqueue(`${JSON.stringify({
        type: 'control_request',
        request_id: 'new-enable',
        request: { subtype: 'mcp_toggle', serverName: 'test-server', enabled: true },
      })}\n`)
      await Bun.sleep(0)
      const newer = connectedClient()
      resolveReconnect?.(reconnectResult(newer, true))
      await nextResponse()
      expect(isDisabled).toBe(false)
      expect(getState().mcp.clients[0]).toBe(newer)
      finishCleanup()
      await cleanupFinished
      await Bun.sleep(0)
      expect(getState().mcp.clients[0]).toBe(newer)
      expect(getState().mcp.tools).toHaveLength(1)
      expect(getState().mcp.commands).toHaveLength(1)
      expect(getState().mcp.resources['test-server']).toHaveLength(1)
    } finally {
      finishCleanup()
      input.done()
    }
  },
)
