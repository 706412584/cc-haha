// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore, type PerSessionState } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCLITaskStore } from '../stores/cliTaskStore'
import type { ActivityRow } from '../components/activity/sessionActivityModel'
import { AgentOfficePage, buildOfficeTaskDispatchMessage, dispatchOfficeTasks } from './AgentOffice'

vi.mock('../components/agentOffice/AgentOfficeRuntime', () => ({
  AgentOfficeRuntime: () => <div data-testid="agent-office-runtime" />,
}))

function session(chatState: PerSessionState['chatState']): PerSessionState {
  return {
    messages: [],
    chatState,
    connectionState: 'connected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    slashCommands: [],
    agentTaskNotifications: {},
    backgroundAgentTasks: {},
    elapsedTimer: null,
    messageQueue: [],
  }
}

const rows: ActivityRow[] = [
  {
    id: '2',
    section: 'tasks',
    label: 'Second task',
    status: 'pending',
    taskId: '2',
    owner: 'worker-agent',
    blockedBy: [],
    openable: false,
  },
  {
    id: '1',
    section: 'tasks',
    label: 'First task',
    status: 'pending',
    taskId: '1',
    blockedBy: [],
    openable: false,
  },
]

describe('Agent Office task dispatch', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useChatStore.setState({ sessions: {} })
    useCLITaskStore.setState(useCLITaskStore.getInitialState(), true)
  })

  it('fetches the route session task list on first mount and session switch', async () => {
    const fetchSessionTasks = vi.fn(async () => undefined)
    useCLITaskStore.setState({ fetchSessionTasks })
    const view = render(<AgentOfficePage sessionId="session-a" tabId="office-tab" />)

    await waitFor(() => expect(fetchSessionTasks).toHaveBeenCalledWith('session-a'))
    view.rerender(<AgentOfficePage sessionId="session-b" tabId="office-tab" />)
    await waitFor(() => expect(fetchSessionTasks).toHaveBeenCalledWith('session-b'))
  })

  it('builds a stable, auditable message using the route session and sorted task IDs', () => {
    expect(buildOfficeTaskDispatchMessage('office-session', rows)).toEqual({
      content: [
        'Evaluate and process these ready tasks in parallel where their file scopes and dependencies allow.',
        'Session task list: office-session',
        'Task IDs: 1, 2',
        '- #1: First task',
        '- #2: Second task (owner: worker-agent)',
        'Respect blockedBy dependencies and use exact Task owners when coordinating named Agents.',
      ].join('\n'),
      displayContent: 'Process ready tasks: First task, Second task',
    })
  })

  it.each([
    { chatState: 'idle' as const, action: 'sendMessage' as const },
    { chatState: 'thinking' as const, action: 'enqueueMessage' as const },
  ])('uses $action for $chatState Main state', ({ chatState, action }) => {
    const sendMessage = vi.fn()
    const enqueueMessage = vi.fn()
    useChatStore.setState({
      sessions: { 'office-session': session(chatState) },
      sendMessage,
      enqueueMessage,
    })

    dispatchOfficeTasks('office-session', rows)

    expect(action === 'sendMessage' ? sendMessage : enqueueMessage).toHaveBeenCalledWith(
      'office-session',
      expect.stringContaining('Task IDs: 1, 2'),
      undefined,
      { displayContent: 'Process ready tasks: First task, Second task' },
    )
    expect(action === 'sendMessage' ? enqueueMessage : sendMessage).not.toHaveBeenCalled()
  })
})
