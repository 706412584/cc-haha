import { describe, expect, test } from 'bun:test'
import {
  buildPreAuthorizedAppGrants,
  DEFAULT_DESKTOP_GRANT_FLAGS,
  parseStoredComputerUseConfig,
  resolveStoredComputerUseConfig,
} from './preauthorizedConfig.js'

describe('resolveStoredComputerUseConfig', () => {
  test('keeps desktop grant flags enabled by default even without authorized apps', () => {
    expect(resolveStoredComputerUseConfig()).toEqual({
      enabled: true,
      authorizedApps: [],
      grantFlags: DEFAULT_DESKTOP_GRANT_FLAGS,
      pythonPath: null,
    })
  })

  test('preserves an explicit disabled state', () => {
    expect(resolveStoredComputerUseConfig({ enabled: false })).toMatchObject({
      enabled: false,
      authorizedApps: [],
    })
  })

  test('merges stored grant flags without discarding unspecified defaults', () => {
    expect(
      resolveStoredComputerUseConfig({
        grantFlags: {
          clipboardRead: false,
        },
      }),
    ).toEqual({
      enabled: true,
      authorizedApps: [],
      grantFlags: {
        clipboardRead: false,
        clipboardWrite: true,
        systemKeyCombos: true,
      },
      pythonPath: null,
    })
  })

  test('normalizes a stored custom Python interpreter path', () => {
    expect(
      resolveStoredComputerUseConfig({
        pythonPath: '  C:\\Users\\me\\miniconda3\\envs\\cu\\python.exe  ',
      }),
    ).toMatchObject({
      pythonPath: 'C:\\Users\\me\\miniconda3\\envs\\cu\\python.exe',
    })
    expect(resolveStoredComputerUseConfig({ pythonPath: '' })).toMatchObject({
      pythonPath: null,
    })
  })

  test('rejects malformed persisted security fields instead of enabling them by coercion', () => {
    expect(parseStoredComputerUseConfig({ enabled: 'false' })).toBeNull()
    expect(parseStoredComputerUseConfig({
      grantFlags: { clipboardWrite: 'yes' },
    })).toBeNull()
    expect(parseStoredComputerUseConfig({
      authorizedApps: [{ bundleId: '', displayName: 'Preview' }],
    })).toBeNull()
    expect(parseStoredComputerUseConfig({
      enabled: false,
      grantFlags: {
        clipboardRead: false,
        clipboardWrite: true,
      },
      futureField: 'preserved by newer versions',
    })).toEqual({
      enabled: false,
      grantFlags: {
        clipboardRead: false,
        clipboardWrite: true,
      },
      futureField: 'preserved by newer versions',
    })
  })

  test('derives least-privilege tiers and filters policy-denied pre-authorizations', () => {
    expect(
      buildPreAuthorizedAppGrants([
        {
          bundleId: 'com.google.Chrome',
          displayName: 'Google Chrome',
        },
        {
          bundleId: 'com.apple.Terminal',
          displayName: 'Terminal',
        },
        {
          bundleId: 'com.apple.Preview',
          displayName: 'Preview',
        },
        {
          bundleId: 'com.spotify.client',
          displayName: 'Spotify',
        },
      ], 1234),
    ).toEqual([
      {
        bundleId: 'com.google.Chrome',
        displayName: 'Google Chrome',
        grantedAt: 1234,
        tier: 'read',
      },
      {
        bundleId: 'com.apple.Terminal',
        displayName: 'Terminal',
        grantedAt: 1234,
        tier: 'click',
      },
      {
        bundleId: 'com.apple.Preview',
        displayName: 'Preview',
        grantedAt: 1234,
        tier: 'full',
      },
    ])
  })
})
