import { describe, expect, it } from 'vitest'

import { LspLifecycleError, type LSPClient } from './LSPClient.js'
import { createLSPServerInstance } from './LSPServerInstance.js'
import { createLSPServerManager } from './LSPServerManager.js'

function client(overrides: Partial<LSPClient> = {}): LSPClient {
  return {
    capabilities: undefined,
    isInitialized: false,
    start: async () => {},
    initialize: async () => ({ capabilities: {} }),
    sendRequest: async () => undefined as never,
    sendNotification: async () => {},
    onNotification: () => {},
    onRequest: () => {},
    stop: async () => {},
    ...overrides,
  }
}

const config = {
  command: 'language-server',
  args: [],
  extensionToLanguage: { '.ts': 'typescript' },
  transport: 'stdio' as const,
  workspaceFolder: process.cwd(),
}

describe('LSPServerInstance lifecycle reasons', () => {
  it('preserves typed spawn failures', async () => {
    const failure = new LspLifecycleError('spawn-failed', 'Language server failed to spawn')
    const instance = createLSPServerInstance('fixture', config, {
      createClient: () => client({ start: async () => { throw failure } }),
    })
    await expect(instance.start()).rejects.toBe(failure)
    expect(instance.lastError).toBe(failure)
  })

  it('surfaces initialization timeout without inspecting error text', async () => {
    const instance = createLSPServerInstance('fixture', { ...config, startupTimeout: 1 }, {
      createClient: () => client({ initialize: () => new Promise(() => {}) }),
    })
    await expect(instance.start()).rejects.toMatchObject({ reason: 'init-timeout' })
    expect(instance.lastError).toMatchObject({ reason: 'init-timeout' })
  })

  it('records a typed crash and enforces the restart cap', async () => {
    let onCrash: ((error: Error) => void) | undefined
    const instance = createLSPServerInstance('fixture', { ...config, maxRestarts: 0 }, {
      createClient: (_name, callback) => {
        onCrash = callback
        return client({ isInitialized: true })
      },
    })
    await instance.start()
    onCrash?.(new LspLifecycleError('crashed', 'Language server exited'))
    expect(instance.lastError).toMatchObject({ reason: 'crashed' })
    await expect(instance.start()).rejects.toMatchObject({ reason: 'restart-cap-exhausted' })
  })

  it('exposes the typed lifecycle failure through the manager', async () => {
    const manager = createLSPServerManager({ servers: { fixture: config } })
    await manager.initialize()
    const failure = new LspLifecycleError('spawn-failed', 'Language server failed to spawn')
    const instance = manager.getServerForFile('fixture.ts')
    expect(instance).toBeDefined()
    Object.defineProperty(instance, 'lastError', { value: failure })

    expect(manager.getLastLifecycleError('fixture.ts')).toBe(failure)
    expect(manager.getLastLifecycleError('fixture.json')).toBeUndefined()
    await manager.shutdown()
  })
})
