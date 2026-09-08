import { describe, expect, test } from 'bun:test'

import { setupComputerUseMCP } from './setup.js'

describe('setupComputerUseMCP runtime capability', () => {
  test('does not expose tools when the canonical macOS helper is unavailable', () => {
    expect(setupComputerUseMCP({
      platform: 'darwin',
      resolveMacosNativeBinary: () => null,
    })).toEqual({ mcpConfig: {}, allowedTools: [] })
  })

  test('exposes the native tools only after the macOS helper is launchable', () => {
    const result = setupComputerUseMCP({
      platform: 'darwin',
      resolveMacosNativeBinary: () => '/cfg/cu-helper/helper',
    })

    expect(Object.keys(result.mcpConfig)).toEqual(['computer-use'])
    expect(result.allowedTools.length).toBeGreaterThan(0)
  })

  test('keeps the Windows compatibility engine available without a macOS helper', () => {
    const result = setupComputerUseMCP({
      platform: 'win32',
      resolveMacosNativeBinary: () => {
        throw new Error('must not resolve a macOS helper on Windows')
      },
    })

    expect(Object.keys(result.mcpConfig)).toEqual(['computer-use'])
    expect(result.allowedTools.length).toBeGreaterThan(0)
  })
})
