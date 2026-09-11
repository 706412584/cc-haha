import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ConnectedMCPServer } from './types.js'

const appStateModule = { ...await import('../../state/AppState.js') }
const clientModule = { ...await import('./client.js') }
const configModule = { ...await import('./config.js') }

let state: AppState
let closeHandler: ((name: string, client: ConnectedMCPServer['client']) => void) | undefined
let isDisabled = true
let transportType: 'sse' | 'stdio' = 'sse'
const reconnectMcpServerImpl = mock(async () => ({
  name: 'test-server',
  client: connectedServer(),
  tools: [],
  commands: [],
  resources: [],
}))

const store = {
  getState: () => state,
  setState: (updater: (previous: AppState) => AppState) => {
    state = updater(state)
  },
  subscribe: () => () => {},
}

mock.module('../../state/AppState.js', () => ({
  ...appStateModule,
  useAppStateStore: () => store,
  useSetAppState: () => store.setState,
  useAppState: (selector: (current: AppState) => unknown) => selector(state),
}))

mock.module('./client.js', () => ({
  ...clientModule,
  setMcpConnectionClosedHandler: (handler: typeof closeHandler) => {
    closeHandler = handler
  },
  getMcpToolsCommandsAndResources: async () => {},
  reconnectMcpServerImpl,
}))

mock.module('./config.js', () => ({
  ...configModule,
  getClaudeCodeMcpConfigs: async () => ({ servers: {}, errors: [] }),
  fetchClaudeAIMcpConfigsIfEligible: async () => ({}),
  doesEnterpriseMcpConfigExist: () => false,
  isMcpServerDisabled: () => isDisabled,
}))

const { useManageMCPConnections } = await import('./useManageMCPConnections.js')

let actions: ReturnType<typeof useManageMCPConnections>

function Harness() {
  actions = useManageMCPConnections(undefined)
  return null
}

function connectedServer(): ConnectedMCPServer {
  return {
    name: 'test-server',
    type: 'connected',
    client: {} as ConnectedMCPServer['client'],
    capabilities: {},
    config:
      transportType === 'sse'
        ? { type: 'sse', url: 'https://example.com/mcp' }
        : { type: 'stdio', command: 'test' },
    cleanup: async () => {},
  }
}

beforeEach(() => {
  closeHandler = undefined
  isDisabled = true
  transportType = 'sse'
  reconnectMcpServerImpl.mockClear()
  reconnectMcpServerImpl.mockImplementation(async () => ({
    name: 'test-server',
    client: connectedServer(),
    tools: [],
    commands: [],
    resources: [],
  }))
  state = getDefaultAppState()
  state = {
    ...state,
    mcp: {
      ...state.mcp,
      clients: [connectedServer()],
    },
  }
})

afterAll(() => {
  mock.module('../../state/AppState.js', () => appStateModule)
  mock.module('./client.js', () => clientModule)
  mock.module('./config.js', () => configModule)
})

afterEach(() => {
  closeHandler = undefined
})

describe('useManageMCPConnections close lifecycle', () => {
  test('marks a disabled server after its connection closes', async () => {
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    expect(closeHandler).toBeDefined()
    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(20)

    expect(state.mcp.clients).toContainEqual({
      name: 'test-server',
      type: 'disabled',
      config: { type: 'sse', url: 'https://example.com/mcp' },
    })
    app.unmount()
  })

  test('reconnects an enabled remote server after its connection closes', async () => {
    isDisabled = false
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(20)

    expect(reconnectMcpServerImpl).toHaveBeenCalledWith(
      'test-server',
      { type: 'sse', url: 'https://example.com/mcp' },
    )
    expect(state.mcp.clients[0]?.type).toBe('connected')
    app.unmount()
  })

  test('marks local transports failed without reconnecting', async () => {
    isDisabled = false
    transportType = 'stdio'
    state = {
      ...state,
      mcp: { ...state.mcp, clients: [connectedServer()] },
    }
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(20)

    expect(reconnectMcpServerImpl).not.toHaveBeenCalled()
    expect(state.mcp.clients[0]?.type).toBe('failed')
    app.unmount()
  })

  test('stops automatic reconnect when disable wins before the attempt', async () => {
    isDisabled = false
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    isDisabled = true
    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(20)

    expect(reconnectMcpServerImpl).not.toHaveBeenCalled()
    app.unmount()
  })

  test('records the final automatic reconnect failure', async () => {
    isDisabled = false
    reconnectMcpServerImpl.mockImplementation(async () => ({
      name: 'test-server',
      client: {
        name: 'test-server',
        type: 'failed',
        config: { type: 'sse', url: 'https://example.com/mcp' },
        error: 'reconnect failed',
      },
      tools: [],
      commands: [],
      resources: [],
    }))
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(15_100)

    expect(reconnectMcpServerImpl).toHaveBeenCalledTimes(5)
    expect(state.mcp.clients[0]?.type).toBe('failed')
    app.unmount()
  }, 20_000)

  test('records the final automatic reconnect exception', async () => {
    isDisabled = false
    reconnectMcpServerImpl.mockRejectedValue(new Error('network failed'))
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)

    closeHandler?.('test-server', (state.mcp.clients[0] as ConnectedMCPServer).client)
    await Bun.sleep(15_100)

    expect(reconnectMcpServerImpl).toHaveBeenCalledTimes(5)
    expect(state.mcp.clients[0]?.type).toBe('failed')
    app.unmount()
  }, 20_000)

  test('unregisters the close handler on unmount', async () => {
    const app = render(<Harness />, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await Bun.sleep(0)
    expect(closeHandler).toBeDefined()

    app.unmount()
    await Bun.sleep(0)

    expect(closeHandler).toBeUndefined()
  })
})


test('ignores a previous connection close after an explicit reconnect', async () => {
  isDisabled = false
  const previous = state.mcp.clients[0] as ConnectedMCPServer
  const app = render(<Harness />, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitOnCtrlC: false,
    patchConsole: false,
  })
  try {
    await Bun.sleep(0)
    await actions.reconnectMcpServer('test-server')
    await Bun.sleep(20)
    const current = state.mcp.clients[0] as ConnectedMCPServer
    expect(current.type).toBe('connected')
    expect(current.client).not.toBe(previous.client)
    expect(reconnectMcpServerImpl).toHaveBeenCalledTimes(1)
    closeHandler?.('test-server', previous.client)
    await Bun.sleep(20)
    expect(reconnectMcpServerImpl).toHaveBeenCalledTimes(1)
    expect(state.mcp.clients[0]).toBe(current)
  } finally {
    app.unmount()
  }
})
