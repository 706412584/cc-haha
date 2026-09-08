import { describe, expect, test } from 'bun:test'
import { handleToolCall as legacyHandleToolCall } from './windowsLegacyToolCalls.js'
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

/**
 * These tools derive their target from whatever is in front, so "we cannot
 * tell what is in front" means we cannot tell what we are about to type into.
 *
 * The surface moved: macOS now speaks the semantic engine, where every action
 * names its target explicitly and a missing `app` is refused outright — there
 * is no frontmost-derived path left to harden (see the second test). The pixel
 * face survives on Windows, and that is where this guard has to live now.
 */
describe('Computer Use input authorization (Windows pixel face)', () => {
  test('fails closed across input actions when the foreground app is unknown', async () => {
    const calls: string[] = []
    const adapter = {
      serverName: 'computer-use-test',
      logger,
      executor: {
        capabilities: {
          screenshotFiltering: 'native',
          platform: 'win32',
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
      const result = await legacyHandleToolCall(adapter, name, args, overrides)

      expect(result).toMatchObject({
        isError: true,
        telemetry: { error_kind: 'state_conflict' },
      })
      expect(calls).toEqual(['prepareForAction', 'getFrontmostApp'])
    }
  })

  test('the macOS engine has no frontmost-derived input to guard', async () => {
    // The stronger form of the same property, and the reason the guard above
    // no longer belongs on darwin: these tool names do not exist there at all,
    // so there is nothing that could act on "whatever is in front". Every
    // surviving action takes an explicit `app` and is refused without one.
    const adapter = {
      serverName: 'computer-use-test',
      logger,
      executor: {
        capabilities: {
          screenshotFiltering: 'native',
          platform: 'darwin',
          hostBundleId: 'com.example.host',
        },
        prepareForAction: async () => [],
        getFrontmostApp: async () => null,
      },
      ensureOsPermissions: async () => ({ granted: true }),
      isDisabled: () => false,
      getSubGates: () => ({}),
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

    for (const name of ['left_click', 'key', 'type', 'mouse_move']) {
      const result = await handleToolCall(adapter, name, {}, overrides)
      expect(result).toMatchObject({ isError: true })
      expect(JSON.stringify(result)).toContain('Unknown computer-use tool')
    }
  })
})
