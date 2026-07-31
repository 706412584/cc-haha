import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPreAuthorizedAppGrants,
  loadStoredComputerUseConfigResult,
  parseStoredComputerUseConfig,
  resolveStoredComputerUseConfig,
} from './preauthorizedConfig.js'

describe('resolveStoredComputerUseConfig', () => {
  test('keeps desktop grant flags disabled until explicitly granted', () => {
    expect(resolveStoredComputerUseConfig()).toEqual({
      enabled: true,
      authorizedApps: [],
      grantFlags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      pythonPath: null,
    })
  })

  test('preserves an explicit disabled state', () => {
    expect(resolveStoredComputerUseConfig({ enabled: false })).toMatchObject({
      enabled: false,
      authorizedApps: [],
    })
  })

  test('honors explicit grant flags without enabling unspecified grants', () => {
    expect(
      resolveStoredComputerUseConfig({
        grantFlags: {
          clipboardRead: true,
        },
      }),
    ).toEqual({
      enabled: true,
      authorizedApps: [],
      grantFlags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      pythonPath: null,
    })
  })

  test('fails closed when the stored config file is missing', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-cu-config-'))
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      await expect(loadStoredComputerUseConfigResult()).resolves.toEqual({
        config: {
          enabled: true,
          authorizedApps: [],
          grantFlags: {
            clipboardRead: false,
            clipboardWrite: false,
            systemKeyCombos: false,
          },
          pythonPath: null,
        },
        error: null,
      })
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      }
      await rm(configDir, { recursive: true, force: true })
    }
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
