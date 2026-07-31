import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openTraceCaptureSettings,
  openTraceDetail,
  openTraceList,
  returnToTraceList,
} from './traceNavigation'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'

vi.mock('../api/sessions', () => ({
  sessionsApi: { list: vi.fn() },
}))

describe('traceNavigation', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ tabs: [], activeTabId: null })
    useUIStore.setState({ pendingSettingsTab: null })
  })

  afterEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null })
    useUIStore.setState({ pendingSettingsTab: null })
  })

  it('opens the trace list by focusing the Settings tab on its Trace section', () => {
    openTraceList()

    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === SETTINGS_TAB_ID)?.type).toBe('settings')
    expect(useUIStore.getState().pendingSettingsTab).toBe('trace')
  })

  it('sends the capture switches to General, not to the list', () => {
    openTraceCaptureSettings()

    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useUIStore.getState().pendingSettingsTab).toBe('general')
  })

  it('titles a detail tab with the session alone, no trace prefix', () => {
    const tabId = openTraceDetail('session-9', 'Debug stuck agent')

    expect(tabId).toBe('__trace__session-9')
    const tab = useTabStore.getState().tabs.find((entry) => entry.sessionId === tabId)
    expect(tab?.title).toBe('Debug stuck agent')
    expect(tab?.traceSessionId).toBe('session-9')
  })

  it('lands on the list and closes the detail tab it came from', () => {
    const tabId = openTraceDetail('session-9', 'Debug stuck agent')

    returnToTraceList(tabId)

    expect(useTabStore.getState().tabs.some((tab) => tab.sessionId === tabId)).toBe(false)
    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useUIStore.getState().pendingSettingsTab).toBe('trace')
  })

  it('does not strand focus on a neighbouring tab when closing the detail tab', () => {
    // Closing the active tab hands focus to whichever tab takes its index, so
    // the return has to switch away first. With a chat tab sitting where the
    // trace tab was, a close-then-switch order would land on the chat instead.
    useTabStore.setState({
      tabs: [{ sessionId: 'chat-1', title: 'Chat', type: 'session', status: 'idle' }],
      activeTabId: 'chat-1',
    })
    const tabId = openTraceDetail('session-9', 'Debug stuck agent')

    returnToTraceList(tabId)

    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['chat-1', SETTINGS_TAB_ID])
  })

  it('reuses the existing detail tab when the same trace is reopened', () => {
    const first = openTraceDetail('session-9', 'Debug stuck agent')
    useTabStore.getState().setActiveTab(SETTINGS_TAB_ID)
    const second = openTraceDetail('session-9', 'Debug stuck agent renamed')

    expect(second).toBe(first)
    expect(useTabStore.getState().tabs.filter((tab) => tab.type === 'trace')).toHaveLength(1)
    expect(useTabStore.getState().activeTabId).toBe(first)
  })
})
