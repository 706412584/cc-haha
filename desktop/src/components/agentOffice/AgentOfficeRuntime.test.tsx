import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildSessionActivityModel } from '../activity/sessionActivityModel'
import type { SessionActivitySnapshot } from '../activity/useSessionActivityModel'
import { AgentOfficeRuntime } from './AgentOfficeRuntime'

vi.mock('./OfficeCanvas', () => ({
  OfficeCanvas: () => <div data-testid="office-canvas" />,
}))

function snapshot(): SessionActivitySnapshot {
  return {
    isMemberSession: false,
    mainAgent: {
      status: 'tool_executing',
      activeToolName: 'Agent',
      statusVerb: 'Delegating',
    },
    model: buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [
        {
          taskId: 'live-agent',
          toolUseId: 'live-agent-tool',
          status: 'running',
          description: 'Review current changes',
          taskType: 'local_agent',
          startedAt: 1,
          updatedAt: 2,
        },
        {
          taskId: 'old-agent',
          toolUseId: 'old-agent-tool',
          status: 'completed',
          description: 'Old completed review',
          taskType: 'local_agent',
          startedAt: 1,
          updatedAt: 2,
        },
      ],
      agentNotifications: [],
    }),
  }
}

describe('AgentOfficeRuntime', () => {
  it('counts and lists only live Agents while retaining completed history as a statistic', () => {
    render(<AgentOfficeRuntime sessionId="session-1" activity={snapshot()} />)

    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(screen.getAllByText('Review current changes')).toHaveLength(2)
    expect(screen.queryByText('Old completed review')).not.toBeInTheDocument()

    const completedCard = screen.getByText('已完成').closest('section')!
    expect(within(completedCard).getByText('1')).toBeInTheDocument()
  })
})
