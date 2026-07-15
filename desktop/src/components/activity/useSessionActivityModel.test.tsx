import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
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
