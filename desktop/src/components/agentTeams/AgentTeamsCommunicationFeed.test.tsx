import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import type { TeamMember, TeamWorkbenchMessage, TeamWorkbenchSnapshot } from '../../types/team'
import { AgentTeamsCommunicationFeed } from './AgentTeamsCommunicationFeed'

function message(overrides: Partial<TeamWorkbenchMessage> & { id: string }): TeamWorkbenchMessage {
  return {
    from: 'builder',
    to: 'reviewer',
    recipients: ['reviewer'],
    kind: 'direct',
    text: 'body',
    timestamp: '2026-08-08T07:42:16.666Z',
    ...overrides,
  }
}

const MEMBERS: TeamMember[] = [
  { agentId: 'lead@team-a', name: 'lead', role: 'orchestrator', status: 'running' },
  { agentId: 'builder@team-a', name: 'builder', role: 'server engineer', status: 'running' },
  { agentId: 'reviewer@team-a', name: 'reviewer', role: 'qa engineer', status: 'idle' },
]

function snapshot(
  messages: TeamWorkbenchMessage[],
  members: TeamMember[] = MEMBERS,
): TeamWorkbenchSnapshot {
  return {
    version: 'v1',
    generatedAt: '2026-08-08T08:00:00.000Z',
    team: {
      name: 'team-a',
      leadAgentId: 'lead@team-a',
      leadSessionId: 'lead-session',
      members,
    },
    tasks: [],
    messages,
  }
}

function categoryOf(id: string): string | null {
  return screen.getByTestId(`agent-teams-message-${id}`).getAttribute('data-message-category')
}

describe('AgentTeamsCommunicationFeed', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('maps real CLI routes into assignment, peer, report, and system categories', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({
        id: 'protocol-assignment',
        from: 'lead',
        to: 'builder@team-a',
        recipients: ['builder@team-a'],
        kind: 'system',
        protocolType: 'task_assignment',
        taskId: '2',
        text: '{"type":"task_assignment","taskId":"2","subject":"Build it"}',
      }),
      message({
        id: 'self-claim',
        from: 'builder',
        to: 'builder@team-a',
        recipients: ['builder@team-a'],
        kind: 'system',
        protocolType: 'task_assignment',
        taskId: '3',
        text: '{"type":"task_assignment","taskId":"3","subject":"Claim it"}',
      }),
      message({ id: 'lead-direct', from: 'lead', to: 'builder@team-a', recipients: ['builder@team-a'], text: 'Please own the API.' }),
      message({ id: 'peer-direct', from: 'builder@team-a', to: 'reviewer', recipients: ['reviewer'], text: 'Can you verify the route?' }),
      message({ id: 'worker-report', from: 'builder', to: 'lead@team-a', recipients: ['lead@team-a'], text: 'API implementation is ready.' }),
      message({
        id: 'lifecycle',
        from: 'builder@team-a',
        to: 'team-lead@team-a',
        recipients: ['team-lead@team-a'],
        kind: 'system',
        text: '{"type":"idle_notification","idleReason":"available"}',
      }),
      message({ id: 'lead-broadcast', from: 'lead@team-a', kind: 'broadcast', to: '*', recipients: ['*'], text: 'Everyone take the next ready task.' }),
      message({ id: 'worker-broadcast', from: 'reviewer@team-a', kind: 'broadcast', to: '*', recipients: ['*'], text: 'Review summary is published.' }),
    ])} />)

    expect(categoryOf('protocol-assignment')).toBe('assignment')
    expect(categoryOf('self-claim')).toBe('system')
    expect(categoryOf('lead-direct')).toBe('assignment')
    expect(categoryOf('lead-broadcast')).toBe('assignment')
    expect(categoryOf('peer-direct')).toBe('peer')
    expect(categoryOf('worker-report')).toBe('report')
    expect(categoryOf('worker-broadcast')).toBe('report')
    expect(categoryOf('lifecycle')).toBe('system')
    expect(within(screen.getByTestId('agent-teams-message-worker-report')).getByText('Reports')).toBeTruthy()
    expect(within(screen.getByTestId('agent-teams-message-peer-direct')).getByText('Direct').className).toContain('color-tertiary')
    expect(within(screen.getByTestId('agent-teams-message-worker-report')).getByText('Reports').className).toContain('color-text-secondary')
    expect(screen.getByText('Review summary is published.')).toBeTruthy()
  })

  it('always shows the five semantic filters and filters without using transport kind', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'assignment', from: 'lead', to: 'builder', recipients: ['builder'], text: 'Take task one.' }),
      message({ id: 'peer', from: 'builder', to: 'reviewer', recipients: ['reviewer'], text: 'Private review.' }),
      message({ id: 'report', from: 'builder', to: 'lead', recipients: ['lead'], text: 'Task one is done.' }),
      message({ id: 'system', kind: 'system', protocolType: 'custom_event', text: '{"type":"custom_event","message":"Context loaded"}' }),
    ])} />)

    expect(screen.getByTestId('agent-teams-message-count').textContent).toBe('4 messages')
    expect(screen.getByTestId('agent-teams-filter-all')).toBeTruthy()
    expect(screen.getByTestId('agent-teams-filter-assignment').getAttribute('data-count')).toBe('1')
    expect(screen.getByTestId('agent-teams-filter-peer').getAttribute('data-count')).toBe('1')
    expect(screen.getByTestId('agent-teams-filter-report').getAttribute('data-count')).toBe('1')
    expect(screen.getByTestId('agent-teams-filter-system').getAttribute('data-count')).toBe('1')

    for (const category of ['assignment', 'peer', 'report', 'system'] as const) {
      fireEvent.click(screen.getByTestId(`agent-teams-filter-${category}`))
      expect(screen.getByTestId(`agent-teams-message-${category}`)).toBeTruthy()
      for (const other of ['assignment', 'peer', 'report', 'system']) {
        if (other !== category) expect(screen.queryByTestId(`agent-teams-message-${other}`)).toBeNull()
      }
    }
  })

  it('narrates assignment and lifecycle protocols in one line without leaking JSON', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({
        id: 'assignment',
        from: 'lead',
        to: 'builder',
        recipients: ['builder'],
        kind: 'system',
        protocolType: 'task_assignment',
        taskId: '7',
        text: '{"type":"task_assignment","taskId":"7","subject":"Repair queue"}',
      }),
      message({
        id: 'idle',
        from: 'builder',
        to: 'lead',
        recipients: ['lead'],
        kind: 'system',
        text: '{"type":"idle_notification","idleReason":"available"}',
      }),
    ])} />)

    expect(screen.getByText(/Assigned #7 Repair queue to builder/)).toBeTruthy()
    expect(screen.getByText(/Went idle, waiting for work · available/)).toBeTruthy()
    expect(screen.getByTestId('agent-teams-message-assignment-body').className).toContain('truncate')
    expect(screen.getByTestId('agent-teams-message-idle-body').className).toContain('truncate')
    expect(document.body.textContent).not.toContain('"taskId"')
    expect(document.body.textContent).not.toContain('idle_notification')
  })

  it('localizes an unknown structured protocol instead of inventing an English label', () => {
    useSettingsStore.setState({ locale: 'zh' })
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({
        id: 'custom',
        kind: 'system',
        protocolType: 'custom_event',
        text: '{"type":"custom_event","payload":42}',
      }),
    ])} />)

    expect(screen.getByTestId('agent-teams-message-custom-body').textContent).toBe('系统')
    expect(document.body.textContent).not.toContain('Custom event')
  })

  it('keeps authored Markdown readable and uses compact 22px routing figures', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({
        id: 'markdown',
        from: 'builder@team-a',
        to: 'reviewer',
        text: '## Finding A\n\n**Key evidence**\n\n```ts\nconst fixed = true\n```',
      }),
    ])} />)

    const row = screen.getByTestId('agent-teams-message-markdown')
    expect(row.querySelector('h2')?.textContent).toBe('Finding A')
    expect(row.querySelector('strong')?.textContent).toBe('Key evidence')
    expect(row.textContent).not.toContain('## Finding A')
    expect(screen.getByTestId('agent-teams-message-markdown-from').textContent).toBe('builder@team-a')
    expect(screen.getByTestId('agent-teams-message-markdown-to').textContent).toBe('reviewer')
    expect(screen.getByTestId('agent-teams-message-markdown-from-avatar').className).toContain('h-[22px]')
    expect(screen.getByTestId('agent-teams-message-markdown-from-avatar').getAttribute('data-avatar-key')).toBe('server-engineer')
    expect(screen.getByTestId('agent-teams-message-markdown-to-avatar').getAttribute('data-avatar-key')).toBe('security-reviewer')
  })

  it('keeps a long human message behind an explicit expander', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'long', kind: 'broadcast', to: '*', recipients: ['*'], text: 'x'.repeat(400) }),
    ])} />)

    expect(screen.getByTestId('agent-teams-message-long-body').getAttribute('data-collapsed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByTestId('agent-teams-message-long-body').getAttribute('data-collapsed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByTestId('agent-teams-message-long-body').getAttribute('data-collapsed')).toBe('true')
  })

  it('folds adjacent duplicate lifecycle signals into the newest row', () => {
    const idle = (id: string) => message({
      id,
      from: 'builder',
      to: 'lead',
      recipients: ['lead'],
      kind: 'system',
      text: '{"type":"idle_notification","idleReason":"available"}',
    })
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'report', from: 'builder', to: 'lead', recipients: ['lead'], text: 'Ready for more work.' }),
      idle('i1'),
      idle('i2'),
      idle('i3'),
    ])} />)

    expect(screen.getByTestId('agent-teams-message-count').textContent).toBe('4 messages')
    expect(screen.getByTestId('agent-teams-message-i3-repeats').textContent).toBe('×3')
    expect(screen.queryByTestId('agent-teams-message-i2')).toBeNull()
    expect(screen.queryByTestId('agent-teams-message-i1')).toBeNull()
  })

  it('keeps task hover focus and its reset callback', () => {
    const onFocusTask = vi.fn()
    render(<AgentTeamsCommunicationFeed
      snapshot={snapshot([message({ id: 'task', taskId: '42', text: 'Please review task 42.' })])}
      onFocusTask={onFocusTask}
    />)

    const row = screen.getByTestId('agent-teams-message-task')
    fireEvent.mouseEnter(row)
    fireEvent.mouseLeave(row)

    expect(onFocusTask.mock.calls).toEqual([['42'], [null]])
  })

  it('keeps per-message wall time but removes the local early/middle/late controls', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'first', text: 'first', timestamp: '2026-08-08T07:42:00.000Z' }),
      message({ id: 'second', text: 'second', timestamp: '2026-08-08T09:15:00.000Z' }),
    ])} />)

    const times = ['first', 'second'].map((id) => (
      screen.getByTestId(`agent-teams-message-${id}`).querySelector('time')?.textContent
    ))
    expect(times[0]).toBeTruthy()
    expect(times[0]).not.toBe(times[1])
    expect(screen.queryByTestId('agent-teams-time-range')).toBeNull()
    expect(screen.queryByTestId('agent-teams-time-early')).toBeNull()
    expect(screen.queryByTestId('agent-teams-time-middle')).toBeNull()
    expect(screen.queryByTestId('agent-teams-time-late')).toBeNull()
    expect(screen.queryByTestId('agent-teams-lifecycle-toggle')).toBeNull()
  })

  it('keeps route figures available when archived member metadata is missing', () => {
    render(<AgentTeamsCommunicationFeed snapshot={snapshot([
      message({ id: 'unknown', from: 'unknown-builder', to: 'unknown-reviewer' }),
    ], [])} />)

    expect(screen.getByTestId('agent-teams-message-unknown-from-avatar').getAttribute('data-avatar-key')).toBeTruthy()
    expect(screen.getByTestId('agent-teams-message-unknown-to-avatar').getAttribute('data-avatar-key')).toBeTruthy()
  })
})
