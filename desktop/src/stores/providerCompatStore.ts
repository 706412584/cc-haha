// desktop/src/stores/providerCompatStore.ts
//
// Per-provider counter for "fake tool_use" leaks — text turns where the
// model emits an XML-style `<tool_use ...>{...}</tool_use>` block in
// content_delta instead of a real structured tool call. This usually
// means the active provider/gateway doesn't pass through Anthropic's
// native tool_use blocks; the fix for the user is to switch providers,
// not to debug their session. We:
//
//   1. Increment a counter per provider on each detection.
//   2. After WARN_THRESHOLD events, fire a one-time toast suggesting
//      a provider switch. The "warned" flag prevents repeat toasts —
//      the user can still see the count in the Settings → Provider list.
//   3. Persist counts and the warned set to localStorage so the warning
//      survives reloads.
//
// We only trigger the toast once per provider per device. Resetting via
// `clearProvider(id)` re-arms the warning (used when the user switches
// gateway URL on a provider, since that's the most common manual fix).

import { create } from 'zustand'
import { useUIStore } from './uiStore'
import { t } from '../i18n'

export const PROVIDER_COMPAT_STORAGE_KEY = 'cc-haha-provider-compat'
export const PROVIDER_COMPAT_WARN_THRESHOLD = 3

export type ProviderCompatEvent = {
  /** Total fake tool_use blocks seen against this provider. */
  count: number
  /** Most recent block timestamp (ms epoch). Used to surface "刚刚 / 5 分钟前" if needed. */
  lastSeenAt: number
  /** Sample tool name from the most recent block — informs the toast wording. */
  lastToolName: string
}

type PersistedShape = {
  events: Record<string, ProviderCompatEvent>
  warnedProviderIds: string[]
}

type ProviderCompatStore = {
  events: Record<string, ProviderCompatEvent>
  /** Providers we've already toasted about. Reset by `clearProvider`. */
  warnedProviderIds: Set<string>

  /**
   * Record one fake tool_use block. `providerId` may be null when the
   * desktop hasn't loaded provider state yet (e.g. during initial replay) —
   * in that case we skip the increment so the counter only ever attributes
   * leaks to providers we can actually point the user at.
   *
   * `toolName` is informational only; it shapes the toast wording.
   */
  recordFakeToolUse: (providerId: string | null | undefined, toolName: string) => void

  /** Clear counters for a provider — call this when the user edits its config. */
  clearProvider: (providerId: string) => void

  /** Hard reset (used in tests). */
  reset: () => void
}

function readPersisted(): PersistedShape {
  if (typeof localStorage === 'undefined') {
    return { events: {}, warnedProviderIds: [] }
  }
  try {
    const raw = localStorage.getItem(PROVIDER_COMPAT_STORAGE_KEY)
    if (!raw) return { events: {}, warnedProviderIds: [] }
    const parsed = JSON.parse(raw) as Partial<PersistedShape>
    return {
      events: parsed.events && typeof parsed.events === 'object' ? parsed.events : {},
      warnedProviderIds: Array.isArray(parsed.warnedProviderIds)
        ? parsed.warnedProviderIds.filter((id): id is string => typeof id === 'string')
        : [],
    }
  } catch {
    return { events: {}, warnedProviderIds: [] }
  }
}

function writePersisted(state: { events: Record<string, ProviderCompatEvent>; warnedProviderIds: Set<string> }) {
  if (typeof localStorage === 'undefined') return
  try {
    const payload: PersistedShape = {
      events: state.events,
      warnedProviderIds: [...state.warnedProviderIds],
    }
    localStorage.setItem(PROVIDER_COMPAT_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // noop — best effort
  }
}

const initial = readPersisted()

export const useProviderCompatStore = create<ProviderCompatStore>((set, get) => ({
  events: initial.events,
  warnedProviderIds: new Set(initial.warnedProviderIds),

  recordFakeToolUse: (providerId, toolName) => {
    if (!providerId) return
    const current = get().events[providerId]
    const next: ProviderCompatEvent = {
      count: (current?.count ?? 0) + 1,
      lastSeenAt: Date.now(),
      lastToolName: toolName || current?.lastToolName || 'unknown',
    }
    const events = { ...get().events, [providerId]: next }
    let warnedProviderIds = get().warnedProviderIds

    // First crossing of the threshold for this provider — emit the toast
    // and remember we did so. Subsequent leaks just bump the counter.
    if (next.count >= PROVIDER_COMPAT_WARN_THRESHOLD && !warnedProviderIds.has(providerId)) {
      warnedProviderIds = new Set(warnedProviderIds)
      warnedProviderIds.add(providerId)

      // Use a slightly longer toast than default so the user has time to
      // read the suggestion. addToast tolerates an unknown 'duration'
      // field — older versions just ignore it.
      try {
        useUIStore.getState().addToast({
          type: 'warning',
          message: t('providerCompat.toast.fakeToolUse', {
            count: String(next.count),
            tool: next.lastToolName,
          }),
          duration: 8000,
        })
      } catch {
        // i18n / toast failures must NEVER swallow the counter — keep going.
      }
    }

    set({ events, warnedProviderIds })
    writePersisted({ events, warnedProviderIds })
  },

  clearProvider: (providerId) => {
    const events = { ...get().events }
    delete events[providerId]
    const warnedProviderIds = new Set(get().warnedProviderIds)
    warnedProviderIds.delete(providerId)
    set({ events, warnedProviderIds })
    writePersisted({ events, warnedProviderIds })
  },

  reset: () => {
    set({ events: {}, warnedProviderIds: new Set() })
    writePersisted({ events: {}, warnedProviderIds: new Set() })
  },
}))

/**
 * Pure helper — true when the provider has crossed the warn threshold and
 * deserves a badge in the provider list. Does not mutate state.
 */
export function hasProviderCompatWarning(providerId: string | null | undefined): boolean {
  if (!providerId) return false
  const event = useProviderCompatStore.getState().events[providerId]
  return !!event && event.count >= PROVIDER_COMPAT_WARN_THRESHOLD
}
