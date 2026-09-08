import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test } from 'bun:test'

import type {
  ComputerExecutor,
  DisplayGeometry,
  ScreenshotResult,
} from './executor.js'
import { createComputerUseMcpServer } from './mcpServer.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
} from './types.js'

const DARWIN_TOOL_NAMES = [
  'click',
  'drag',
  'get_app_state',
  'list_apps',
  'perform_secondary_action',
  'paste',
  'press_key',
  'scroll',
  'select_text',
  'set_value',
  'type_text',
].sort()

const WINDOWS_LEGACY_TOOL_NAMES = [
  'screenshot',
  'zoom',
  'left_click',
  'double_click',
  'triple_click',
  'right_click',
  'middle_click',
  'type',
  'key',
  'scroll',
  'left_click_drag',
  'mouse_move',
  'open_application',
  'switch_display',
  'read_clipboard',
  'write_clipboard',
  'wait',
  'cursor_position',
  'hold_key',
  'left_mouse_down',
  'left_mouse_up',
  'computer_batch',
  'request_teach_access',
  'teach_step',
  'teach_batch',
].sort()

const logger = {
  silly() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function makeSessionContext(
  overrides: Partial<ComputerUseSessionContext> = {},
): ComputerUseSessionContext {
  return {
    getAllowedApps: () => [],
    getGrantFlags: () => ({
      clipboardRead: false,
      clipboardWrite: false,
      systemKeyCombos: false,
    }),
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => undefined,
    onPermissionRequest: async () => {
      throw new Error('per-app permission prompts must not run')
    },
    ...overrides,
  }
}

async function connect(
  adapter: ComputerUseHostAdapter,
  context?: ComputerUseSessionContext,
) {
  const server = createComputerUseMcpServer(adapter, 'pixels', context)
  const client = new Client(
    { name: 'computer-use-platform-routing-test', version: '1.0.0' },
    { capabilities: {} },
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function makeDarwinAdapter(): ComputerUseHostAdapter {
  const executor = {
    capabilities: {
      screenshotFiltering: 'native',
      platform: 'darwin',
      hostBundleId: 'com.example.host',
    },
  } as unknown as ComputerExecutor
  return {
    serverName: 'computer-use',
    logger,
    executor,
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  }
}

function makeWindowsAdapter(calls: string[]): ComputerUseHostAdapter {
  const display: DisplayGeometry = {
    id: 1,
    displayId: 1,
    width: 100,
    height: 80,
    scaleFactor: 1,
    originX: 0,
    originY: 0,
    isPrimary: true,
    label: 'Test Display',
  }
  const screenshot: ScreenshotResult = {
    base64: Buffer.alloc(5_000, 1).toString('base64'),
    width: 100,
    height: 80,
    displayWidth: 100,
    displayHeight: 80,
    displayId: 1,
    originX: 0,
    originY: 0,
  }

  const executor = {
    capabilities: {
      screenshotFiltering: 'none',
      platform: 'win32',
      hostBundleId: 'com.example.host',
      teachMode: true,
    },
    // Deliberately no semantic `engine`: a real Windows executor is pixel-only.
    async prepareForAction() {
      calls.push('prepareForAction')
      return ['com.example.hidden']
    },
    async previewHideSet() {
      return []
    },
    async getDisplaySize() {
      calls.push('getDisplaySize')
      return display
    },
    async listDisplays() {
      calls.push('listDisplays')
      return [display]
    },
    async findWindowDisplays() {
      return []
    },
    async resolvePrepareCapture() {
      throw new Error('auto-target path should not run in this fixture')
    },
    async screenshot() {
      calls.push('screenshot')
      return screenshot
    },
    async zoom() {
      return { base64: screenshot.base64, width: 100, height: 80 }
    },
    async key(keySequence: string) {
      calls.push(`key:${keySequence}`)
    },
    async holdKey(keyNames: string[]) {
      calls.push(`holdKey:${keyNames.join('+')}`)
    },
    async type(text: string) {
      calls.push(`type:${text}`)
    },
    async readClipboard() {
      return ''
    },
    async writeClipboard() {},
    async click(x: number, y: number, button: string, count: number) {
      calls.push(`click:${x},${y},${button},${count}`)
    },
    async mouseDown() {
      calls.push('mouseDown')
    },
    async mouseUp() {
      calls.push('mouseUp')
    },
    async getCursorPosition() {
      return { x: 0, y: 0 }
    },
    async drag() {},
    async moveMouse() {},
    async scroll() {},
    async getFrontmostApp() {
      calls.push('getFrontmostApp')
      return {
        bundleId: 'com.example.allowed',
        displayName: 'Allowed App',
      }
    },
    async appUnderPoint() {
      calls.push('appUnderPoint')
      return {
        bundleId: 'com.example.allowed',
        displayName: 'Allowed App',
      }
    },
    async listInstalledApps() {
      return [
        {
          bundleId: 'com.example.allowed',
          displayName: 'Allowed App',
          path: 'C:\\Program Files\\Allowed App\\Allowed.exe',
        },
      ]
    },
    async listRunningApps() {
      calls.push('listRunningApps')
      return [
        {
          bundleId: 'com.example.hidden',
          displayName: 'Hidden App',
        },
      ]
    },
    async openApp(bundleId: string) {
      calls.push(`openApp:${bundleId}`)
    },
  } as unknown as ComputerExecutor

  return {
    serverName: 'computer-use',
    logger,
    executor,
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: true,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  }
}

describe('Computer Use platform routing', () => {
  test('darwin ListTools advertises the current semantic tools', async () => {
    const connection = await connect(makeDarwinAdapter())
    try {
      const result = await connection.client.listTools()
      expect(result.tools.map(tool => tool.name).sort()).toEqual(DARWIN_TOOL_NAMES)
    } finally {
      await connection.close()
    }
  })

  test('darwin MCP rejects static bad_args before TCC and the async session lock', async () => {
    let tccChecks = 0
    let lockChecks = 0
    let lockAcquires = 0
    const adapter = makeDarwinAdapter()
    adapter.ensureOsPermissions = async () => {
      tccChecks += 1
      return { granted: false }
    }
    const connection = await connect(
      adapter,
      makeSessionContext({
        checkCuLock: async () => {
          lockChecks += 1
          return { holder: undefined, isSelf: false }
        },
        acquireCuLock: async () => {
          lockAcquires += 1
        },
      }),
    )

    try {
      const result = await connection.client.callTool({
        name: 'click',
        arguments: { app: 'Finder', x: 10 },
      })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('click x and y must be provided together'),
        }),
      ])
      expect(tccChecks).toBe(0)
      expect(lockChecks).toBe(0)
      expect(lockAcquires).toBe(0)
    } finally {
      await connection.close()
    }
  })

  test('win32 ListTools advertises pixel controls without app-authorization tools', async () => {
    const connection = await connect(makeWindowsAdapter([]))
    try {
      const result = await connection.client.listTools()
      expect(result.tools.map(tool => tool.name).sort()).toEqual(
        WINDOWS_LEGACY_TOOL_NAMES,
      )
      expect(result.tools.some(tool => tool.name === 'get_app_state')).toBe(false)
      expect(result.tools.some(tool => tool.name === 'request_access')).toBe(false)
      expect(result.tools.some(tool => tool.name === 'list_granted_applications')).toBe(false)
    } finally {
      await connection.close()
    }
  })

  test('win32 MCP calls reach the legacy pixel/Python executor surface', async () => {
    const calls: string[] = []
    const connection = await connect(
      makeWindowsAdapter(calls),
      makeSessionContext(),
    )
    try {
      expect((await connection.client.callTool({ name: 'screenshot' })).isError).toBeFalsy()
      expect((await connection.client.callTool({ name: 'screenshot' })).isError).toBeFalsy()
      expect(
        (
          await connection.client.callTool({
            name: 'left_click',
            arguments: { coordinate: [10, 20] },
          })
        ).isError,
      ).toBeFalsy()
      expect(
        (
          await connection.client.callTool({
            name: 'key',
            arguments: { text: 'ctrl+a' },
          })
        ).isError,
      ).toBeFalsy()
      expect(
        (
          await connection.client.callTool({
            name: 'type',
            arguments: { text: 'ok' },
          })
        ).isError,
      ).toBeFalsy()

      expect(calls).toContain('screenshot')
      expect(calls).not.toContain('listRunningApps')
      expect(calls).toContain('click:10,20,left,1')
      expect(calls).toContain('key:ctrl+a')
      expect(calls).toContain('type:ok')
      expect(calls).not.toContain('type:o')
      expect(calls).not.toContain('type:k')

      const blockedKey = await connection.client.callTool({
        name: 'key',
        arguments: { text: 'ctrl+alt+delete' },
      })
      const blockedHold = await connection.client.callTool({
        name: 'hold_key',
        arguments: { text: 'alt+f4', duration: 0.1 },
      })
      expect(blockedKey.isError).toBe(true)
      expect(blockedHold.isError).toBe(true)
      expect(calls).not.toContain('key:ctrl+alt+delete')
      expect(calls).not.toContain('holdKey:alt+f4')

      const opened = await connection.client.callTool({
        name: 'open_application',
        arguments: { app: 'Allowed App' },
      })
      expect(opened.isError).toBeFalsy()
      expect(calls).toContain('openApp:com.example.allowed')
    } finally {
      await connection.close()
    }
  })

  test('win32 binder preserves legacy lock deferral and clears stale mouse state on acquire', async () => {
    // Seed the legacy module's cross-call drag state, as if a prior session
    // disconnected after left_mouse_down but before left_mouse_up.
    const seedCalls: string[] = []
    const seed = await connect(
      makeWindowsAdapter(seedCalls),
      makeSessionContext(),
    )
    try {
      const result = await seed.client.callTool({ name: 'left_mouse_down' })
      expect(result.isError).toBeFalsy()
      expect(seedCalls).toContain('mouseDown')
    } finally {
      await seed.close()
    }

    let lockHeld = false
    let acquireCount = 0
    const calls: string[] = []
    const connection = await connect(
      makeWindowsAdapter(calls),
      makeSessionContext({
        checkCuLock: async () =>
          lockHeld
            ? { holder: 'this-session', isSelf: true }
            : { holder: undefined, isSelf: false },
        acquireCuLock: async () => {
          acquireCount += 1
          lockHeld = true
        },
      }),
    )
    try {
      // The first action takes the lock and must clear the prior session's
      // module-level mouseButtonHeld flag before dispatching.
      const screenshot = await connection.client.callTool({ name: 'screenshot' })
      expect(screenshot.isError).toBeFalsy()
      expect(acquireCount).toBe(1)

      const down = await connection.client.callTool({ name: 'left_mouse_down' })
      expect(down.isError).toBeFalsy()
      expect(calls).toContain('mouseDown')
      const up = await connection.client.callTool({ name: 'left_mouse_up' })
      expect(up.isError).toBeFalsy()
      expect(calls).toContain('mouseUp')
    } finally {
      await connection.close()
    }
  })
})
