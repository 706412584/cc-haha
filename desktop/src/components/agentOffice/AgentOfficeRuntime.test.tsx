import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSessionActivityModel } from '../activity/sessionActivityModel'
import type { SessionActivitySnapshot } from '../activity/useSessionActivityModel'
import { AgentOfficeRuntime } from './AgentOfficeRuntime'
import { useSettingsStore } from '../../stores/settingsStore'

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
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('counts and lists only live Agents while retaining completed history as a statistic', () => {
    render(<AgentOfficeRuntime sessionId="session-1" activity={snapshot()} />)

    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(screen.getAllByText('Review current changes')).toHaveLength(2)
    expect(screen.queryByText('Old completed review')).not.toBeInTheDocument()

    const completedCard = screen.getByText('Completed').closest('section')!
    expect(within(completedCard).getByText('1')).toBeInTheDocument()
  })

  it('renders locale-specific Office chrome without Simplified Chinese leakage', () => {
    useSettingsStore.setState({ locale: 'zh-TW' })

    render(<AgentOfficeRuntime sessionId="session-1" activity={snapshot()} />)

    expect(screen.getAllByText('進行中')).not.toHaveLength(0)
    expect(screen.getByText('目前任務流')).toBeInTheDocument()
    expect(screen.getByText('即時狀態')).toBeInTheDocument()
    expect(screen.queryByText('当前任务流')).not.toBeInTheDocument()
    expect(screen.queryByText('实时状态')).not.toBeInTheDocument()
  })
})
