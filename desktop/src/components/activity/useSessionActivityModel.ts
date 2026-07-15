import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../../stores/chatStore'
import { useCLITaskStore } from '../../stores/cliTaskStore'
import { useTeamStore } from '../../stores/teamStore'
import { useActivityPanelStore } from '../../stores/activityPanelStore'
import type { ChatState } from '../../types/chat'
import { buildSessionActivityModel, type SessionActivityModel } from './sessionActivityModel'

const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: readonly string[] = []
const EMPTY_SESSION_ACTIVITY = {
  chatState: 'idle' as ChatState,
  activeToolName: null as string | null,
  statusVerb: '',
  messages: [] as NonNullable<ReturnType<typeof useChatStore.getState>['sessions'][string]>['messages'],
  backgroundAgentTasks: {} as NonNullable<ReturnType<typeof useChatStore.getState>['sessions'][string]>['backgroundAgentTasks'],
  agentTaskNotifications: {} as NonNullable<ReturnType<typeof useChatStore.getState>['sessions'][string]>['agentTaskNotifications'],
}
const EMPTY_TASK_STATE = {
  sessionId: null,
  tasks: [],
  completedAndDismissed: false,
} satisfies {
  sessionId: string | null
  tasks: never[]
  completedAndDismissed: boolean
}

export type MainAgentActivity = {
  status: ChatState
  activeToolName: string | null
  statusVerb: string
}

export type SessionActivitySnapshot = {
  mainAgent: MainAgentActivity
  model: SessionActivityModel
  isMemberSession: boolean
}

const EMPTY_ACTIVITY_SNAPSHOT: SessionActivitySnapshot = {
  isMemberSession: false,
  mainAgent: {
    status: 'idle',
    activeToolName: null,
    statusVerb: '',
  },
  model: buildSessionActivityModel({
    sessionId: '',
    messages: [],
    tasks: [],
    completedAndDismissed: false,
    backgroundTasks: [],
    agentNotifications: [],
    teamMembers: [],
  }),
}

export function useSessionActivityModel(
  sessionId: string | null,
  enabled = true,
): SessionActivitySnapshot {
  const targetSessionId = enabled ? sessionId ?? '' : ''
  const sessionState = useChatStore(useShallow((state) => {
    if (!enabled) return EMPTY_SESSION_ACTIVITY
    const session = state.sessions[targetSessionId]
    if (!session) return EMPTY_SESSION_ACTIVITY
    return {
      chatState: session.chatState,
      activeToolName: session.activeToolName,
      statusVerb: session.statusVerb,
      messages: session.messages,
      backgroundAgentTasks: session.backgroundAgentTasks,
      agentTaskNotifications: session.agentTaskNotifications,
    }
  }))
  const taskState = useCLITaskStore(useShallow((state) => enabled ? {
    sessionId: state.sessionId,
    tasks: state.tasks,
    completedAndDismissed: state.completedAndDismissed,
  } : EMPTY_TASK_STATE))
  const includeTasks = taskState.sessionId === sessionId
  const dismissedBackgroundTaskKeyList = useActivityPanelStore(
    (state) => enabled
      ? state.dismissedBackgroundTaskKeysBySession[targetSessionId]
        ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
      : EMPTY_DISMISSED_BACKGROUND_TASK_KEYS,
  )
  const isMemberSession = useTeamStore(
    (state) => enabled && sessionId ? state.getMemberBySessionId(sessionId) !== null : false,
  )
  const activeTeam = useTeamStore((state) => enabled ? state.activeTeam : null)
  const teamMembers = useMemo(() => {
    if (!activeTeam || activeTeam.leadSessionId !== sessionId) return []
    return activeTeam.members.filter(
      (member) => !activeTeam.leadAgentId || member.agentId !== activeTeam.leadAgentId,
    )
  }, [activeTeam, sessionId])
  const dismissedBackgroundTaskKeys = useMemo(
    () => new Set(dismissedBackgroundTaskKeyList),
    [dismissedBackgroundTaskKeyList],
  )

  return useMemo(() => enabled ? ({
    isMemberSession,
    mainAgent: {
      status: sessionState?.chatState ?? 'idle',
      activeToolName: sessionState?.activeToolName ?? null,
      statusVerb: sessionState?.statusVerb ?? '',
    },
    model: buildSessionActivityModel({
      sessionId: sessionId ?? '',
      messages: sessionState?.messages ?? [],
      tasks: includeTasks ? taskState.tasks : [],
      completedAndDismissed: includeTasks ? taskState.completedAndDismissed : false,
      backgroundTasks: Object.values(sessionState?.backgroundAgentTasks ?? {}),
      dismissedBackgroundTaskKeys,
      agentNotifications: Object.values(sessionState?.agentTaskNotifications ?? {}),
      teamMembers,
    }),
  }) : EMPTY_ACTIVITY_SNAPSHOT, [
    dismissedBackgroundTaskKeys,
    enabled,
    includeTasks,
    sessionId,
    sessionState?.activeToolName,
    sessionState?.agentTaskNotifications,
    sessionState?.backgroundAgentTasks,
    sessionState?.chatState,
    sessionState?.messages,
    sessionState?.statusVerb,
    taskState.completedAndDismissed,
    taskState.tasks,
    isMemberSession,
    teamMembers,
  ])
}
