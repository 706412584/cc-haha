import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const { reportMock } = vi.hoisted(() => ({
  reportMock: vi.fn(async () => undefined),
}))

vi.mock('../../lib/diagnosticsCapture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/diagnosticsCapture')>()),
  reportReactError: reportMock,
}))

// A card that fails the way an unforeseen stored record would. What breaks a real one
// is beside the point here; this file is about where the failure is allowed to land.
vi.mock('./AskUserQuestion', () => ({
  AskUserQuestion: ({ toolUseId }: { toolUseId: string }) => {
    if (toolUseId === 'tool-poisoned') throw new Error('card exploded')
    return <div>question card {toolUseId}</div>
  },
}))

import { MessageList } from './MessageList'
import { sessionsApi } from '../../api/sessions'
import { useChatStore, type PerSessionState } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useTeamStore } from '../../stores/teamStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { UIMessage } from '../../types/chat'

const ACTIVE_TAB = 'active-tab'

function makeSessionState(messages: UIMessage[]): PerSessionState {
  return {
    messages,
    chatState: 'idle',
    connectionState: 'connected',
    historyStatus: 'ready',
    historyHydrated: true,
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
    apiRetry: null,
    slashCommands: [],
    agentTaskNotifications: {},
    elapsedTimer: null,
    composerPrefill: null,
  }
}

function askMessage(toolUseId: string, timestamp: number): UIMessage {
  return {
    id: `ask-${toolUseId}`,
    type: 'tool_use',
    toolName: 'AskUserQuestion',
    toolUseId,
    input: { questions: [{ question: 'Which scope?', options: [{ label: 'A' }, { label: 'B' }] }] },
    timestamp,
  }
}

describe('MessageList item containment', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    reportMock.mockClear()
    // React logs every caught render error; keep the output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: ACTIVE_TAB,
      tabs: [{ sessionId: ACTIVE_TAB, title: 'Test', type: 'session' as const, status: 'idle' }],
    })
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useTeamStore.getState().clearTeam()
    useWorkspaceChatContextStore.setState(useWorkspaceChatContextStore.getInitialState(), true)
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
    vi.spyOn(sessionsApi, 'getTurnCheckpoints').mockImplementation(() => new Promise(() => {}))
    vi.spyOn(sessionsApi, 'getWorkspaceStatus').mockResolvedValue({
      state: 'ok',
      workDir: '/tmp/example-project',
      repoName: 'example-project',
      branch: null,
      isGitRepo: false,
      changedFiles: [],
    })
  })

  // Issue #1400: one poisoned record in a saved transcript used to replace the whole
  // app with the root error page, again on every launch.
  it('keeps a row that fails to render from taking the transcript down', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState([
          { id: 'user-1', type: 'user_text', content: 'clean up the temp files', timestamp: 1 },
          { id: 'assistant-1', type: 'assistant_text', content: 'reply before the bad card', timestamp: 2 },
          askMessage('tool-poisoned', 3),
          { id: 'assistant-2', type: 'assistant_text', content: 'reply after the bad card', timestamp: 4 },
        ]),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('clean up the temp files')).toBeTruthy()
    expect(screen.getByText('reply before the bad card')).toBeTruthy()
    expect(screen.getByText('reply after the bad card')).toBeTruthy()
    expect(screen.getByText(/This item couldn't be displayed/)).toBeTruthy()
    expect(reportMock).toHaveBeenCalledTimes(1)
  })

  it('leaves healthy cards in the same transcript rendered', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState([
          // Answered, so it stays in the history; only the latest unresolved question
          // is ever shown, which would hide it otherwise.
          askMessage('tool-fine', 1),
          {
            id: 'result-fine',
            type: 'tool_result',
            toolUseId: 'tool-fine',
            content: { answers: { 'Which scope?': 'A' } },
            isError: false,
            timestamp: 2,
          },
          askMessage('tool-poisoned', 3),
        ]),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('question card tool-fine')).toBeTruthy()
    expect(screen.getAllByText(/This item couldn't be displayed/)).toHaveLength(1)
  })

  it('shows no notice and reports nothing for a transcript that renders', () => {
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: makeSessionState([
          { id: 'assistant-1', type: 'assistant_text', content: 'all good here', timestamp: 1 },
          askMessage('tool-fine', 2),
        ]),
      },
    })

    render(<MessageList />)

    expect(screen.getByText('all good here')).toBeTruthy()
    expect(screen.queryByText(/couldn't be displayed/)).toBeNull()
    expect(reportMock).not.toHaveBeenCalled()
  })
})
