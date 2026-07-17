import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSessionActivityModel } from '../activity/sessionActivityModel'
import type { SessionActivitySnapshot } from '../activity/useSessionActivityModel'
import { AgentOfficeRuntime } from './AgentOfficeRuntime'
import { useSettingsStore } from '../../stores/settingsStore'

const canvasProps = vi.hoisted(() => ({
  current: null as null | {
    agents?: Array<{ sourceKey?: string; state: string }>
    selectedSourceKey?: string | null
    onSelectAgent?: (sourceKey: string) => void
  },
}))

vi.mock('./OfficeCanvas', () => ({
  OfficeCanvas: (props: typeof canvasProps.current) => {
    canvasProps.current = props
    return <div data-testid="office-canvas" data-selected-source-key={props?.selectedSourceKey ?? ''} />
  },
}))

function snapshot(backgroundTasks?: Parameters<typeof buildSessionActivityModel>[0]['backgroundTasks']): SessionActivitySnapshot {
  return {
    isMemberSession: false,
    mainAgent: {
      status: 'tool_executing',
      operationalStatus: 'foreground',
      activeToolName: 'Agent',
      statusVerb: 'Delegating',
    },
    model: buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: backgroundTasks ?? [
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
    canvasProps.current = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts and lists only live Agents while retaining completed history as a statistic', () => {
    render(<AgentOfficeRuntime sessionId="session-1" activity={snapshot()} />)

    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(screen.getByText('Review current changes')).toBeInTheDocument()
    expect(screen.queryByText('Old completed review')).not.toBeInTheDocument()

    const completedCard = screen.getByText('Completed').closest('section')!
    expect(within(completedCard).getByText('1')).toBeInTheDocument()
  })

  it('keeps real idle team members in the Office roster', () => {
    const activity = snapshot([])
    activity.model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
      teamMembers: [{ agentId: 'designer', role: 'Designer', status: 'idle' }],
    })

    render(<AgentOfficeRuntime sessionId="session-1" activity={activity} />)

    expect(canvasProps.current).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ sourceKey: 'team:designer', state: 'idle' }),
      ]),
    })
  })

  it('expires timed failure attention without an external activity update', () => {
    vi.useFakeTimers()
    const startedAt = new Date('2026-07-16T00:00:00Z').getTime()
    vi.setSystemTime(startedAt)
    render(<AgentOfficeRuntime sessionId="session-1" activity={snapshot([{
      taskId: 'failed-task',
      status: 'failed',
      description: 'Build failed',
      taskType: 'shell',
      startedAt,
      updatedAt: startedAt,
    }])} />)
    expect(screen.getByText('Build failed')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(5 * 60_000 + 30_000)
    })

    expect(screen.queryByText('Build failed')).not.toBeInTheDocument()
  })

  it('keeps the selected activity row and Pixi agent synchronized by source key', () => {
    render(<AgentOfficeRuntime sessionId="session-1" activity={snapshot()} />)

    const activityButton = screen.getByRole('button', { name: /Review current changes/ })
    fireEvent.click(activityButton)

    expect(activityButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('office-canvas')).toHaveAttribute(
      'data-selected-source-key',
      'subagents:live-agent-tool',
    )

    act(() => {
      canvasProps.current?.onSelectAgent?.('subagents:live-agent-tool')
    })
    expect(activityButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens the selected SubAgent through the existing run action', () => {
    const onOpenSubagent = vi.fn()
    render(
      <AgentOfficeRuntime
        sessionId="session-1"
        activity={snapshot()}
        onOpenSubagent={onOpenSubagent}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Review current changes/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Full run' }))

    expect(onOpenSubagent).toHaveBeenCalledWith({
      sessionId: 'session-1',
      toolUseId: 'live-agent-tool',
      title: 'Review current changes',
    })
  })

  it('dismisses failed background activity through its existing dismiss key', () => {
    const onDismissActivityRows = vi.fn()
    render(
      <AgentOfficeRuntime
        sessionId="session-1"
        activity={snapshot([{
          taskId: 'failed-task',
          status: 'failed',
          description: 'Build failed',
          taskType: 'shell',
          startedAt: Date.now(),
          updatedAt: Date.now(),
        }])}
        onDismissActivityRows={onDismissActivityRows}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }))
    expect(onDismissActivityRows).toHaveBeenCalledWith([expect.any(String)])
  })

  it('operates ready tasks, queues, and TeamMember messages through explicit callbacks', () => {
    const activity = snapshot([])
    activity.mainAgent = {
      status: 'idle',
      operationalStatus: 'ready',
      activeToolName: null,
      statusVerb: '',
    }
    activity.model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [
        {
          id: 'ready-2', subject: 'Second ready task', description: '', status: 'pending', owner: 'main-agent', blocks: [], blockedBy: [], taskListId: 'session-1',
        },
        {
          id: 'blocked-1', subject: 'Blocked task', description: '', status: 'pending', owner: 'worker-agent', blocks: [], blockedBy: ['ready-2'], taskListId: 'session-1',
        },
        {
          id: 'ready-1', subject: 'First ready task', description: '', status: 'pending', blocks: [], blockedBy: [], taskListId: 'session-1',
        },
      ],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
      teamMembers: [{ agentId: 'designer', role: 'Designer', status: 'idle' }],
      queuedMessages: [{
        id: 'queue-1',
        content: 'Process task\nTask IDs: ready-1',
        displayContent: 'Process first ready task',
        createdAt: 1000,
      }],
    })
    const onDispatchTasks = vi.fn()
    const onSendQueuedMessageNow = vi.fn()
    const onRemoveQueuedMessage = vi.fn()
    const onSendMemberMessage = vi.fn()

    render(
      <AgentOfficeRuntime
        sessionId="session-1"
        activity={activity}
        onDispatchTasks={onDispatchTasks}
        onSendQueuedMessageNow={onSendQueuedMessageNow}
        onRemoveQueuedMessage={onRemoveQueuedMessage}
        onSendMemberMessage={onSendMemberMessage}
      />,
    )

    expect(screen.getByText('Owner: main-agent')).toBeInTheDocument()
    expect(screen.getByText('Blocked by: ready-2')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Select Blocked task' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Second ready task' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select First ready task' }))
    fireEvent.click(screen.getByRole('button', { name: 'Process selected tasks now' }))
    expect(onDispatchTasks).toHaveBeenCalledWith(['ready-1', 'ready-2'])

    fireEvent.click(screen.getByRole('button', { name: /Process first ready task/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send queued message now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }))
    expect(onSendQueuedMessageNow).toHaveBeenCalledWith('queue-1')
    expect(onRemoveQueuedMessage).toHaveBeenCalledWith('queue-1')

    fireEvent.click(screen.getByRole('button', { name: /Designer/ }))
    fireEvent.change(screen.getByPlaceholderText('Message this TeamMember'), { target: { value: 'Share progress' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to TeamMember' }))
    expect(onSendMemberMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'designer' }),
      'Share progress',
    )
  })

  it('labels busy Main task actions as next-turn queueing', () => {
    const activity = snapshot([])
    activity.model = buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [{
        id: 'ready', subject: 'Ready task', description: '', status: 'pending', blocks: [], blockedBy: [], taskListId: 'session-1',
      }],
      completedAndDismissed: false,
      backgroundTasks: [],
      agentNotifications: [],
    })

    render(
      <AgentOfficeRuntime
        sessionId="session-1"
        activity={activity}
        dispatchMode="queue"
        onDispatchTasks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Ready task/ }))
    expect(screen.getByRole('button', { name: 'Add this task to next turn' })).toBeInTheDocument()
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
