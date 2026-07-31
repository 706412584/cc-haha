import { t } from '../i18n'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'

/**
 * The trace list lives inside Settings, so "show the list" and "go back to the
 * list" are the same action: focus the Settings tab and select its Trace
 * section. Routing every entry point through here keeps the return path one hop
 * regardless of where the detail tab was opened from — the list, a deep link,
 * or a restored tab.
 */
export function openTraceList(): void {
  useUIStore.getState().setPendingSettingsTab('trace')
  useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
}

/** The capture switches themselves live one section over, under General. */
export function openTraceCaptureSettings(): void {
  useUIStore.getState().setPendingSettingsTab('general')
  useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
}

/** Drill into one session's trace. The tab is titled with the session it traces. */
export function openTraceDetail(sessionId: string, title: string): string {
  return useTabStore.getState().openTraceTab(sessionId, title)
}

/**
 * Leave a detail tab the way `returnFromWorkbench` leaves a workbench tab: land
 * on the list first, then drop the tab we came from, so browsing several traces
 * in a row does not leave a trail of dead tabs behind. Ordering matters — the
 * close runs after the switch so the tab bar never flashes an interim tab.
 */
export function returnToTraceList(tabId: string): void {
  openTraceList()
  useTabStore.getState().closeTab(tabId)
}
