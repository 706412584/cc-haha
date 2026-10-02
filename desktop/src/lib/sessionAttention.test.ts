import { describe, expect, it } from 'vitest'
import { createDefaultSessionState, type PendingPermission, type PerSessionState } from '../stores/chatStore'
import type { ChatState } from '../types/chat'
import { collectAttentionIds, nextAttentionSessionId, sessionNeedsAttention } from './sessionAttention'

const CHAT_STATES: ChatState[] = [
  'idle',
  'thinking',
  'compacting',
  'tool_executing',
  'streaming',
  'permission_pending',
]

function perm(requestId: string, toolName = 'Bash'): PendingPermission {
  return { requestId, toolName, toolUseId: `tu-${requestId}`, input: {} }
}

function session(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return { ...createDefaultSessionState(), ...overrides }
}

// The store keeps the newest request in `pendingPermission` as a compatibility
// mirror and every outstanding one in `pendingPermissions`.
function waiting(...requests: PendingPermission[]): Partial<PerSessionState> {
  return {
    pendingPermission: requests.at(-1) ?? null,
    pendingPermissions: Object.fromEntries(requests.map((request) => [request.requestId, request])),
  }
}

describe('sessionNeedsAttention', () => {
  it.each(CHAT_STATES)('lights for an outstanding request while chatState is %s', (chatState) => {
    // `status` and `session_state` messages overwrite chatState under a card
    // that is still open, so the records have to decide, whatever chatState says.
    expect(sessionNeedsAttention(session({ chatState, ...waiting(perm('r1')) }))).toBe(true)
  })

  it.each(CHAT_STATES)('stays dark without a request while chatState is %s', (chatState) => {
    // Including `permission_pending`: nothing renders a card for it, so a
    // marker there would point at an empty tab.
    expect(sessionNeedsAttention(session({ chatState }))).toBe(false)
  })

  it('reads a legacy session that only has the singular mirror', () => {
    expect(sessionNeedsAttention(session({ pendingPermission: perm('r1'), pendingPermissions: undefined }))).toBe(true)
  })

  it('reads a session that only has the plural set', () => {
    expect(sessionNeedsAttention(session({
      pendingPermission: null,
      pendingPermissions: { r1: perm('r1') },
    }))).toBe(true)
  })

  it('stays dark for an emptied set with no mirror', () => {
    expect(sessionNeedsAttention(session({ pendingPermission: null, pendingPermissions: {} }))).toBe(false)
  })

  it.each(['Bash', 'AskUserQuestion', 'ExitPlanMode'])('lights for a %s request', (toolName) => {
    expect(sessionNeedsAttention(session(waiting(perm('r1', toolName))))).toBe(true)
  })

  it('does not count a Computer Use request, which has no card to answer', () => {
    expect(sessionNeedsAttention(session({
      pendingComputerUsePermission: { requestId: 'cu-1', request: {} as never },
      pendingComputerUsePermissions: { 'cu-1': { requestId: 'cu-1', request: {} as never } },
    }))).toBe(false)
  })

  it('stays dark for a session the store does not know', () => {
    expect(sessionNeedsAttention(undefined)).toBe(false)
  })
})

describe('collectAttentionIds', () => {
  const sessions = {
    a: session(waiting(perm('a1'))),
    b: session(),
    c: session(waiting(perm('c1', 'AskUserQuestion'))),
  }

  it('scans every session by default', () => {
    expect(collectAttentionIds(sessions)).toEqual(['a', 'c'])
  })

  it('limits the scan to the ids it is given, in that order', () => {
    expect(collectAttentionIds(sessions, ['c', 'b', 'a'])).toEqual(['c', 'a'])
  })

  it('ignores ids the store has no session for', () => {
    expect(collectAttentionIds(sessions, ['ghost', 'a'])).toEqual(['a'])
  })
})

describe('nextAttentionSessionId', () => {
  const order = ['a', 'b', 'c', 'd']

  it('takes the first waiting session after the active one', () => {
    expect(nextAttentionSessionId(order, new Set(['c', 'd']), 'a')).toBe('c')
  })

  it('wraps past the end of the strip', () => {
    expect(nextAttentionSessionId(order, new Set(['a', 'b']), 'c')).toBe('a')
  })

  it('never returns the active session, even when it is the only one waiting', () => {
    expect(nextAttentionSessionId(order, new Set(['b']), 'b')).toBeNull()
  })

  it('skips the active session when others are waiting too', () => {
    expect(nextAttentionSessionId(order, new Set(['b', 'd']), 'b')).toBe('d')
    expect(nextAttentionSessionId(order, new Set(['b', 'd']), 'd')).toBe('b')
  })

  it('returns null when nothing is waiting or the strip is empty', () => {
    expect(nextAttentionSessionId(order, new Set(), 'a')).toBeNull()
    expect(nextAttentionSessionId([], new Set(['a']), null)).toBeNull()
  })

  it('starts from the first tab when the active one is not in the strip', () => {
    // Settings, Market and friends are tabs but not sessions.
    expect(nextAttentionSessionId(order, new Set(['a', 'c']), '__settings__')).toBe('a')
    expect(nextAttentionSessionId(order, new Set(['c']), null)).toBe('c')
  })

  it('ignores waiting ids that have no tab', () => {
    expect(nextAttentionSessionId(order, new Set(['ghost']), 'a')).toBeNull()
  })
})
