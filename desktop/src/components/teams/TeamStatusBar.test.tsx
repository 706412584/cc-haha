import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '../../stores/settingsStore'
import { useTeamStore } from '../../stores/teamStore'
import type { TeamMember } from '../../types/team'
import { TeamStatusBar } from './TeamStatusBar'

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    agentId: 'agent-1',
    role: 'reviewer',
    status: 'idle',
    ...overrides,
  } as TeamMember
}

function setTeam(members: TeamMember[], leadAgentId?: string) {
  useTeamStore.setState({
    activeTeam: { id: 'team-1', name: 'Alpha', leadAgentId, members } as never,
    openMemberSession: vi.fn(),
  } as never)
}

describe('TeamStatusBar', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTeamStore.setState({ activeTeam: null } as never)
  })

  it('renders nothing without an active team', () => {
    const { container } = render(<TeamStatusBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it('exposes progress as a named progressbar', () => {
    // Only one progress bar in the app had role="progressbar" before this;
    // this one was hand-rolled markup with no semantics at all.
    setTeam([
      member({ agentId: 'a', status: 'completed' }),
      member({ agentId: 'b', status: 'running' }),
    ])
    render(<TeamStatusBar />)

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAccessibleName(/Alpha/)
    expect(bar).toHaveAttribute('aria-valuenow', '50')
  })

  it('excludes the lead from the member list and the count', () => {
    setTeam([
      member({ agentId: 'lead', role: 'lead' }),
      member({ agentId: 'worker', role: 'worker', status: 'completed' }),
    ], 'lead')
    render(<TeamStatusBar />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.queryByText('lead')).not.toBeInTheDocument()
    expect(screen.getByText('worker')).toBeInTheDocument()
  })

  it('turns green when nothing is running, not at 100%', () => {
    // `tone="auto"` keys off the percentage; this bar's rule is "nothing is
    // running", so one completed plus one errored is done at 50%.
    setTeam([
      member({ agentId: 'a', status: 'completed' }),
      member({ agentId: 'b', status: 'error' }),
    ])
    const { container } = render(<TeamStatusBar />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(container.querySelector('[role="progressbar"] > div')?.className)
      .toContain('--color-success')
  })

  it('shows a pulsing dot only while members are running', () => {
    // The dot carries no accessible name on purpose — the count beside it
    // already says "N running", and naming both makes a screen reader
    // announce the same state twice.
    // Two sources pulse together: the header dot and the member row's status
    // glyph. Both use `animate-pulse-dot` (1.5s) rather than the generic
    // `animate-pulse` (2s), so they breathe in step.
    setTeam([member({ agentId: 'a', status: 'running' })])
    const { container, rerender } = render(<TeamStatusBar />)
    expect(container.querySelectorAll('.animate-pulse-dot')).toHaveLength(2)
    expect(container.querySelector('span.animate-pulse-dot[aria-hidden="true"]')).toBeInTheDocument()

    setTeam([member({ agentId: 'a', status: 'completed' })])
    rerender(<TeamStatusBar />)
    expect(container.querySelectorAll('.animate-pulse-dot')).toHaveLength(0)
  })

  it('collapses and expands the member list', () => {
    setTeam([member({ agentId: 'a', role: 'worker' })])
    render(<TeamStatusBar />)

    expect(screen.getByText('worker')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('progressbar').closest('button')!)
    expect(screen.queryByText('worker')).not.toBeInTheDocument()
  })

  it('opens a member session on click', () => {
    const openMemberSession = vi.fn()
    useTeamStore.setState({
      activeTeam: { id: 'team-1', name: 'Alpha', members: [member({ agentId: 'a', role: 'worker' })] } as never,
      openMemberSession,
    } as never)
    render(<TeamStatusBar />)

    fireEvent.click(screen.getByText('worker').closest('button')!)
    expect(openMemberSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a' }))
  })

  it('surfaces the current task of a running member', () => {
    setTeam([member({ agentId: 'a', status: 'running', currentTask: 'Reading the diff' })])
    render(<TeamStatusBar />)
    expect(screen.getByText('Reading the diff')).toBeInTheDocument()
  })
})
