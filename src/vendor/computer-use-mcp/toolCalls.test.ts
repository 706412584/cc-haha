import { describe, expect, test } from 'bun:test'

import type {
  AppStateResult,
  AppTarget,
  CodexComputerEngine,
  ComputerExecutor,
  ResolvedAppTarget,
  SetValueResult,
} from './executor.js'
import {
  _test,
  CUA_APP_VERSION,
  defersLockAcquire,
  frameAppStateEnvelope,
  handleToolCall,
  resetMouseButtonHeld,
} from './toolCalls.js'
import { buildComputerUseTools } from './tools.js'
import { COMPUTER_USE_INSTRUCTIONS } from './instructions.js'
import { isSystemKeyCombo } from './keyBlocklist.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
} from './types.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface EngineCall {
  method: string
  args: unknown
  callArgs: unknown[]
}

/** Records every engine call and lets each method's return be scripted. */
function makeEngine(
  overrides: Partial<Record<keyof CodexComputerEngine, (...a: any[]) => any>> = {},
): { engine: CodexComputerEngine; calls: EngineCall[] } {
  const calls: EngineCall[] = []
  const record =
    (method: keyof CodexComputerEngine, fallback: (...a: any[]) => any) =>
    (...a: any[]) => {
      calls.push({ method, args: a[0], callArgs: a })
      const fn = overrides[method]
      return (fn ?? fallback)(...a)
    }

  const defaultState: AppStateResult = {
    pid: 1234,
    appName: 'Finder',
    bundleId: 'com.apple.finder',
    windowTitle: 'Docs',
    elementCount: 3,
    truncated: false,
    durationMs: 5,
    axText:
      'App=com.apple.finder (pid 1234)\nWindow: "Docs", App: Finder.\n0 standard window Docs',
  }

  const defaultResolvedTarget = (target: AppTarget): ResolvedAppTarget => {
    const running = (
      value: Omit<ResolvedAppTarget, 'pid' | 'executablePath' | 'launchTime' | 'processIdentity'>,
      pid: number,
    ): ResolvedAppTarget => {
      const executablePath = `${value.path ?? '/Applications/Test.app'}/Contents/MacOS/Test`
      const launchTime = 1000 + pid
      return {
        ...value,
        pid,
        executablePath,
        launchTime,
        processIdentity: {
          pid,
          bundleId: value.bundleId,
          executablePath,
          launchTime,
        },
      }
    }
    const requested = target.app ?? (target.pid === undefined ? '' : String(target.pid))
    if (target.pid !== undefined) {
      return running({
        bundleId: `com.test.pid-${target.pid}`,
        displayName: `PID ${target.pid}`,
        path: `/Applications/PID-${target.pid}.app`,
      }, target.pid)
    }
    const identities: Record<string, Omit<ResolvedAppTarget, 'pid'>> = {
      Finder: {
        bundleId: 'com.apple.finder',
        displayName: 'Finder',
        path: '/System/Library/CoreServices/Finder.app',
      },
      TextEdit: {
        bundleId: 'com.apple.TextEdit',
        displayName: 'TextEdit',
        path: '/System/Applications/TextEdit.app',
      },
      'Activity Monitor': {
        bundleId: 'com.apple.ActivityMonitor',
        displayName: 'Activity Monitor',
        path: '/System/Applications/Utilities/Activity Monitor.app',
      },
      X: {
        bundleId: 'com.test.X',
        displayName: 'X',
        path: '/Applications/X.app',
      },
    }
    const identity = identities[requested]
    if (identity) return running(identity, 1234)
    return running({
      bundleId: requested.includes('.') ? requested : `com.test.${requested}`,
      displayName: requested,
      path: requested.endsWith('.app') ? requested : `/Applications/${requested}.app`,
    }, 1234)
  }

  const engine: CodexComputerEngine = {
    listApps: record('listApps', async () => 'Finder — com.apple.finder [running]'),
    resolveTarget: record('resolveTarget', async (target: AppTarget) => defaultResolvedTarget(target)),
    getAppState: record('getAppState', async (_t: AppTarget) => defaultState),
    click: record('click', async () => {}),
    setValue: record('setValue', async (): Promise<SetValueResult> => ({ before: 'a', after: 'b' })),
    performSecondaryAction: record('performSecondaryAction', async () => {}),
    scroll: record('scroll', async () => {}),
    drag: record('drag', async () => {}),
    pressKey: record('pressKey', async () => {}),
    typeText: record('typeText', async () => {}),
    paste: record('paste', async () => {}),
    selectText: record('selectText', async () => {}),
  }
  return { engine, calls }
}

function makeAdapter(opts: {
  engine?: CodexComputerEngine
  disabled?: boolean
  granted?: boolean
  platform?: 'darwin' | 'win32'
  hostBundleId?: string
} = {}): ComputerUseHostAdapter {
  const executor = {
    capabilities: {
      screenshotFiltering: 'native',
      platform: opts.platform ?? 'darwin',
      hostBundleId: opts.hostBundleId ?? 'com.test.host',
    },
    engine: opts.engine,
  } as unknown as ComputerExecutor

  return {
    serverName: 'computer-use',
    logger: {
      silly() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    executor,
    ensureOsPermissions: async () =>
      opts.granted === false
        ? { granted: false, accessibility: false, screenRecording: false }
        : { granted: true },
    isDisabled: () => opts.disabled ?? false,
    getAutoUnhideEnabled: () => true,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    cropRawPatch: () => null,
  }
}

function baseOverrides(
  extra: Partial<ComputerUseOverrides> = {},
): ComputerUseOverrides {
  return {
    allowedApps: [
      { bundleId: 'com.apple.finder', displayName: 'Finder', grantedAt: 1 },
      { bundleId: 'com.apple.TextEdit', displayName: 'TextEdit', grantedAt: 1 },
      { bundleId: 'com.apple.ActivityMonitor', displayName: 'Activity Monitor', grantedAt: 1 },
      { bundleId: 'com.test.X', displayName: 'X', grantedAt: 1 },
    ],
    grantFlags: {},
    coordinateMode: 'pixels',
    userDeniedBundleIds: [],
    ...extra,
  } as ComputerUseOverrides
}

function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content.find(c => c.type === 'text')?.text ?? ''
}

function imageBlocks(result: { content: unknown }): Array<{ data?: string; mimeType?: string }> {
  const content = result.content as Array<{ type: string; data?: string; mimeType?: string }>
  return content.filter(c => c.type === 'image')
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

describe('buildComputerUseTools — current Codex tool face', () => {
  const tools = buildComputerUseTools()

  test('exposes the current Codex tools, including explicit paste', () => {
    expect(tools.map(t => t.name).sort()).toEqual(
      [
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
      ].sort(),
    )
  })

  test('no legacy pixel/permission/teach tools remain', () => {
    const names = new Set(tools.map(t => t.name))
    for (const gone of [
      'request_access',
      'screenshot',
      'left_click',
      'double_click',
      'computer_batch',
      'teach_step',
      'key',
      'type',
    ]) {
      expect(names.has(gone)).toBe(false)
    }
  })

  test('every targeted tool requires an explicit app while list_apps does not', () => {
    for (const tool of tools) {
      const required = ((tool.inputSchema as any).required ?? []) as string[]
      if (tool.name === 'list_apps') {
        expect(required).not.toContain('app')
      } else {
        expect(required).toContain('app')
      }
    }
  })

  test('click accepts an opaque string handle and requires only its target app', () => {
    const click = tools.find(t => t.name === 'click')!
    const schema = click.inputSchema as any
    expect(schema.properties.element_index.type).toBe('string')
    expect(schema.properties.element_index.description).toContain('Opaque handle')
    // click can target by point OR index, so neither is individually required.
    expect(schema.required ?? []).toEqual(['app'])
    // That either/or is deliberately NOT a schema-level `anyOf`: Grok rejects a
    // root union outright (see toolSchemaPortability.test.ts). The rule lives in
    // the description for the model and in toolCalls for enforcement.
    expect(schema.anyOf).toBeUndefined()
    expect(click.description).toContain('element_index OR both x and y')
  })

  test('get_app_state exposes the official disableDiff switch plus the legacy alias', () => {
    const state = tools.find(t => t.name === 'get_app_state')!
    const schema = state.inputSchema as any
    expect(schema.properties.disableDiff.type).toBe('boolean')
    expect(schema.properties.disable_diff.type).toBe('boolean')
    expect(schema.required ?? []).not.toContain('disableDiff')
    expect(schema.required ?? []).not.toContain('disable_diff')
  })

  test('numeric bounds match the native click and scroll validators', () => {
    const click = tools.find(t => t.name === 'click')!.inputSchema as any
    expect(click.properties.click_count).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 3,
    })

    const scroll = tools.find(t => t.name === 'scroll')!.inputSchema as any
    expect(scroll.properties.pages).toMatchObject({
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 10,
    })
    // No root union — enforced at call time instead. See click above.
    expect(scroll.anyOf).toBeUndefined()
  })

  test('mouse button and direction schemas expose official short aliases', () => {
    const click = tools.find(t => t.name === 'click')!.inputSchema as any
    expect(click.properties.mouse_button.enum).toEqual(
      expect.arrayContaining(['left', 'right', 'middle', 'l', 'r', 'm']),
    )

    const scroll = tools.find(t => t.name === 'scroll')!.inputSchema as any
    expect(scroll.properties.direction.enum).toEqual(
      expect.arrayContaining(['up', 'down', 'left', 'right', 'u', 'd', 'l', 'r']),
    )
  })

  test('action descriptions require an explicit get_app_state refresh', () => {
    for (const name of [
      'click',
      'perform_secondary_action',
      'set_value',
      'select_text',
      'scroll',
      'drag',
      'press_key',
      'type_text',
      'paste',
    ]) {
      const description = tools.find(t => t.name === name)!.description ?? ''
      expect(description).toContain('get_app_state')
      expect(description).not.toContain('refreshed app state')
    }
  })

  test('set_value / perform_secondary_action require element_index', () => {
    const sv = tools.find(t => t.name === 'set_value')!.inputSchema as any
    expect(sv.required).toContain('element_index')
    expect(sv.required).toContain('value')
    const psa = tools.find(t => t.name === 'perform_secondary_action')!
      .inputSchema as any
    expect(psa.required).toContain('element_index')
    expect(psa.required).toContain('action')
  })

  test('select_text requires element_index + text and supports disambiguation', () => {
    const schema = tools.find(t => t.name === 'select_text')!.inputSchema as any
    expect(schema.required).toEqual(['app', 'element_index', 'text'])
    expect(schema.properties.element_index.type).toBe('string')
    expect(schema.properties.selection_type.enum).toEqual([
      'text',
      'cursor_before',
      'cursor_after',
    ])
    expect(schema.properties).toHaveProperty('prefix')
    expect(schema.properties).toHaveProperty('suffix')
  })

  test('drag advertises official flat coordinates and the nested compatibility alias', () => {
    const drag = tools.find(t => t.name === 'drag')!.inputSchema as any
    expect(drag.required).toEqual(['app'])
    // No root union — parsePoint enforces "from{x,y} or from_x/from_y" at call
    // time. See click above.
    expect(drag.anyOf).toBeUndefined()
    expect(drag.properties).toMatchObject({
      from_x: { type: 'number' },
      from_y: { type: 'number' },
      to_x: { type: 'number' },
      to_y: { type: 'number' },
    })
    expect(drag.properties.from.required).toEqual(['x', 'y'])
  })

  test('point actions describe coordinates in the latest app-state screenshot space', () => {
    const coordinateProperties = [
      ['click', 'x'],
      ['click', 'y'],
      ['scroll', 'x'],
      ['scroll', 'y'],
      ['drag', 'from_x'],
      ['drag', 'from_y'],
      ['drag', 'to_x'],
      ['drag', 'to_y'],
    ] as const

    for (const [toolName, propertyName] of coordinateProperties) {
      const schema = tools.find(tool => tool.name === toolName)!.inputSchema as any
      const description = schema.properties[propertyName].description as string
      expect(description).toContain('latest get_app_state screenshot')
      expect(description.toLowerCase()).toContain('pixel')
      expect(description).not.toContain('Global')
      expect(schema.properties[propertyName].minimum).toBe(0)
    }
  })

  test('list_apps describes the native alphabetical running-app order honestly', () => {
    const description = tools.find(t => t.name === 'list_apps')!.description ?? ''
    expect(description).toContain('alphabetical')
    expect(description).not.toContain('most-recently-used')
  })

  test('every schema rejects unknown properties', () => {
    // Without this a drifted parameter name is silently dropped and the tool
    // runs with its default — which is how `selection` vs `selection_type`
    // produced a wrong action with no error.
    for (const tool of tools) {
      expect((tool.inputSchema as any).additionalProperties, tool.name).toBe(false)
    }
  })

  test('annotations mark exactly the two read-only tools as read-only', () => {
    for (const tool of tools) {
      const annotations = (tool as any).annotations
      expect(annotations, tool.name).toBeDefined()
      const readOnly = tool.name === 'list_apps' || tool.name === 'get_app_state'
      expect(annotations.readOnlyHint, tool.name).toBe(readOnly)
      expect(annotations.idempotentHint, tool.name).toBe(readOnly)
      expect(annotations.destructiveHint, tool.name).toBe(false)
      expect(annotations.openWorldHint, tool.name).toBe(false)
    }
  })

  test('select_text advertises the official `selection` name plus the alias', () => {
    const schema = tools.find(t => t.name === 'select_text')!.inputSchema as any
    expect(schema.properties.selection.enum).toEqual([
      'text',
      'cursor_before',
      'cursor_after',
    ])
    expect(schema.properties.selection_type.enum).toEqual([
      'text',
      'cursor_before',
      'cursor_after',
    ])
    expect(schema.properties.selection_type.description).toContain('alias')
  })

  test('legacy signature (caps, coordMode, installedApps) is still accepted', () => {
    const withArgs = buildComputerUseTools(
      { screenshotFiltering: 'native', platform: 'darwin' },
      'normalized_0_100',
      ['Finder', 'Slack'],
    )
    expect(withArgs).toHaveLength(11)
  })
})

// ---------------------------------------------------------------------------
// Envelope framing (blueprint §7)
// ---------------------------------------------------------------------------

describe('frameAppStateEnvelope', () => {
  const axText =
    'App=com.apple.finder (pid 1106)\nWindow: "Docs", App: Finder.\n\t0 standard window Docs, Secondary Actions: Raise\n\nThe focused UI element is 0 standard window Docs.'

  test('wraps the Swift axText in banner + <app_state> tags', () => {
    const out = frameAppStateEnvelope({
      pid: 1106,
      elementCount: 1,
      truncated: false,
      durationMs: 4,
      axText,
    })
    const text = textOf(out)
    expect(text.startsWith(`Computer Use state (CUA App Version: ${CUA_APP_VERSION})`)).toBe(true)
    expect(text).toContain('<app_state>')
    expect(text).toContain('</app_state>')
    // The Swift focus tail line is preserved inside the app_state block.
    expect(text).toContain('The focused UI element is 0 standard window Docs.')
    // App=… line lives between the open/close tags.
    const inner = text.split('<app_state>\n')[1].split('\n</app_state>')[0]
    expect(inner.startsWith('App=com.apple.finder (pid 1106)')).toBe(true)
  })

  test('omits app_specific_instructions when none', () => {
    const out = frameAppStateEnvelope({
      pid: 1, elementCount: 0, truncated: false, durationMs: 1, axText: 'App=x (pid 1)',
    })
    expect(textOf(out)).not.toContain('<app_specific_instructions>')
  })

  test('injects app_specific_instructions block when present', () => {
    const out = frameAppStateEnvelope({
      pid: 1, elementCount: 0, truncated: false, durationMs: 1,
      axText: 'App=x (pid 1)',
      appInstructions: '## Clock\nUse the picker.',
    })
    const text = textOf(out)
    expect(text).toContain('<app_specific_instructions>\n## Clock\nUse the picker.\n</app_specific_instructions>')
    // Order: banner → instructions → app_state
    expect(text.indexOf('<app_specific_instructions>')).toBeLessThan(text.indexOf('<app_state>'))
  })

  test('attaches a PNG image block when a screenshot came back', () => {
    const out = frameAppStateEnvelope({
      pid: 1, elementCount: 0, truncated: false, durationMs: 1, axText: 'App=x (pid 1)',
      screenshot: { base64: 'AAAA', width: 100, height: 50 },
    })
    const imgs = imageBlocks(out)
    expect(imgs).toHaveLength(1)
    expect(imgs[0].mimeType).toBe('image/png')
    expect(imgs[0].data).toBe('AAAA')
  })

  test('no image block when screenshot is absent (capture failed)', () => {
    const out = frameAppStateEnvelope({
      pid: 1, elementCount: 0, truncated: false, durationMs: 1, axText: 'App=x (pid 1)',
    })
    expect(imageBlocks(out)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// opaque element handle + arg parsing helpers
// ---------------------------------------------------------------------------

describe('arg parsing helpers', () => {
  test('element handle remains opaque through dispatch', async () => {
    const { engine, calls } = makeEngine()

    const result = await handleToolCall(
      makeAdapter({ engine }),
      'click',
      { app: 'Finder', element_index: 'g17:4' },
      baseOverrides(),
    )

    expect(result.isError).toBeFalsy()
    expect(calls.find(call => call.method === 'click')?.args).toMatchObject({
      index: 'g17:4',
    })
  })

  test('parseElementHandle: preserves canonical opaque strings', () => {
    expect(_test.parseElementHandle('g17:42')).toBe('g17:42')
    expect(_test.parseElementHandle(undefined)).toBeUndefined()
    expect(_test.parseElementHandle('')).toBeUndefined()
  })

  test('parseElementHandle: bare numeric values and malformed strings fail closed', () => {
    expect(() => _test.parseElementHandle('42')).toThrow()
    expect(() => _test.parseElementHandle(42)).toThrow()
    expect(() => _test.parseElementHandle('g17:04')).toThrow()
    expect(() => _test.parseElementHandle(' g17:4')).toThrow()
  })

  test('parseMouseButton: names and numeric 1..5', () => {
    expect(_test.parseMouseButton('right')).toBe('right')
    expect(_test.parseMouseButton(3)).toBe('right')
    expect(_test.parseMouseButton(1)).toBe('left')
    expect(_test.parseMouseButton(5)).toBe('forward')
    expect(_test.parseMouseButton(undefined)).toBeUndefined()
    expect(() => _test.parseMouseButton('sideways')).toThrow()
    expect(() => _test.parseMouseButton(9)).toThrow()
  })

  test('parseTarget: explicit numeric string → pid, else name', () => {
    expect(_test.parseTarget({ app: '988' })).toEqual({ pid: 988 })
    expect(_test.parseTarget({ app: 'Finder' })).toEqual({ app: 'Finder' })
    expect(_test.parseTarget({ app: 'com.apple.finder' })).toEqual({ app: 'com.apple.finder' })
  })

  test('parseTarget: missing, empty, and non-string app values fail closed', () => {
    for (const args of [
      {},
      { app: '' },
      { app: '   ' },
      { app: 988 },
      { app: null },
      { app: {} },
    ]) {
      expect(() => _test.parseTarget(args)).toThrow()
    }
  })

  test('parsePoint: nested and flat forms', () => {
    expect(_test.parsePoint({ from: { x: 1, y: 2 } }, 'from', 'from_x', 'from_y')).toEqual({ x: 1, y: 2 })
    expect(_test.parsePoint({ from_x: 3, from_y: 4 }, 'from', 'from_x', 'from_y')).toEqual({ x: 3, y: 4 })
    expect(() => _test.parsePoint({}, 'from', 'from_x', 'from_y')).toThrow()
  })

  test('policyDenyMessage: terminals refused with Codex text, normal apps pass', () => {
    const msg = _test.policyDenyMessage({
      bundleId: 'com.googlecode.iterm2',
      displayName: 'iTerm2',
    }, 'com.googlecode.iterm2')
    expect(msg).toBe("Computer Use is not allowed to use the app 'com.googlecode.iterm2' for safety reasons.")
    expect(_test.policyDenyMessage({
      bundleId: 'com.apple.finder',
      displayName: 'Finder',
    })).toBeUndefined()
  })

  test('policyDenyMessage permanently denies the host and helper while a host override only adds', () => {
    const customHostBundleId = 'com.example.custom-host'
    for (const bundleId of [
      'com.claude-code-haha.desktop',
      'dev.cchaha.cu-helper',
      customHostBundleId,
    ]) {
      expect(_test.policyDenyMessage({
        bundleId,
        displayName: bundleId,
      }, bundleId, customHostBundleId)).toBe(
        `Computer Use is not allowed to use the app '${bundleId}' for safety reasons.`,
      )
    }

    expect(_test.policyDenyMessage({
      bundleId: 'com.apple.TextEdit',
      displayName: 'TextEdit',
    }, 'TextEdit', customHostBundleId)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Dispatch: gates
// ---------------------------------------------------------------------------

describe('handleToolCall — gates', () => {
  test('kill switch short-circuits before the engine', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(makeAdapter({ engine, disabled: true }), 'list_apps', {}, baseOverrides())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('disabled in Settings')
    expect(calls).toHaveLength(0)
  })

  test('TCC ungranted short-circuits with permission hint', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(makeAdapter({ engine, granted: false }), 'get_app_state', { app: 'Finder' }, baseOverrides())
    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('tcc_not_granted')
    expect(calls).toHaveLength(0)
  })

  test('CU lock held by another session is refused', async () => {
    const { engine } = makeEngine()
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'click',
      { app: 'Finder', element_index: 'g17:1' },
      baseOverrides({ checkCuLock: () => ({ holder: 'other', isSelf: false }) }) as any,
    )
    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('cu_lock_held')
  })

  test('get_app_state acquires the lock; list_apps defers', async () => {
    expect(defersLockAcquire('list_apps')).toBe(true)
    expect(defersLockAcquire('get_app_state')).toBe(false)
    expect(defersLockAcquire('click')).toBe(false)

    let acquired = 0
    const { engine } = makeEngine()
    await handleToolCall(
      makeAdapter({ engine }),
      'get_app_state',
      { app: 'Finder' },
      baseOverrides({
        checkCuLock: () => ({ holder: undefined, isSelf: false }),
        acquireCuLock: () => {
          acquired++
        },
      }) as any,
    )
    expect(acquired).toBe(1)

    acquired = 0
    await handleToolCall(
      makeAdapter({ engine }),
      'list_apps',
      {},
      baseOverrides({
        checkCuLock: () => ({ holder: undefined, isSelf: false }),
        acquireCuLock: () => {
          acquired++
        },
      }) as any,
    )
    expect(acquired).toBe(0)
  })

  test('safety denylist refuses a terminal before the engine', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(makeAdapter({ engine }), 'get_app_state', { app: 'com.googlecode.iterm2' }, baseOverrides())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('for safety reasons')
    expect(calls.map(call => call.method)).toEqual(['resolveTarget'])
  })

  test('configured host bundle is refused before permission or engine dispatch', async () => {
    const customHostBundleId = 'com.example.custom-host'
    const { engine, calls } = makeEngine({
      resolveTarget: async () => ({
        pid: 812,
        bundleId: customHostBundleId,
        displayName: 'Custom Host',
        path: '/Applications/Custom Host.app',
        executablePath: '/Applications/Custom Host.app/Contents/MacOS/Custom Host',
        launchTime: 1812,
        processIdentity: {
          pid: 812,
          bundleId: customHostBundleId,
          executablePath: '/Applications/Custom Host.app/Contents/MacOS/Custom Host',
          launchTime: 1812,
        },
      }),
    })
    let permissionRequests = 0

    const r = await handleToolCall(
      makeAdapter({ engine, hostBundleId: customHostBundleId }),
      'get_app_state',
      { app: customHostBundleId },
      baseOverrides({
        allowedApps: [{
          bundleId: customHostBundleId,
          displayName: 'Custom Host',
          grantedAt: 1,
          tier: 'full',
        }],
        onPermissionRequest: async () => {
          permissionRequests++
          throw new Error('must not request permission for the host app')
        },
      }),
    )

    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('app_denied')
    expect(permissionRequests).toBe(0)
    expect(calls.map(call => call.method)).toEqual(['resolveTarget'])
  })

  test('missing engine → feature_unavailable', async () => {
    const r = await handleToolCall(makeAdapter({ engine: undefined }), 'list_apps', {}, baseOverrides())
    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('feature_unavailable')
  })

  test('unknown tool name → bad_args', async () => {
    const { engine } = makeEngine()
    const r = await handleToolCall(makeAdapter({ engine }), 'left_click', {}, baseOverrides())
    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('bad_args')
  })

  test('static request failures do not check TCC, consult the lock, or resolve a target', async () => {
    const cases = [
      {
        name: 'click',
        args: { app: 'Finder', x: 1 },
        expectedKind: 'bad_args',
      },
      {
        name: 'type_text',
        args: { app: '  ', text: 'blocked' },
        expectedKind: 'bad_args',
      },
      {
        name: 'click',
        args: { app: 'Finder', x: -1, y: 0 },
        expectedKind: 'bad_args',
      },
      {
        name: 'press_key',
        args: { app: 'Finder', key: 'cmd+q' },
        expectedKind: 'grant_flag_required',
      },
    ] as const

    for (const entry of cases) {
      let tccChecks = 0
      let lockChecks = 0
      let lockAcquires = 0
      const { engine, calls } = makeEngine()
      const adapter = makeAdapter({ engine, granted: false })
      adapter.ensureOsPermissions = async () => {
        tccChecks++
        return { granted: false, accessibility: false, screenRecording: false }
      }

      const result = await handleToolCall(
        adapter,
        entry.name,
        entry.args,
        baseOverrides({
          grantFlags: {
            clipboardRead: false,
            clipboardWrite: false,
            systemKeyCombos: false,
          },
          checkCuLock: () => {
            lockChecks++
            return { holder: undefined, isSelf: false }
          },
          acquireCuLock: () => {
            lockAcquires++
          },
        }) as any,
      )

      expect(result.telemetry?.error_kind).toBe(entry.expectedKind)
      expect(tccChecks).toBe(0)
      expect(lockChecks).toBe(0)
      expect(lockAcquires).toBe(0)
      expect(calls).toHaveLength(0)
    }
  })

  test('resolves alias and PID targets and dispatches without an app permission prompt', async () => {
    for (const requestedApp of ['Notes', '812']) {
      let permissionCalls = 0
      const { engine, calls } = makeEngine({
        resolveTarget: async (target: AppTarget) => {
          expect(target).toEqual(requestedApp === '812' ? { pid: 812 } : { app: 'Notes' })
          return {
            pid: 812,
            bundleId: 'com.apple.Notes',
            displayName: 'Notes',
            path: '/System/Applications/Notes.app',
            executablePath: '/System/Applications/Notes.app/Contents/MacOS/Notes',
            launchTime: 1812,
            processIdentity: {
              pid: 812,
              bundleId: 'com.apple.Notes',
              executablePath: '/System/Applications/Notes.app/Contents/MacOS/Notes',
              launchTime: 1812,
            },
          }
        },
      })
      const r = await handleToolCall(
        makeAdapter({ engine }),
        'click',
        { app: requestedApp, element_index: 'g17:1' },
        baseOverrides({
          allowedApps: [],
          onPermissionRequest: async () => {
            permissionCalls++
            throw new Error('must not prompt')
          },
        }),
      )

      expect(r.isError).toBeFalsy()
      expect(permissionCalls).toBe(0)
      expect(calls.map(call => call.method)).toEqual(['resolveTarget', 'click'])
      expect(calls[1].args).toMatchObject({ target: { pid: 812 } })
    }
  })

  test('a running target without a proven process lifetime fails before mutation', async () => {
    const { engine, calls } = makeEngine({
      resolveTarget: async () => ({
        pid: 812,
        bundleId: 'com.apple.Notes',
        displayName: 'Notes',
        path: '/System/Applications/Notes.app',
      }),
    })

    const r = await handleToolCall(
      makeAdapter({ engine }),
      'type_text',
      { app: 'Notes', text: 'must not be typed' },
      baseOverrides({
        allowedApps: [{
          bundleId: 'com.apple.Notes',
          displayName: 'Notes',
          grantedAt: 1,
        }],
      }),
    )

    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('executor_threw')
    expect(textOf(r)).toContain('did not prove the running process lifetime')
    expect(calls.map(call => call.method)).toEqual(['resolveTarget'])
  })

  test('dispatches get_app_state by exact installed path without an app prompt', async () => {
    const path = '/Applications/Acme Notes.app'
    let permissionCalls = 0
    const { engine, calls } = makeEngine({
      resolveTarget: async () => ({
        bundleId: 'com.acme.notes',
        displayName: 'Acme Notes',
        path,
      }),
    })
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'get_app_state',
      { app: path },
      baseOverrides({
        allowedApps: [],
        onPermissionRequest: async () => {
          permissionCalls++
          throw new Error('must not prompt')
        },
      }),
    )

    expect(r.isError).toBeFalsy()
    expect(permissionCalls).toBe(0)
    expect(calls.map(call => call.method)).toEqual(['resolveTarget', 'getAppState'])
    expect(calls[1].args).toEqual({ app: path })
  })

  test('an empty legacy allowlist still permits a supported target without a permission handler', async () => {
    const { engine, calls } = makeEngine({
      resolveTarget: async () => ({
        pid: 812,
        bundleId: 'com.apple.Notes',
        displayName: 'Notes',
        executablePath: '/System/Applications/Notes.app/Contents/MacOS/Notes',
        launchTime: 1812,
      }),
    })
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'click',
      { app: 'Notes', element_index: 'g17:1' },
      baseOverrides({ allowedApps: [], onPermissionRequest: undefined }),
    )

    expect(r.isError).toBeFalsy()
    expect(calls.map(call => call.method)).toEqual(['resolveTarget', 'click'])
  })

  test('legacy preauthorization data is not consulted or prompted for', async () => {
    let permissionCalls = 0
    const { engine, calls } = makeEngine({
      resolveTarget: async () => ({
        pid: 812,
        bundleId: 'com.apple.Notes',
        displayName: 'Notes',
        executablePath: '/System/Applications/Notes.app/Contents/MacOS/Notes',
        launchTime: 1812,
      }),
    })
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'type_text',
      { app: 'Notes', text: 'hello' },
      baseOverrides({
        allowedApps: [{ bundleId: 'com.apple.Notes', displayName: 'Notes', grantedAt: 1 }],
        onPermissionRequest: async () => {
          permissionCalls++
          throw new Error('must not prompt')
        },
      }),
    )

    expect(r.isError).toBeFalsy()
    expect(permissionCalls).toBe(0)
    expect(calls.map(call => call.method)).toEqual(['resolveTarget', 'typeText'])
  })

  test('legacy user-denied app state no longer blocks a supported app', async () => {
    const { engine, calls } = makeEngine({
      resolveTarget: async () => ({
        pid: 812,
        bundleId: 'com.apple.Notes',
        displayName: 'Notes',
        executablePath: '/System/Applications/Notes.app/Contents/MacOS/Notes',
        launchTime: 1812,
      }),
    })
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'type_text',
      { app: 'Notes', text: 'allowed' },
      baseOverrides({ allowedApps: [], userDeniedBundleIds: ['com.apple.Notes'] }),
    )

    expect(r.isError).toBeFalsy()
    expect(calls.map(call => call.method)).toEqual(['resolveTarget', 'typeText'])
  })

  test('the product denylist still blocks a resolved app before mutation', async () => {
    const { engine, calls } = makeEngine({
      resolveTarget: async () => ({
        pid: 900,
        bundleId: 'com.googlecode.iterm2',
        displayName: 'iTerm2',
      }),
    })
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'type_text',
      { app: 'iTerm2', text: 'blocked' },
      baseOverrides({ allowedApps: [] }),
    )

    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('app_denied')
    expect(calls.map(call => call.method)).toEqual(['resolveTarget'])
  })

  test('invalid app values return bad_args without resolving a target', async () => {
    for (const app of [undefined, null, 812, '', '  ']) {
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        'type_text',
        { app, text: 'blocked' },
        baseOverrides(),
      )
      expect(r.isError).toBe(true)
      expect(r.telemetry?.error_kind).toBe('bad_args')
      expect(calls).toHaveLength(0)
    }
  })

  test('invalid tool arguments fail before target resolution or an app permission prompt', async () => {
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'get_app_state', args: { app: 'Notes', disableDiff: 'true' } },
      { name: 'click', args: { app: 'Notes' } },
      {
        name: 'perform_secondary_action',
        args: { app: 'Notes', element_index: 'g17:1' },
      },
      { name: 'set_value', args: { app: 'Notes', element_index: 'g17:1' } },
      {
        name: 'select_text',
        args: { app: 'Notes', element_index: 'g17:1', text: 'x', selection_type: 'range' },
      },
      { name: 'scroll', args: { app: 'Notes', direction: 'down' } },
      { name: 'drag', args: { app: 'Notes', from_x: 1, from_y: 2, to_x: 3 } },
      { name: 'press_key', args: { app: 'Notes' } },
      { name: 'type_text', args: { app: 'Notes' } },
    ]

    for (const entry of cases) {
      let permissionCalls = 0
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        entry.name,
        entry.args,
        baseOverrides({
          allowedApps: [],
          onPermissionRequest: async () => {
            permissionCalls++
            throw new Error('invalid arguments must not prompt')
          },
        }),
      )

      expect(r.telemetry?.error_kind).toBe('bad_args')
      expect(permissionCalls).toBe(0)
      expect(calls).toHaveLength(0)
    }
  })

  test('click_count and pages bounds fail before permission', async () => {
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'click', args: { app: 'Notes', x: 1, y: 2, click_count: 0 } },
      { name: 'click', args: { app: 'Notes', x: 1, y: 2, click_count: 1.5 } },
      { name: 'click', args: { app: 'Notes', x: 1, y: 2, click_count: 4 } },
      {
        name: 'scroll',
        args: { app: 'Notes', element_index: 'g17:1', direction: 'down', pages: 0 },
      },
      {
        name: 'scroll',
        args: { app: 'Notes', element_index: 'g17:1', direction: 'down', pages: 10.1 },
      },
    ]

    for (const entry of cases) {
      let permissionCalls = 0
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        entry.name,
        entry.args,
        baseOverrides({
          allowedApps: [],
          onPermissionRequest: async () => {
            permissionCalls++
            throw new Error('out-of-range arguments must not prompt')
          },
        }),
      )

      expect(r.telemetry?.error_kind).toBe('bad_args')
      expect(permissionCalls).toBe(0)
      expect(calls).toHaveLength(0)
    }
  })

  test('conflicting compatibility aliases fail closed before permission', async () => {
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      {
        name: 'get_app_state',
        args: { app: 'Notes', disableDiff: true, disable_diff: false },
      },
      {
        name: 'scroll',
        args: {
          app: 'Notes',
          element_index: 'g17:1',
          direction: 'down',
          pages: 1,
          amount: 2,
        },
      },
      {
        name: 'drag',
        args: {
          app: 'Notes',
          from: { x: 1, y: 2 },
          to: { x: 3, y: 4 },
          from_x: 9,
          from_y: 2,
          to_x: 3,
          to_y: 4,
        },
      },
    ]

    for (const entry of cases) {
      let permissionCalls = 0
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        entry.name,
        entry.args,
        baseOverrides({
          allowedApps: [],
          onPermissionRequest: async () => {
            permissionCalls++
            throw new Error('conflicting aliases must not prompt')
          },
        }),
      )

      expect(r.telemetry?.error_kind).toBe('bad_args')
      expect(permissionCalls).toBe(0)
      expect(calls).toHaveLength(0)
    }
  })

  test('press_key blocks every dangerous macOS shortcut alias when systemKeyCombos is false', async () => {
    const metaAliases = ['cmd', 'super', 'command', 'meta']
    const dangerous = [
      ...metaAliases.flatMap(meta => [
        `${meta}+q`,
        `${meta}+tab`,
        `${meta}+space`,
        `${meta}+spacebar`,
        `shift+${meta}+tab`,
        `shift+${meta}+q`,
        ...['alt', 'option', 'opt'].flatMap(alt => [
          `${meta}+${alt}+escape`,
          `${meta}+${alt}+esc`,
        ]),
        `ctrl+${meta}+q`,
      ]),
      'super+a cmd+opt+esc ctrl+v',
      'win+q',
      'control+cmd+q',
      'cmd + q',
      'cmd+q+a',
      'cmd++q',
      '+cmd+q+',
    ]

    for (const key of dangerous) {
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        'press_key',
        { app: 'Finder', key },
        baseOverrides({
          grantFlags: {
            clipboardRead: false,
            clipboardWrite: false,
            systemKeyCombos: false,
          },
        }),
      )

      expect(r.isError).toBe(true)
      expect(r.telemetry?.error_kind).toBe('grant_flag_required')
      expect(textOf(r)).toContain(
        'Enable system key combinations in Computer Use settings, then retry.',
      )
      expect(textOf(r)).not.toContain('request_access')
      expect(calls).toHaveLength(0)
    }
  })

  test('press_key fails closed for a dangerous alias when grantFlags is undefined', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'press_key',
      { app: 'Finder', key: 'cmd+spacebar' },
      baseOverrides({ grantFlags: undefined as never }),
    )

    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('grant_flag_required')
    expect(textOf(r)).toContain(
      'Enable system key combinations in Computer Use settings, then retry.',
    )
    expect(calls).toHaveLength(0)
  })

  test('press_key ignores a model-supplied systemKeyCombos=true when the session grant is false', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'press_key',
      { app: 'Finder', key: 'cmd+q', systemKeyCombos: true },
      baseOverrides({
        grantFlags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: false,
        },
      }),
    )

    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('grant_flag_required')
    expect(calls).toHaveLength(0)
  })

  test('press_key blocks Windows delete aliases without blocking backspace', async () => {
    for (const keyName of ['delete', 'del', 'forwarddelete', 'forward_delete', 'deletef']) {
      expect(isSystemKeyCombo(`ctrl+alt+${keyName}`, 'win32')).toBe(true)
    }

    expect(isSystemKeyCombo('ctrl+alt+backspace', 'win32')).toBe(false)
  })

  test('press_key blocks Windows modifier aliases, spaces, suffixes, and empty-plus forms', async () => {
    const dangerous = [
      'control+alt+delete',
      'ctrl + alt + forwarddelete',
      'win+l',
      'windows+d',
      'alt+f4+a',
      'alt++tab',
    ]

    for (const key of dangerous) {
      expect(isSystemKeyCombo(key, 'win32')).toBe(true)
    }
  })

  test('press_key allows a dangerous shortcut when systemKeyCombos is true', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'press_key',
      { app: 'Finder', key: 'cmd+q' },
      baseOverrides({
        grantFlags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: true,
        },
      }),
    )

    expect(r.isError).toBeFalsy()
    expect(calls.find(c => c.method === 'pressKey')?.args).toMatchObject({
      target: { pid: 1234 },
      key: 'cmd+q',
      systemKeyCombos: true,
    })
  })

  test('systemKeyCombos gate does not affect type_text', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'type_text',
      { app: 'TextEdit', text: 'cmd+q' },
      baseOverrides({
        grantFlags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: false,
        },
      }),
    )

    expect(r.isError).toBeFalsy()
    expect(calls.find(c => c.method === 'typeText')?.args).toMatchObject({
      target: { pid: 1234 },
      text: 'cmd+q',
    })
  })
})

// ---------------------------------------------------------------------------
// Dispatch: per-tool behavior
// ---------------------------------------------------------------------------

describe('handleToolCall — tool dispatch', () => {
  test('list_apps returns the engine text verbatim', async () => {
    const { engine } = makeEngine({ listApps: async () => 'A — a.b [running]' })
    const r = await handleToolCall(makeAdapter({ engine }), 'list_apps', {}, baseOverrides())
    expect(textOf(r)).toBe('A — a.b [running]')
    expect(r.isError).toBeFalsy()
  })

  test('get_app_state frames the envelope (no auto-resnapshot duplication)', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(makeAdapter({ engine }), 'get_app_state', { app: 'Finder' }, baseOverrides())
    expect(textOf(r)).toContain('<app_state>')
    expect(calls.filter(c => c.method === 'getAppState')).toHaveLength(1)
    expect(calls[0].args).toEqual({ app: 'Finder' })
  })

  test('get_app_state maps official and legacy diff switches to internal disableDiff', async () => {
    for (const key of ['disableDiff', 'disable_diff']) {
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        'get_app_state',
        { app: 'Finder', [key]: true },
        baseOverrides(),
      )
      expect(r.isError).toBeFalsy()
      expect(calls.find(c => c.method === 'getAppState')!.callArgs).toEqual([
        expect.objectContaining({ pid: 1234 }),
        { disableDiff: true },
      ])
    }
  })

  test('every explicit get_app_state forwards its fresh screenshot', async () => {
    let capture = 0
    const { engine, calls } = makeEngine({
      getAppState: async () => {
        capture++
        return {
          pid: 1234,
          elementCount: 1,
          truncated: false,
          durationMs: 1,
          axText: capture === 1 ? 'full' : 'There has been no change.',
          screenshot: { base64: `PNG-${capture}`, width: 10, height: 10 },
        }
      },
    })
    const adapter = makeAdapter({ engine })

    const first = await handleToolCall(adapter, 'get_app_state', { app: 'Finder' }, baseOverrides())
    const second = await handleToolCall(adapter, 'get_app_state', { app: 'Finder' }, baseOverrides())

    expect(calls.filter(c => c.method === 'getAppState')).toHaveLength(2)
    expect(imageBlocks(first).map(block => block.data)).toEqual(['PNG-1'])
    expect(imageBlocks(second).map(block => block.data)).toEqual(['PNG-2'])
  })

  test('get_app_state rejects string and null disable_diff before engine invocation', async () => {
    for (const invalid of ['true', null]) {
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        'get_app_state',
        { app: 'Finder', disable_diff: invalid },
        baseOverrides(),
      )
      expect(r.isError).toBe(true)
      expect(r.telemetry?.error_kind).toBe('bad_args')
      expect(calls).toHaveLength(0)
    }
  })

  test('click performs one mutation and returns the exact refresh receipt', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'click',
      { app: 'Finder', element_index: 'g17:68', mouse_button: 'right', click_count: 2 },
      baseOverrides(),
    )
    const clickCall = calls.find(c => c.method === 'click')!
    expect(clickCall.args).toMatchObject({
      target: { pid: 1234 },
      index: 'g17:68',
      button: 'right',
      clickCount: 2,
    })
    expect(calls.map(c => c.method)).toEqual(['resolveTarget', 'click'])
    expect(textOf(r)).toBe(
      'Action completed. Call `get_app_state` to fetch the updated UI state.',
    )
    expect(imageBlocks(r)).toEqual([])
  })

  test('click by point works without element_index', async () => {
    const { engine, calls } = makeEngine()
    await handleToolCall(makeAdapter({ engine }), 'click', { app: 'Finder', x: 10, y: 20 }, baseOverrides())
    expect(calls.find(c => c.method === 'click')!.args).toMatchObject({ x: 10, y: 20, index: undefined })
  })

  test('official mouse-button aliases normalize before reaching the native engine', async () => {
    const expected = { l: 'left', r: 'right', m: 'middle' }
    for (const [alias, button] of Object.entries(expected)) {
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        'click',
        { app: 'Finder', x: 10, y: 20, mouse_button: alias },
        baseOverrides(),
      )
      expect(r.isError).toBeFalsy()
      expect(calls.find(c => c.method === 'click')!.args).toMatchObject({ button })
    }
  })

  test('click without index or point → bad_args', async () => {
    const { engine } = makeEngine()
    const r = await handleToolCall(makeAdapter({ engine }), 'click', { app: 'Finder' }, baseOverrides())
    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('bad_args')
  })

  test('set_value passes index+value; empty string allowed', async () => {
    const { engine, calls } = makeEngine()
    await handleToolCall(makeAdapter({ engine }), 'set_value', { app: 'Finder', element_index: 'g18:3', value: '' }, baseOverrides())
    expect(calls.find(c => c.method === 'setValue')!.args).toMatchObject({ target: { pid: 1234 }, index: 'g18:3', value: '' })
    expect(calls.filter(c => c.method === 'getAppState')).toHaveLength(0)
  })

  test('perform_secondary_action passes the pretty action name', async () => {
    const { engine, calls } = makeEngine()
    await handleToolCall(
      makeAdapter({ engine }),
      'perform_secondary_action',
      { app: 'Finder', element_index: 'g19:68', action: 'Expand' },
      baseOverrides(),
    )
    expect(calls.find(c => c.method === 'performSecondaryAction')!.args).toMatchObject({
      target: { pid: 1234 },
      index: 'g19:68',
      action: 'Expand',
    })
  })

  test('scroll accepts pages and the amount alias', async () => {
    const { engine, calls } = makeEngine()
    await handleToolCall(makeAdapter({ engine }), 'scroll', { app: 'Activity Monitor', element_index: 'g20:1', direction: 'down', pages: 2 }, baseOverrides())
    expect(calls.find(c => c.method === 'scroll')!.args).toMatchObject({ index: 'g20:1', direction: 'down', pages: 2 })

    const { engine: e2, calls: c2 } = makeEngine()
    await handleToolCall(
      makeAdapter({ engine: e2 }),
      'scroll',
      { app: 'X', element_index: 'g20:1', direction: 'up', amount: 3 },
      baseOverrides(),
    )
    expect(c2.find(c => c.method === 'scroll')!.args).toMatchObject({ direction: 'up', pages: 3 })
  })

  test('official direction aliases normalize before reaching the native engine', async () => {
    const expected = { u: 'up', d: 'down', l: 'left', r: 'right' }
    for (const [alias, direction] of Object.entries(expected)) {
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        'scroll',
        { app: 'Finder', element_index: 'g20:1', direction: alias },
        baseOverrides(),
      )
      expect(r.isError).toBeFalsy()
      expect(calls.find(c => c.method === 'scroll')!.args).toMatchObject({ direction })
    }
  })

  test('drag accepts nested from/to and flat from_x/...', async () => {
    const { engine, calls } = makeEngine()
    await handleToolCall(makeAdapter({ engine }), 'drag', { app: 'Finder', from: { x: 158, y: 373 }, to: { x: 220, y: 373 } }, baseOverrides())
    expect(calls.find(c => c.method === 'drag')!.args).toMatchObject({ from: { x: 158, y: 373 }, to: { x: 220, y: 373 } })

    const { engine: e2, calls: c2 } = makeEngine()
    await handleToolCall(makeAdapter({ engine: e2 }), 'drag', { app: 'Finder', from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, baseOverrides())
    expect(c2.find(c => c.method === 'drag')!.args).toMatchObject({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })
  })

  test('press_key derives the grant bit from session state, not model arguments', async () => {
    const { engine, calls } = makeEngine()
    await handleToolCall(
      makeAdapter({ engine }),
      'press_key',
      { app: 'Activity Monitor', key: 'super+a', systemKeyCombos: true },
      baseOverrides({
        grantFlags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: false,
        },
      }),
    )
    expect(calls.find(c => c.method === 'pressKey')!.args).toMatchObject({
      target: { pid: 1234 },
      key: 'super+a',
      systemKeyCombos: false,
    })
  })

  test('type_text passes literal text', async () => {
    const { engine, calls } = makeEngine()
    await handleToolCall(makeAdapter({ engine }), 'type_text', { app: 'Activity Monitor', text: 'Codex' }, baseOverrides())
    expect(calls.find(c => c.method === 'typeText')!.args).toMatchObject({ target: { pid: 1234 }, text: 'Codex' })
  })

  test('paste passes text and format as an explicit recovery action', async () => {
    const { engine, calls } = makeEngine()
    await handleToolCall(
      makeAdapter({ engine }),
      'paste',
      { app: 'Activity Monitor', text: '喜欢你', format: 'text' },
      baseOverrides(),
    )
    expect(calls.find(c => c.method === 'paste')!.args).toMatchObject({
      target: { pid: 1234 },
      text: '喜欢你',
      format: 'text',
    })
  })

  test('paste rejects missing text and unknown formats before target resolution', async () => {
    for (const args of [
      { app: 'Activity Monitor', format: 'text' },
      { app: 'Activity Monitor', text: 'hello', format: 'rtf' },
    ]) {
      const { engine, calls } = makeEngine()
      const result = await handleToolCall(
        makeAdapter({ engine }),
        'paste',
        args,
        baseOverrides(),
      )
      expect(result.isError).toBe(true)
      expect(result.telemetry?.error_kind).toBe('bad_args')
      expect(calls).toHaveLength(0)
    }
  })

  test('server guidance treats AX diffs and timed-out paste as non-authoritative', () => {
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('An empty AX diff does')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('paste({ app, text, format: "text" })')
    expect(COMPUTER_USE_INSTRUCTIONS).toContain('treat the result as unknown')
  })

  test('select_text passes the opaque handle, context, and selection mode', async () => {
    const { engine, calls } = makeEngine()
    await handleToolCall(
      makeAdapter({ engine }),
      'select_text',
      {
        app: 'TextEdit',
        element_index: 'g21:4',
        text: 'brown',
        prefix: 'quick ',
        suffix: ' fox',
        selection_type: 'cursor_after',
      },
      baseOverrides(),
    )
    expect(calls.find(c => c.method === 'selectText')!.args).toMatchObject({
      target: { pid: 1234 },
      index: 'g21:4',
      text: 'brown',
      prefix: 'quick ',
      suffix: ' fox',
      selection: 'cursor_after',
    })
    expect(calls.filter(c => c.method === 'getAppState')).toHaveLength(0)
  })

  test('select_text accepts the official `selection` name', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'select_text',
      { app: 'TextEdit', element_index: 'g21:4', text: 'brown', selection: 'cursor_after' },
      baseOverrides(),
    )
    expect(r.isError).toBeFalsy()
    expect(calls.find(c => c.method === 'selectText')!.args).toMatchObject({
      selection: 'cursor_after',
    })
  })

  test('select_text rejects passing both selection spellings at once', async () => {
    const { engine, calls } = makeEngine()
    const r = await handleToolCall(
      makeAdapter({ engine }),
      'select_text',
      {
        app: 'TextEdit',
        element_index: 'g21:4',
        text: 'brown',
        selection: 'cursor_after',
        selection_type: 'text',
      },
      baseOverrides(),
    )
    expect(r.isError).toBe(true)
    expect(r.telemetry?.error_kind).toBe('bad_args')
    expect(calls).toHaveLength(0)
  })

  test('app-specific instructions are delivered once per app, not per call', async () => {
    _test.resetDeliveredAppInstructions()
    const state = {
      pid: 1234,
      bundleId: 'com.apple.finder',
      elementCount: 1,
      truncated: false,
      durationMs: 1,
      axText: 'App=com.apple.finder (pid 1234)',
      appInstructions: '## Finder\nUse the sidebar.',
    }
    const { engine } = makeEngine({ getAppState: async () => state })
    const adapter = makeAdapter({ engine })

    const first = await handleToolCall(adapter, 'get_app_state', { app: 'Finder' }, baseOverrides())
    const second = await handleToolCall(adapter, 'get_app_state', { app: 'Finder' }, baseOverrides())

    expect(textOf(first)).toContain('<app_specific_instructions>')
    expect(textOf(second)).not.toContain('<app_specific_instructions>')
    // The state itself still comes back both times.
    expect(textOf(second)).toContain('App=com.apple.finder (pid 1234)')
  })

  test('every mutating tool performs zero implicit getAppState calls', async () => {
    const cases: Array<{ name: string; args: Record<string, unknown>; method: string }> = [
      { name: 'click', args: { app: 'Finder', element_index: 'g30:1' }, method: 'click' },
      {
        name: 'perform_secondary_action',
        args: { app: 'Finder', element_index: 'g30:2', action: 'Raise' },
        method: 'performSecondaryAction',
      },
      {
        name: 'set_value',
        args: { app: 'TextEdit', element_index: 'g30:3', value: 'x' },
        method: 'setValue',
      },
      {
        name: 'select_text',
        args: { app: 'TextEdit', element_index: 'g30:4', text: 'x' },
        method: 'selectText',
      },
      {
        name: 'scroll',
        args: { app: 'Finder', element_index: 'g30:5', direction: 'down' },
        method: 'scroll',
      },
      {
        name: 'drag',
        args: { app: 'Finder', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
        method: 'drag',
      },
      { name: 'press_key', args: { app: 'Finder', key: 'Return' }, method: 'pressKey' },
      { name: 'type_text', args: { app: 'TextEdit', text: 'x' }, method: 'typeText' },
    ]

    for (const entry of cases) {
      const { engine, calls } = makeEngine()
      const r = await handleToolCall(
        makeAdapter({ engine }),
        entry.name,
        entry.args,
        baseOverrides(),
      )
      expect(r.isError).toBeFalsy()
      expect(calls.map(c => c.method)).toEqual(['resolveTarget', entry.method])
      expect(textOf(r)).toBe(
        'Action completed. Call `get_app_state` to fetch the updated UI state.',
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Dispatch: error & staleness passthrough
// ---------------------------------------------------------------------------

describe('handleToolCall — error passthrough', () => {
  test('daemon staleness warning is surfaced verbatim', async () => {
    const warning =
      "The user changed 'Finder'. Re-query the latest state with `get_app_state` before sending more actions."
    const { engine } = makeEngine({
      click: async () => {
        throw new Error(warning)
      },
    })
    const r = await handleToolCall(makeAdapter({ engine }), 'click', { app: 'Finder', element_index: 'g17:1' }, baseOverrides())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(warning)
  })

  test('index-out-of-range error from the daemon is surfaced', async () => {
    const { engine } = makeEngine({
      setValue: async () => {
        throw new Error('Element handle g17:99 not found in snapshot (has 12 elements).')
      },
    })
    const r = await handleToolCall(makeAdapter({ engine }), 'set_value', { app: 'Finder', element_index: 'g17:99', value: 'x' }, baseOverrides())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('Element handle g17:99 not found')
  })

  test('a failed mutation remains a tool error and never returns a success receipt', async () => {
    const { engine } = makeEngine({
      click: async () => {
        throw new Error('click failed')
      },
    })
    const r = await handleToolCall(makeAdapter({ engine }), 'click', { app: 'Finder', element_index: 'g17:1' }, baseOverrides())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('click failed')
    expect(textOf(r)).not.toContain('Action completed')
  })
})

describe('resetMouseButtonHeld', () => {
  test('is a safe no-op (preserved export)', () => {
    expect(() => resetMouseButtonHeld()).not.toThrow()
  })
})
