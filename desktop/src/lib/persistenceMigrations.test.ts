import { beforeEach, describe, expect, test } from 'vitest'
import {
  CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION,
  DESKTOP_PERSISTENCE_VERSION_KEY,
  runDesktopPersistenceMigrations,
} from './persistenceMigrations'

describe('desktop persistence migrations', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('migrates legacy open-tab arrays into the current tab persistence shape', () => {
    window.localStorage.setItem('cc-haha-open-tabs', JSON.stringify([
      { sessionId: 'session-1', title: 'Old tab' },
      { sessionId: '__terminal__legacy', title: 'Terminal 1', type: 'terminal' },
      { sessionId: 123, title: 'bad' },
    ]))

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('cc-haha-open-tabs')
    expect(JSON.parse(window.localStorage.getItem('cc-haha-open-tabs') || '{}')).toEqual({
      openTabs: [{ sessionId: 'session-1', title: 'Old tab', type: 'session' }],
      activeTabId: 'session-1',
    })
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
  })

  test('preserves persisted market tabs during startup migration', () => {
    window.localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: '__market__', title: 'Market', type: 'market' },
        { sessionId: '__traces__', title: 'Traces', type: 'traces' },
      ],
      activeTabId: '__market__',
    }))

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('cc-haha-open-tabs')
    expect(JSON.parse(window.localStorage.getItem('cc-haha-open-tabs') || '{}')).toEqual({
      openTabs: [
        { sessionId: '__market__', title: 'Market', type: 'market' },
        { sessionId: '__traces__', title: 'Traces', type: 'traces' },
      ],
      activeTabId: '__market__',
    })
  })

  test('canonicalizes mismatched persisted special tab ids and types during startup migration', () => {
    window.localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: '__settings__', title: 'Settings', type: 'market' },
        { sessionId: '__market__', title: 'Skills', type: 'settings' },
      ],
      activeTabId: '__settings__',
    }))

    runDesktopPersistenceMigrations()

    expect(JSON.parse(window.localStorage.getItem('cc-haha-open-tabs') || '{}')).toEqual({
      openTabs: [
        { sessionId: '__settings__', title: 'Settings', type: 'settings' },
        { sessionId: '__market__', title: 'Skills', type: 'market' },
      ],
      activeTabId: '__settings__',
    })
  })

  test('filters stale session runtime selections without clearing unrelated keys', () => {
    window.localStorage.setItem('unrelated-user-key', 'keep')
    window.localStorage.setItem('cc-haha-session-runtime', JSON.stringify({
      good: { providerId: null, modelId: 'claude-sonnet' },
      alsoGood: { providerId: 'openai-official', modelId: 'gpt-5.6-sol', effortLevel: 'xhigh' },
      bad: { providerId: 'provider-2' },
    }))

    runDesktopPersistenceMigrations()

    expect(JSON.parse(window.localStorage.getItem('cc-haha-session-runtime') || '{}')).toEqual({
      alsoGood: { providerId: 'openai-official', modelId: 'gpt-5.6-sol', effortLevel: 'xhigh' },
      good: { providerId: null, modelId: 'claude-sonnet' },
    })
    expect(window.localStorage.getItem('unrelated-user-key')).toBe('keep')
  })

  test('removes malformed known keys without throwing during startup', () => {
    window.localStorage.setItem('cc-haha-open-tabs', '{"openTabs":')
    window.localStorage.setItem('cc-haha-theme', 'sepia')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('cc-haha-open-tabs')
    expect(report.migratedKeys).toContain('cc-haha-theme')
    expect(window.localStorage.getItem('cc-haha-open-tabs')).toBeNull()
    expect(window.localStorage.getItem('cc-haha-theme')).toBeNull()
  })

  test('preserves the pure white theme as a valid persisted theme', () => {
    window.localStorage.setItem('cc-haha-theme', 'white')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).not.toContain('cc-haha-theme')
    expect(window.localStorage.getItem('cc-haha-theme')).toBe('white')
  })

  test('preserves every supported locale during startup migration', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr']) {
      window.localStorage.setItem('cc-haha-locale', locale)

      const report = runDesktopPersistenceMigrations()

      expect(report.migratedKeys).not.toContain('cc-haha-locale')
      expect(window.localStorage.getItem('cc-haha-locale')).toBe(locale)
    }
  })

  test('preserves valid app zoom and removes invalid app zoom values', () => {
    window.localStorage.setItem('cc-haha-app-zoom', '1.2')

    const validReport = runDesktopPersistenceMigrations()

    expect(validReport.migratedKeys).not.toContain('cc-haha-app-zoom')
    expect(window.localStorage.getItem('cc-haha-app-zoom')).toBe('1.2')

    window.localStorage.setItem('cc-haha-app-zoom', '4')

    const invalidReport = runDesktopPersistenceMigrations()

    expect(invalidReport.migratedKeys).toContain('cc-haha-app-zoom')
    expect(window.localStorage.getItem('cc-haha-app-zoom')).toBeNull()
  })

  test('migrates the legacy UI zoom key into app zoom storage', () => {
    window.localStorage.setItem('cc-haha-ui-zoom', '1.25')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toEqual(expect.arrayContaining([
      'cc-haha-app-zoom',
      'cc-haha-ui-zoom',
    ]))
    expect(window.localStorage.getItem('cc-haha-app-zoom')).toBe('1.25')
    expect(window.localStorage.getItem('cc-haha-ui-zoom')).toBeNull()
  })

  test('does not throw if schema version persistence is blocked', () => {
    const storage = {
      getItem: window.localStorage.getItem.bind(window.localStorage),
      removeItem: window.localStorage.removeItem.bind(window.localStorage),
      setItem: (key: string, value: string) => {
        if (key === DESKTOP_PERSISTENCE_VERSION_KEY) {
          throw new Error('storage blocked')
        }
        window.localStorage.setItem(key, value)
      },
    }

    expect(() => runDesktopPersistenceMigrations(storage)).not.toThrow()
    expect(runDesktopPersistenceMigrations(storage).migratedKeys).toContain(DESKTOP_PERSISTENCE_VERSION_KEY)
  })

  test('does not throw if storage reads and writes are blocked', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      removeItem: () => {
        throw new Error('storage unavailable')
      },
      setItem: () => {
        throw new Error('storage unavailable')
      },
    }

    const report = runDesktopPersistenceMigrations(storage)

    expect(report.migratedKeys).toEqual(expect.arrayContaining([
      'cc-haha-open-tabs',
      'cc-haha-session-runtime',
      'cc-haha-theme',
      'cc-haha-locale',
      'cc-haha-app-zoom',
      DESKTOP_PERSISTENCE_VERSION_KEY,
    ]))
  })
})
