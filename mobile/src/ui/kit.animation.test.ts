import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'

test('循环状态动画仅在原生平台使用 native driver，并在卸载时停止', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-status-animation-'))
  const root = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
  const script = `
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
const root = ${JSON.stringify(root)}
const effects = [], cleanups = [], configurations = []
let starts = 0, stops = 0
const actualReact = await import(root + '/mobile/node_modules/react/index.js')
const react = { ...actualReact.default, createElement: () => null }
mock.module(root + '/mobile/node_modules/react', () => ({
  default: react, ...react, useMemo: fn => fn(), useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: effect => effects.push(effect),
}))
mock.module(root + '/mobile/node_modules/react/jsx-dev-runtime', () => ({ jsxDEV: () => null, Fragment: 'Fragment' }))
mock.module(root + '/mobile/node_modules/react/jsx-runtime', () => ({ jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }))
const Platform = { OS: 'web' }
mock.module(root + '/mobile/node_modules/react-native', () => ({
  Platform, AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
  Animated: { Value: class { interpolate() { return 'value' } }, View: 'View', timing: (_value, config) => { configurations.push(config); return config }, loop: () => ({ start() { starts++ }, stop() { stops++ } }) },
  Easing: { linear: 'linear', quad: 'quad', inOut: value => value },
  Text: 'Text', StyleSheet: { create: value => value }, View: 'View', ActivityIndicator: 'ActivityIndicator', FlatList: 'FlatList', Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
mock.module(root + '/mobile/node_modules/react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
mock.module(root + '/mobile/node_modules/react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect' }))
mock.module(root + '/mobile/node_modules/expo-router', () => ({ router: {} }))
for (const [name, exports] of Object.entries({ Text: { Text: 'Text' }, KeyboardViewport: { KeyboardViewport: 'KeyboardViewport' }, icons: { Icon: 'Icon' }, theme: { useTheme: () => ({ colors: {} }) }, palette: { monoFont: 'mono', type: {} }, webChrome: { simulatedPhoneChrome: false } })) mock.module(root + '/mobile/src/ui/' + name + (name === 'palette' || name === 'webChrome' ? '.ts' : '.tsx'), () => exports)
const { Spinner, HaloDot } = await import(root + '/mobile/src/ui/kit.tsx')
for (const platform of ['web', 'ios']) {
  Platform.OS = platform
  Spinner({}); HaloDot({})
  while (effects.length) { const cleanup = effects.shift()(); if (cleanup) cleanups.push(cleanup) }
  const recent = configurations.slice(-2)
  assert.equal(recent.length, 2)
  assert.ok(recent.every(config => config.useNativeDriver === (platform !== 'web')))
}
cleanups.forEach(cleanup => cleanup())
assert.equal(starts, 4)
assert.equal(stops, 4)
`
  try {
    const file = join(directory, 'animation.ts')
    writeFileSync(file, script)
    execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
