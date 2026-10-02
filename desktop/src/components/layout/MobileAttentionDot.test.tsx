import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { createDefaultSessionState, useChatStore, type PerSessionState } from '../../stores/chatStore'
import { MobileAttentionDot } from './MobileAttentionDot'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => key,
}))

function session(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return { ...createDefaultSessionState(), ...overrides }
}

const openRequest: Partial<PerSessionState> = {
  pendingPermission: { requestId: 'r1', toolName: 'Bash', toolUseId: 'tu-1', input: {} },
  pendingPermissions: { r1: { requestId: 'r1', toolName: 'Bash', toolUseId: 'tu-1', input: {} } },
}

function seed(sessions: Record<string, PerSessionState>) {
  act(() => {
    useChatStore.setState({ sessions })
  })
}

describe('MobileAttentionDot', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} })
  })

  afterEach(() => {
    cleanup()
    useChatStore.setState({ sessions: {} })
  })

  it('renders nothing while no session is waiting', () => {
    seed({ a: session(), b: session({ chatState: 'thinking' }) })
    const { container } = render(<MobileAttentionDot activeSessionId="a" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('lights when a session other than the one on screen is waiting', () => {
    seed({ a: session(), b: session(openRequest) })
    render(<MobileAttentionDot activeSessionId="a" />)

    expect(screen.getByTestId('mobile-attention-dot')).toBeInTheDocument()
    expect(screen.getByText('sidebar.sessionNeedsAttention')).toHaveClass('sr-only')
  })

  it('stays dark when the only waiting session is the one on screen', () => {
    seed({ a: session(openRequest), b: session() })
    const { container } = render(<MobileAttentionDot activeSessionId="a" />)

    // Its card is already in front of the person.
    expect(container).toBeEmptyDOMElement()
  })

  it('lights from a page that is not a session, such as Settings', () => {
    seed({ a: session(openRequest) })
    render(<MobileAttentionDot activeSessionId={null} />)

    expect(screen.getByTestId('mobile-attention-dot')).toBeInTheDocument()
  })

  it('counts sessions that have no tab, since the drawer lists them all', () => {
    // Nothing here mentions tabs: the dot reads the chat store, not the strip.
    seed({ a: session(), 'no-tab': session(openRequest) })
    render(<MobileAttentionDot activeSessionId="a" />)

    expect(screen.getByTestId('mobile-attention-dot')).toBeInTheDocument()
  })

  it('does not light for chatState alone, since no card exists for it', () => {
    seed({ a: session(), b: session({ chatState: 'permission_pending' }) })
    const { container } = render(<MobileAttentionDot activeSessionId="a" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('goes out once the request is answered', () => {
    seed({ a: session(), b: session(openRequest) })
    render(<MobileAttentionDot activeSessionId="a" />)
    expect(screen.getByTestId('mobile-attention-dot')).toBeInTheDocument()

    seed({ a: session(), b: session({ pendingPermission: null, pendingPermissions: {} }) })

    expect(screen.queryByTestId('mobile-attention-dot')).not.toBeInTheDocument()
  })

  it('is decorative for a screen reader, which gets the hidden text instead', () => {
    seed({ a: session(), b: session(openRequest) })
    render(<MobileAttentionDot activeSessionId="a" />)

    expect(screen.getByTestId('mobile-attention-dot')).toHaveAttribute('aria-hidden', 'true')
  })
})
