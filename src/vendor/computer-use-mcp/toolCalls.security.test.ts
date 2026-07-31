import { describe, expect, test } from 'bun:test'
import { handleToolCall } from './toolCalls.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
} from './types.js'

const logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  silly: () => {},
}

describe('Computer Use input authorization', () => {
  test('fails closed across input actions when the foreground app is unknown', async () => {
    const calls: string[] = []
    const adapter = {
      serverName: 'computer-use-test',
      logger,
      executor: {
        capabilities: {
          screenshotFiltering: 'native',
          platform: 'darwin',
          hostBundleId: 'com.example.host',
        },
        prepareForAction: async () => {
          calls.push('prepareForAction')
          return []
        },
        getFrontmostApp: async () => {
          calls.push('getFrontmostApp')
          return null
        },
        key: async () => {
          calls.push('key')
        },
      },
      ensureOsPermissions: async () => ({ granted: true }),
      isDisabled: () => false,
      getSubGates: () => ({
        pixelValidation: false,
        clipboardPasteMultiline: true,
        mouseAnimation: true,
        hideBeforeAction: true,
        autoTargetDisplay: true,
        clipboardGuard: true,
      }),
      getAutoUnhideEnabled: () => true,
    } as unknown as ComputerUseHostAdapter
    const overrides: ComputerUseOverrides = {
      allowedApps: [],
      grantFlags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      userDeniedBundleIds: [],
      coordinateMode: 'pixels',
    }

    const actions: Array<[string, Record<string, unknown>]> = [
      ['key', { text: 'a' }],
      ['type', { text: 'a' }],
      ['left_click', { coordinate: [10, 10] }],
      ['scroll', {
        coordinate: [10, 10],
        scroll_direction: 'down',
        scroll_amount: 1,
      }],
      ['left_click_drag', { coordinate: [10, 10] }],
      ['mouse_move', { coordinate: [10, 10] }],
      ['hold_key', { text: 'shift', duration: 0 }],
      ['left_mouse_down', {}],
    ]

    for (const [name, args] of actions) {
      calls.length = 0
      const result = await handleToolCall(adapter, name, args, overrides)

      expect(result).toMatchObject({
        isError: true,
        telemetry: { error_kind: 'state_conflict' },
      })
      expect(calls).toEqual(['prepareForAction', 'getFrontmostApp'])
    }
  })
})
