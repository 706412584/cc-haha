import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { _test as deniedApps } from './deniedApps.js'

const SWIFT_SET_MARKER = 'static let deniedBundleIDs: Set<String> = ['
const SWIFT_INTRINSIC_SET_MARKER = 'static let intrinsicDeniedBundleIDs: Set<String> = ['

function parseNativeDeniedBundleIds(source: string, marker: string): string[] {
  const markerIndex = source.indexOf(marker)
  expect(markerIndex).toBeGreaterThanOrEqual(0)

  const bodyStart = markerIndex + marker.length
  const bodyEnd = source.indexOf('\n    ]', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)

  const body = source.slice(bodyStart, bodyEnd)
  return [...body.matchAll(/^\s*"([^"]+)",?\s*(?:\/\/.*)?$/gm)].map(match => match[1])
}

test('native AppTargetPolicy deny set stays in exact parity with deniedApps bundle sets', () => {
  const tsEntries = [
    deniedApps.BROWSER_BUNDLE_IDS,
    deniedApps.TERMINAL_BUNDLE_IDS,
    deniedApps.TRADING_BUNDLE_IDS,
    deniedApps.POLICY_DENIED_BUNDLE_IDS,
  ].flatMap(entries => [...entries])
  const expected = new Set(tsEntries)

  const swiftPath = resolve(
    import.meta.dir,
    '../../../native/cu-helper/Sources/cu-helper/AppTargetPolicy.swift',
  )
  const nativeEntries = parseNativeDeniedBundleIds(
    readFileSync(swiftPath, 'utf8'),
    SWIFT_SET_MARKER,
  )
  const actual = new Set(nativeEntries)

  const missing = [...expected].filter(bundleId => !actual.has(bundleId)).sort()
  const extra = [...actual].filter(bundleId => !expected.has(bundleId)).sort()

  expect(tsEntries).toHaveLength(expected.size)
  expect(nativeEntries).toHaveLength(actual.size)
  expect(expected.size).toBe(107)
  expect(actual.size).toBe(107)
  expect(missing).toEqual([])
  expect(extra).toEqual([])
  expect([...actual].sort()).toEqual([...expected].sort())
})

test('native intrinsic deny set stays separate and matches the TS host/helper defaults', () => {
  const swiftPath = resolve(
    import.meta.dir,
    '../../../native/cu-helper/Sources/cu-helper/AppTargetPolicy.swift',
  )
  const nativeEntries = parseNativeDeniedBundleIds(
    readFileSync(swiftPath, 'utf8'),
    SWIFT_INTRINSIC_SET_MARKER,
  )
  const expected = deniedApps.INTRINSIC_DENIED_BUNDLE_IDS

  expect(new Set(nativeEntries)).toEqual(expected)
  expect(expected).toEqual(new Set([
    'com.claude-code-haha.desktop',
    'dev.cchaha.cu-helper',
  ]))
  expect(nativeEntries).toHaveLength(2)
})
