import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import type { PerSessionState } from '../../stores/chatStore'
import { useChatStore } from '../../stores/chatStore'
import { useCLITaskStore } from '../../stores/cliTaskStore'
import { useTeamStore } from '../../stores/teamStore'
import { useActivityPanelStore } from '../../stores/activityPanelStore'
import { useSessionActivityModel } from './useSessionActivityModel'

function makeSessionState(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
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
    activeGoal: null,
    elapsedTimer: null,
    composerPrefill: null,
    composerDraft: null,
    ...overrides,
  }
}

describe('useSessionActivityModel', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} })
    useCLITaskStore.setState(useCLITaskStore.getInitialState(), true)
    useTeamStore.setState({
      teams: [],
      activeTeam: null,
      memberColors: new Map(),
      error: null,
    })
    useActivityPanelStore.setState(useActivityPanelStore.getInitialState(), true)
  })

  it('derives the live Office model from existing session, task, team, and background stores', () => {
    const sessionId = 'session-1'
    useChatStore.setState({
      sessions: {
        [sessionId]: makeSessionState({
          chatState: 'tool_executing',
          activeToolName: 'Agent',
          statusVerb: 'Delegating',
          backgroundAgentTasks: {
            'tool-bg': {
              taskId: 'bg-1',
              toolUseId: 'tool-bg',
              status: 'running',
              description: 'Explore renderer lifecycle',
              taskType: 'local_agent',
              startedAt: 1000,
              updatedAt: 2000,
            },
          },
        }),
      },
    })
    useCLITaskStore.setState({
      sessionId,
      tasks: [{
        id: '1',
        subject: 'Map live Agent states',
        description: '',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        taskListId: sessionId,
      }],
      completedAndDismissed: false,
    })
    useTeamStore.setState({
      activeTeam: {
        name: 'office-team',
        leadAgentId: 'lead',
        leadSessionId: sessionId,
        members: [
          { agentId: 'lead', role: 'Lead', status: 'running' },
          { agentId: 'designer', role: 'Designer', status: 'running', currentTask: 'Animate office' },
        ],
      },
    })

    const { result } = renderHook(() => useSessionActivityModel(sessionId))

    expect(result.current.mainAgent).toEqual({
      status: 'tool_executing',
      operationalStatus: 'foreground',
      activeToolName: 'Agent',
      statusVerb: 'Delegating',
    })
    expect(result.current.model.sections.tasks.rows[0]).toMatchObject({
      label: 'Map live Agent states',
      status: 'in_progress',
    })
    expect(result.current.model.sections.team.rows[0]).toMatchObject({
      label: 'Designer',
      status: 'running',
    })
    expect(result.current.model.sections.subagents.rows[0]).toMatchObject({
      label: 'Explore renderer lifecycle',
      status: 'running',
    })
  })

  it('derives truthful Main status and projects only the target session queue', () => {
    const sessionId = 'session-1'
    useChatStore.setState({
      sessions: {
        [sessionId]: makeSessionState({
          chatState: 'idle',
          backgroundAgentTasks: {
            'agent-tool': {
              taskId: 'agent-task',
              toolUseId: 'agent-tool',
              status: 'running',
              description: 'Review implementation',
              taskType: 'local_agent',
              startedAt: 1000,
              updatedAt: 2000,
            },
          },
          messageQueue: [{
            id: 'queue-1',
            content: 'Process task\nTask IDs: 1',
            displayContent: '处理任务 1',
            createdAt: 3000,
          }],
        }),
        other: makeSessionState({
          messageQueue: [{ id: 'wrong', content: 'Wrong queue', createdAt: 1 }],
        }),
      },
    })
    useCLITaskStore.setState({
      sessionId,
      tasks: [{
        id: '1',
        subject: 'Ready task',
        description: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        taskListId: sessionId,
      }],
    })

    const { result } = renderHook(() => useSessionActivityModel(sessionId))

    expect(result.current.mainAgent.operationalStatus).toBe('supervising')
    expect(result.current.model.sections.queue.rows).toHaveLength(1)
    expect(result.current.model.sections.queue.rows[0]?.queuedMessageId).toBe('queue-1')
  })

  it.each([
    {
      label: 'foreground work',
      session: { chatState: 'thinking' as const },
      tasks: [],
      expected: 'foreground',
    },
    {
      label: 'background command',
      session: {
        chatState: 'idle' as const,
        backgroundAgentTasks: {
          command: {
            taskId: 'command', status: 'running' as const, description: 'Build', taskType: 'shell', startedAt: 1, updatedAt: 2,
          },
        },
      },
      tasks: [],
      expected: 'background',
    },
    {
      label: 'ready task',
      session: { chatState: 'idle' as const },
      tasks: [{ id: 'ready', subject: 'Ready', description: '', status: 'pending' as const, blocks: [], blockedBy: [], taskListId: 'session-1' }],
      expected: 'ready',
    },
    {
      label: 'blocked tasks',
      session: { chatState: 'idle' as const },
      tasks: [{ id: 'blocked', subject: 'Blocked', description: '', status: 'pending' as const, blocks: [], blockedBy: ['dependency'], taskListId: 'session-1' }],
      expected: 'blocked',
    },
  ])('derives $label Main status', ({ session, tasks, expected }) => {
    useChatStore.setState({ sessions: { 'session-1': makeSessionState(session) } })
    useCLITaskStore.setState({ sessionId: 'session-1', tasks })

    const { result } = renderHook(() => useSessionActivityModel('session-1'))

    expect(result.current.mainAgent.operationalStatus).toBe(expected)
  })

  it('keeps a stable empty snapshot while activity derivation is disabled', () => {
    const sessionId = 'session-1'
    useChatStore.setState({
      sessions: {
        [sessionId]: makeSessionState({ chatState: 'thinking' }),
      },
    })

    const { result } = renderHook(() => useSessionActivityModel(sessionId, false))
    const initial = result.current

    useChatStore.setState({
      sessions: {
        [sessionId]: makeSessionState({ chatState: 'tool_executing' }),
      },
    })

    expect(result.current).toBe(initial)
    expect(result.current.mainAgent.status).toBe('idle')
    expect(result.current.model.sections.tasks.rows).toEqual([])
  })

  it('does not re-render when unrelated session fields change', () => {
    const sessionId = 'session-1'
    useChatStore.setState({
      sessions: {
        [sessionId]: makeSessionState(),
      },
    })
    let renders = 0
    function Consumer() {
      useSessionActivityModel(sessionId)
      renders += 1
      return null
    }
    render(<Consumer />)

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId]!,
            streamingText: 'unrelated streaming update',
            elapsedSeconds: 10,
          },
        },
      }))
    })

    expect(renders).toBe(1)
  })

  it('does not borrow CLI tasks tracked for another session', () => {
    useCLITaskStore.setState({
      sessionId: 'session-a',
      tasks: [{
        id: '1',
        subject: 'Wrong session task',
        description: '',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        taskListId: 'session-a',
      }],
    })

    const { result } = renderHook(() => useSessionActivityModel('session-b'))

    expect(result.current.model.sections.tasks.rows).toEqual([])
  })
})
