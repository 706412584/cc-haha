import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { GitFork, Target } from 'lucide-react'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  TEAM_TAB_PREFIX,
  TERMINAL_TAB_PREFIX,
  TRACE_TAB_PREFIX,
  WORKBENCH_TAB_PREFIX,
  useTabStore,
  type TabType,
} from '../stores/tabStore'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { useSessionRuntimeStore } from '../stores/sessionRuntimeStore'
import { projectsApi } from '../api/projects'
import { wsManager } from '../api/websocket'
import { useCLITaskStore } from '../stores/cliTaskStore'
import { teamTaskWindowsForSnapshot, useTeamStore } from '../stores/teamStore'
import { useWorkspacePanelStore } from '../stores/workspacePanelStore'
import {
  TERMINAL_PANEL_DEFAULT_HEIGHT,
  TERMINAL_PANEL_MAX_HEIGHT,
  TERMINAL_PANEL_MIN_HEIGHT,
  useTerminalPanelStore,
} from '../stores/terminalPanelStore'
import { useTranslation } from '../i18n'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/LoadingState'
import { Tooltip } from '@/components/ui/Tooltip'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { MessageList } from '../components/chat/MessageList'
import { ChatInput } from '../components/chat/ChatInput'
import {
  SessionChatHeader,
  SessionChatSurface,
  type SessionHeaderMetaItem,
} from '@/components/chat/SessionChatSurface'
import { getWorktreeDisplayName, WorktreeDetails } from '../components/chat/WorktreeDetails'
import { ComputerUsePermissionModal } from '../components/chat/ComputerUsePermissionModal'
import { Modal } from '@/components/ui/Modal'
import { SessionTaskBar } from '../components/chat/SessionTaskBar'
import { SoloCouncilPanel } from '../components/chat/SoloCouncilPanel'
import { BackgroundTasksBar } from '../components/chat/BackgroundTasksBar'
import { SessionActivityButton } from '../components/activity/SessionActivityButton'
import {
  SessionActivityPanel,
  type OpenSubagentPayload,
} from '../components/activity/SessionActivityPanel'
import { buildMainSessionActivityModel, hasVisibleSessionActivity } from '../components/activity/sessionActivityModel'
import { WorkbenchPanel } from '../components/workbench/WorkbenchPanel'
import { TeamStatusBar } from '../components/teams/TeamStatusBar'
import { AgentTeamsStrip } from '../components/agentTeams/AgentTeamsSummary'
import { snapshotWithHistoricalMembers } from '../components/agentTeams/agentTeamsModel'
import { runsForSession, useWorkflowStore } from '../stores/workflowStore'
import { TerminalSettings } from './TerminalSettings'
import type { SessionListItem } from '../types/session'
import type { ActiveGoalState, TokenUsage } from '../types/chat'
import type { TeamMember } from '../types/team'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import { formatTokenCount } from '../lib/formatTokenCount'
import {
  COMPOSER_PREFILL_EVENT,
  WelcomeTaskCards,
  type ComposerPrefillDetail,
  type WelcomeTaskCard,
} from '../components/welcome/WelcomeTaskCards'
import { RecentActivityCard } from '../components/welcome/RecentActivityCard'
import {
  createBackgroundTaskDismissKey,
  hasRunningBackgroundTasks as hasAnyRunningBackgroundTasks,
} from '../lib/backgroundTasks'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getSessionBrowsablePath, getSessionWorkspaceState } from '../lib/sessionWorkspace'
import type { AgentTaskNotification, UIMessage } from '../types/chat'
import { sessionsApi, type SessionGitInfo } from '../api/sessions'

/**
 * Stable fallbacks for optional session state. A `?? []` / `?? {}` literal allocates a
 * fresh value on every render, and both of these feed the `activityModel` dependency
 * array below — so an idle session with no messages or no agent notifications rebuilt
 * the whole activity model on every render. 29586ce38 fixed exactly this in
 * MessageList.tsx; the same pattern was still here.
 */
const EMPTY_MESSAGES: UIMessage[] = []

const TASK_POLL_INTERVAL_MS = 1000
const ACTIVITY_AUTOCLOSE_GRACE_MS = 2000
const WORKSPACE_RESIZE_STEP = 32
const TERMINAL_RESIZE_STEP = 24
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: readonly string[] = []
const EMPTY_AGENT_TASK_NOTIFICATIONS: Record<string, AgentTaskNotification> = {}

function isSessionTabState(activeTabId: string | null, activeTabType: TabType | null | undefined) {
  if (!activeTabId) return false
  if (activeTabType === 'session') return true
  if (activeTabType) return false
  return activeTabId !== SETTINGS_TAB_ID &&
    activeTabId !== SCHEDULED_TAB_ID &&
    !activeTabId.startsWith(TERMINAL_TAB_PREFIX) &&
    !activeTabId.startsWith(TRACE_TAB_PREFIX) &&
    !activeTabId.startsWith(WORKBENCH_TAB_PREFIX) &&
    !activeTabId.startsWith(TEAM_TAB_PREFIX)
}

function getTokenUsageTotal(usage: TokenUsage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_read_tokens ?? 0) +
    (usage.cache_creation_tokens ?? 0)
  )
}

function getSessionTerminalCwd(session: SessionListItem | undefined) {
  return getSessionBrowsablePath(session)
}

function ActiveGoalStrip({
  goal,
  isRunning,
  compact,
}: {
  goal: ActiveGoalState | null | undefined
  isRunning: boolean
  compact: boolean
}) {
  const t = useTranslation()
  if (!goal || goal.action === 'completed') return null

  const objective = goal.objective ?? goal.message
  if (!objective) return null

  const statusLabel = isRunning
    ? t('chat.activeGoal.running')
    : goal.status === 'paused'
      ? t('chat.activeGoal.paused')
      : t('chat.activeGoal.active')
  const meta = [
    goal.budget ? t('chat.activeGoal.budget', { value: goal.budget }) : null,
    goal.elapsed ? t('chat.activeGoal.elapsed', { value: goal.elapsed }) : null,
    goal.continuations ? t('chat.activeGoal.continuations', { value: goal.continuations }) : null,
  ].filter((value): value is string => value !== null)

  return (
    <div
      data-testid="active-goal-strip"
      className={[
        'mt-2 flex max-w-full items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-memory-border)] bg-[var(--color-memory-surface)] px-2.5 py-1.5',
        compact ? 'text-[11px]' : 'text-[12px]',
      ].join(' ')}
    >
      <Target size={compact ? 13 : 14} className="shrink-0 text-[var(--color-memory-accent)]" strokeWidth={2.25} aria-hidden="true" />
      <span className="shrink-0 font-semibold text-[var(--color-text-primary)]">
        {t('chat.activeGoal.title')}
      </span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-memory-accent)]" aria-hidden="true" />
      <span className="shrink-0 text-[var(--color-text-tertiary)]">{statusLabel}</span>
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]" title={objective}>
        {objective}
      </span>
      {meta.length > 0 ? (
        <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)] lg:flex">
          {meta.map((item) => (
            <span key={item} className="max-w-[140px] truncate">{item}</span>
          ))}
        </span>
      ) : null}
    </div>
  )
}

function getRenderedWorkspacePanelWidth(panelRef: RefObject<HTMLElement>, fallbackWidth: number) {
  const renderedWidth = panelRef.current?.getBoundingClientRect().width ?? 0
  return Number.isFinite(renderedWidth) && renderedWidth > 0
    ? renderedWidth
    : fallbackWidth
}

function WorkspaceResizeHandle({ panelRef }: { panelRef: RefObject<HTMLElement> }) {
  const t = useTranslation()
  const width = useWorkspacePanelStore((state) => state.width)
  const setWidth = useWorkspacePanelStore((state) => state.setWidth)
  const [dragState, setDragState] = useState<{ startX: number; startWidth: number } | null>(null)
  const dragStateRef = useRef(dragState)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    if (!dragState) return

    const handlePointerMove = (event: PointerEvent) => {
      const current = dragStateRef.current
      if (!current) return
      setWidth(current.startWidth + current.startX - event.clientX)
    }

    const handlePointerUp = () => {
      setDragState(null)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [dragState, setWidth])

  return (
    <div
      role="separator"
      aria-label={t('workspace.resizePanel')}
      aria-orientation="vertical"
      aria-valuenow={width}
      tabIndex={0}
      data-testid="workspace-resize-handle"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        setDragState({ startX: event.clientX, startWidth: getRenderedWorkspacePanelWidth(panelRef, width) })
      }}
      onKeyDown={(event) => {
        const renderedWidth = getRenderedWorkspacePanelWidth(panelRef, width)
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          setWidth(renderedWidth + WORKSPACE_RESIZE_STEP)
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          setWidth(renderedWidth - WORKSPACE_RESIZE_STEP)
        }
      }}
      className="relative z-10 w-px shrink-0 cursor-col-resize bg-[var(--color-border)] outline-none transition-colors hover:bg-[var(--color-border-focus)] focus-visible:bg-[var(--color-border-focus)]"
    >
      <div aria-hidden="true" className="absolute -inset-x-1 inset-y-0" />
    </div>
  )
}

function TerminalResizeHandle() {
  const t = useTranslation()
  const height = useTerminalPanelStore((state) => state.height)
  const setHeight = useTerminalPanelStore((state) => state.setHeight)
  const [dragState, setDragState] = useState<{ startY: number; startHeight: number } | null>(null)
  const dragStateRef = useRef(dragState)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    if (!dragState) return

    const handlePointerMove = (event: PointerEvent) => {
      const current = dragStateRef.current
      if (!current) return
      setHeight(current.startHeight + current.startY - event.clientY)
    }

    const handlePointerUp = () => {
      setDragState(null)
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [dragState, setHeight])

  return (
    <div
      role="separator"
      aria-label={t('terminal.resizePanel')}
      aria-orientation="horizontal"
      aria-valuemin={TERMINAL_PANEL_MIN_HEIGHT}
      aria-valuemax={TERMINAL_PANEL_MAX_HEIGHT}
      aria-valuenow={height}
      tabIndex={0}
      data-testid="terminal-resize-handle"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        setDragState({ startY: event.clientY, startHeight: height })
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setHeight(height + TERMINAL_RESIZE_STEP)
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setHeight(height - TERMINAL_RESIZE_STEP)
        }
        if (event.key === 'Home') {
          event.preventDefault()
          setHeight(TERMINAL_PANEL_MIN_HEIGHT)
        }
        if (event.key === 'End') {
          event.preventDefault()
          setHeight(TERMINAL_PANEL_MAX_HEIGHT)
        }
      }}
      onDoubleClick={() => setHeight(TERMINAL_PANEL_DEFAULT_HEIGHT)}
      className="group flex h-2.5 shrink-0 cursor-row-resize items-center bg-[var(--color-surface)] outline-none focus-visible:bg-[var(--color-surface-container)]"
    >
      <div className="mx-3 h-px flex-1 rounded-full bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-border-focus)] group-focus-visible:bg-[var(--color-border-focus)]" />
    </div>
  )
}

export function ActiveSession() {
  const isMobileLayout = useMobileViewport() && !isDesktopRuntime()
  const workbenchPanelRef = useRef<HTMLElement>(null)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const [dismissedBackgroundTaskKeysBySession, setDismissedBackgroundTaskKeysBySession] = useState<Record<string, Set<string>>>({})
  const activeTabType = useTabStore((s) => s.tabs.find((tab) => tab.sessionId === s.activeTabId)?.type ?? null)
  const sessions = useSessionStore((s) => s.sessions)
  const connectToSession = useChatStore((s) => s.connectToSession)
  const stopBackgroundTask = useChatStore((s) => s.stopBackgroundTask)
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
  // Hand-off context attached to this session (if any). Drives a small chip
  // in the header so the user remembers the AI started with summarized
  // prior context. Set by the "Continue from here" flow on success.
  const handoffInfoForActive = useSessionRuntimeStore((s) =>
    activeTabId ? s.handoffInfo[activeTabId] : undefined,
  )
  // Live mode flags drive the always-visible status chip in the chat header
  // so the user can see at a glance which session-level mode is active. The
  // `+`-menu toggle in ChatInput is the entry point but only surfaces the
  // current state inside that menu — the chip is the persistent affordance
  // that the steering contract calls "明示当前模式" (must be explicit).
  const coordinatorModeForActive = useSessionRuntimeStore((s) =>
    activeTabId ? s.coordinatorModes[activeTabId] ?? false : false,
  )
  const pipelineModeForActive = useSessionRuntimeStore((s) =>
    activeTabId ? s.pipelineModes[activeTabId] ?? 'normal' : 'normal',
  )
  const soloPipelineModeForActive = pipelineModeForActive === 'solo'
  const rePipelineModeForActive = pipelineModeForActive === 're'
  const pendingComputerUsePermission = sessionState?.pendingComputerUsePermission ?? null
  const pendingProviderTransition = sessionState?.pendingProviderTransition ?? null
  const runtimeConfigError = sessionState?.runtimeConfigError ?? null
  const fetchSessionTasks = useCLITaskStore((s) => s.fetchSessionTasks)
  const trackedTaskSessionId = useCLITaskStore((s) => s.sessionId)
  const cliTasks = useCLITaskStore((s) => s.tasks)
  const cliTasksCompletedAndDismissed = useCLITaskStore((s) => s.completedAndDismissed)
  const hasIncompleteTasks = cliTasks.some((task) => task.status !== 'completed')
  const hasRunningTasks = cliTasks.some((task) => task.status === 'in_progress')
  const unifiedActivityPanelEnabled = useSettingsStore((state) => state.unifiedActivityPanelEnabled)
  const isActivityPanelOpen = useActivityPanelStore((state) => activeTabId ? state.isOpen(activeTabId) : false)
  const openActivityPanel = useActivityPanelStore((state) => state.open)
  const closeActivityPanel = useActivityPanelStore((state) => state.close)
  const dismissActivityBackgroundTaskKeys = useActivityPanelStore((state) => state.dismissBackgroundTaskKeys)
  const pruneActivityBackgroundTaskKeys = useActivityPanelStore((state) => state.pruneDismissedBackgroundTaskKeys)
  const dismissedBackgroundTaskKeyList = useActivityPanelStore((state) =>
    activeTabId
      ? state.dismissedBackgroundTaskKeysBySession[activeTabId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
      : EMPTY_DISMISSED_BACKGROUND_TASK_KEYS,
  )
  const activityVisibilityBySessionRef = useRef<Record<string, { hadAutoOpenActivity: boolean }>>({})
  const chatState = sessionState?.chatState ?? 'idle'
  const tokenUsage = sessionState?.tokenUsage ?? { input_tokens: 0, output_tokens: 0 }
  const hasRunningBackgroundTasks = hasAnyRunningBackgroundTasks(sessionState?.backgroundAgentTasks)
  const stoppingBackgroundTaskIds = sessionState?.stoppingBackgroundTaskIds

  const session = sessions.find((s) => s.id === activeTabId)
  const memberInfo = useTeamStore((s) => activeTabId ? s.getMemberBySessionId(activeTabId) : null)
  const activeTeam = useTeamStore((s) => s.activeTeam)
  const isMemberSession = Boolean(memberInfo)
  const sessionMessageCount = Math.max(
    sessionState?.messages.length ?? 0,
    session?.messageCount ?? 0,
  )
  const sessionSlashCommandCount = sessionState?.slashCommands.length ?? 0
  const agentTeamsSnapshots = useTeamStore((s) => activeTabId
    ? s.workbenchesBySession[activeTabId]?.snapshots
    : undefined)
  const agentTeamsSnapshot = useMemo(() => (
    agentTeamsSnapshots?.length
      ? snapshotWithHistoricalMembers(agentTeamsSnapshots, agentTeamsSnapshots.length - 1)
      : undefined
  ), [agentTeamsSnapshots])
  const activeTeamStartedAt = useTeamStore((s) => activeTabId
    ? s.activeTeamStartedAtBySession[activeTabId]
    : undefined)
  const fetchTeamForSession = useTeamStore((s) => s.fetchTeamForSession)
  const [sessionGitInfo, setSessionGitInfo] = useState<{
    sessionId: string
    info: SessionGitInfo
  } | null>(null)
  const workspaceWorkbenchOpen = useWorkspacePanelStore((state) =>
    activeTabId && isSessionTabState(activeTabId, activeTabType) && !isMobileLayout
      ? state.isPanelOpen(activeTabId)
      : false,
  )
  const showWorkbench = workspaceWorkbenchOpen && !isMemberSession
  const showRightPanel = showWorkbench
  const showLegacyActivity = !unifiedActivityPanelEnabled
  const showUnifiedActivity = unifiedActivityPanelEnabled && !isMemberSession
  const workspacePanelWidth = useWorkspacePanelStore((state) => state.width)
  const rightPanelWidth = workspacePanelWidth
  const showTerminalPanel = useTerminalPanelStore((state) =>
    activeTabId && isSessionTabState(activeTabId, activeTabType) && !isMobileLayout && !isMemberSession
      ? state.isPanelOpen(activeTabId)
      : false,
  )
  const terminalPanelRuntimeId = useTerminalPanelStore((state) =>
    activeTabId && isSessionTabState(activeTabId, activeTabType) && !isMobileLayout && !isMemberSession
      ? state.panelBySession[activeTabId]?.runtimeId
      : undefined,
  )
  const terminalPanelHeight = useTerminalPanelStore((state) => state.height)

  useEffect(() => {
    if (activeTabId && !isMemberSession) {
      connectToSession(activeTabId)
      void fetchTeamForSession(activeTabId)
    }
  }, [activeTabId, connectToSession, fetchTeamForSession, isMemberSession])

  useEffect(() => {
    if (!activeTabId || !isSessionTabState(activeTabId, activeTabType)) return

    let cancelled = false
    setSessionGitInfo((current) => current?.sessionId === activeTabId ? null : current)
    void sessionsApi.getGitInfo(activeTabId)
      .then((info) => {
        if (!cancelled && info.worktree?.enabled) {
          setSessionGitInfo({ sessionId: activeTabId, info })
        }
      })
      .catch(() => {
        // Git metadata is supplementary; the session remains usable without it.
      })

    return () => {
      cancelled = true
    }
  }, [activeTabId, activeTabType])

  useEffect(() => {
    if (
      !activeTabId ||
      !isSessionTabState(activeTabId, activeTabType) ||
      sessionMessageCount === 0
    ) return

    let cancelled = false
    const timeout = setTimeout(() => {
      void sessionsApi.getGitInfo(activeTabId)
        .then((info) => {
          if (cancelled) return
          setSessionGitInfo(info.worktree?.enabled
            ? { sessionId: activeTabId, info }
            : null)
        })
        .catch(() => {
          // Keep the last useful snapshot when supplementary Git metadata cannot refresh.
        })
    }, chatState === 'idle' ? 0 : 500)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [
    activeTabId,
    activeTabType,
    chatState,
    sessionMessageCount,
    sessionSlashCommandCount,
  ])

  useEffect(() => {
    if (!activeTabId) return

    const shouldPollTasks = !isMemberSession && (
      chatState !== 'idle' ||
      (trackedTaskSessionId === activeTabId && hasIncompleteTasks)
    )

    if (!shouldPollTasks) return

    void fetchSessionTasks(activeTabId)

    const timer = setInterval(() => {
      void fetchSessionTasks(activeTabId)
    }, TASK_POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [
    activeTabId,
    chatState,
    fetchSessionTasks,
    hasIncompleteTasks,
    isMemberSession,
    trackedTaskSessionId,
  ])

  const t = useTranslation()
  const messages = sessionState?.messages ?? EMPTY_MESSAGES
  const streamingText = sessionState?.streamingText ?? ''
  const isPreparingTurn = Boolean(sessionState?.isPreparingTurn)
  const backgroundTasks = useMemo(
    () => Object.values(sessionState?.backgroundAgentTasks ?? {}),
    [sessionState?.backgroundAgentTasks],
  )
  const dismissedBackgroundTaskKeys = useMemo(
    () => new Set(dismissedBackgroundTaskKeyList),
    [dismissedBackgroundTaskKeyList],
  )
  const legacyDismissedBackgroundTaskKeys = activeTabId
    ? dismissedBackgroundTaskKeysBySession[activeTabId] ?? new Set<string>()
    : new Set<string>()
  const agentTaskNotifications = sessionState?.agentTaskNotifications ?? EMPTY_AGENT_TASK_NOTIFICATIONS
  // Subscribe to the stable `runs` record and derive the per-session list here:
  // a selector that filtered would allocate a new array on every store read,
  // which zustand compares by identity and would re-render forever.
  const allWorkflowRuns = useWorkflowStore((state) => state.runs)
  const workflowRuns = useMemo(
    () => (activeTabId ? runsForSession({ runs: allWorkflowRuns }, activeTabId) : []),
    [allWorkflowRuns, activeTabId],
  )
  const activeGoal = sessionState?.activeGoal ?? null
  const isEmpty =
    messages.length === 0 &&
    !streamingText &&
    !isPreparingTurn &&
    (session?.messageCount ?? 0) === 0
  const compactEmptyHero = isEmpty && showTerminalPanel
  const isHistoryLoading =
    (session?.messageCount ?? 0) > 0 &&
    messages.length === 0 &&
    sessionState?.historyStatus === 'loading'
  const historyError =
    (session?.messageCount ?? 0) > 0 &&
    messages.length === 0 &&
    sessionState?.historyStatus === 'error'
      ? sessionState.historyError || t('session.historyLoadFailed')
      : null
  const visibleMessageCount = messages.length > 0 ? messages.length : session?.messageCount ?? 0
  const headerTitle = session?.title || t('session.untitled')
  const currentGitInfo = sessionGitInfo?.sessionId === activeTabId ? sessionGitInfo.info : null
  const worktree = currentGitInfo?.worktree?.enabled ? currentGitInfo.worktree : null
  const worktreePath = worktree?.path || worktree?.plannedPath || null
  const worktreeName = getWorktreeDisplayName(worktree?.slug, worktreePath)

  const isActive = isPreparingTurn || chatState !== 'idle' ||
    (trackedTaskSessionId === activeTabId && hasRunningTasks) ||
    hasRunningBackgroundTasks
  // Header "session active" badge: chat + background tasks, but not CLI tasks in isolation
  const isChatActive = isPreparingTurn || chatState !== 'idle' || hasRunningBackgroundTasks
  const totalTokens = getTokenUsageTotal(tokenUsage)
  const cachedTokens = (tokenUsage.cache_read_tokens ?? 0) +
    (tokenUsage.cache_creation_tokens ?? 0)
  useEffect(() => {
    if (!showUnifiedActivity || !activeTabId) return
    pruneActivityBackgroundTaskKeys(
      activeTabId,
      backgroundTasks.map((task) => createBackgroundTaskDismissKey(task)),
    )
  }, [activeTabId, backgroundTasks, pruneActivityBackgroundTaskKeys, showUnifiedActivity])

  const activityModel = useMemo(() => {
    if (!showUnifiedActivity || !activeTabId) return null
    const includeCliTasks = trackedTaskSessionId === activeTabId
    const teamTaskWindows = teamTaskWindowsForSnapshot(agentTeamsSnapshot, activeTeamStartedAt)

    return buildMainSessionActivityModel({
      sessionId: activeTabId,
      messages,
      // cliTaskStore is explicitly loaded from the session-id list, so these
      // remain the lead's own tasks. AgentTeam's shared DAG, roster and launch
      // rows live in its strip/workbench, while member-internal activity stays
      // isolated by run ownership.
      tasks: includeCliTasks ? cliTasks : [],
      teamTaskWindows,
      completedAndDismissed: includeCliTasks ? cliTasksCompletedAndDismissed : false,
      isForegroundTurnActive: chatState !== 'idle',
      backgroundTasks,
      dismissedBackgroundTaskKeys,
      agentNotifications: Object.values(agentTaskNotifications),
      workflowRuns,
    })
  }, [
    activeTabId,
    activeTeamStartedAt,
    agentTeamsSnapshot,
    agentTaskNotifications,
    backgroundTasks,
    chatState,
    cliTasks,
    cliTasksCompletedAndDismissed,
    dismissedBackgroundTaskKeys,
    isMemberSession,
    messages,
    showUnifiedActivity,
    trackedTaskSessionId,
    workflowRuns,
  ])
  const hasVisibleActivity = activityModel ? hasVisibleSessionActivity(activityModel) : false
  const hasAutoOpenActivity = activityModel ? activityModel.badgeCount > 0 : false

  useEffect(() => {
    if (!showUnifiedActivity || !activeTabId || !isSessionTabState(activeTabId, activeTabType)) return

    const state = activityVisibilityBySessionRef.current[activeTabId]
    if (!state) {
      activityVisibilityBySessionRef.current[activeTabId] = {
        hadAutoOpenActivity: hasAutoOpenActivity,
      }
      return
    }

    if (!state.hadAutoOpenActivity && hasAutoOpenActivity && !isActivityPanelOpen) {
      openActivityPanel(activeTabId)
    }
    state.hadAutoOpenActivity = hasAutoOpenActivity
  }, [
    activeTabId,
    activeTabType,
    hasAutoOpenActivity,
    isActivityPanelOpen,
    openActivityPanel,
    showUnifiedActivity,
  ])

  useEffect(() => {
    if (!activeTabId || !isActivityPanelOpen || hasVisibleActivity) return
    // Activity rows derive from volatile caches that are briefly empty during
    // history loads, cli-task refetches and reconnect reloads. Closing the
    // panel on the first empty beat made that flicker permanent (auto-open
    // does not re-fire after a remount), so only close once the empty state
    // survives a full history-ready grace period.
    if (sessionState?.historyStatus === 'loading') return
    const timer = setTimeout(() => {
      const current = useChatStore.getState().sessions[activeTabId]
      if (current?.historyStatus === 'loading') return
      closeActivityPanel(activeTabId)
    }, ACTIVITY_AUTOCLOSE_GRACE_MS)
    return () => clearTimeout(timer)
  }, [activeTabId, closeActivityPanel, hasVisibleActivity, isActivityPanelOpen, sessionState?.historyStatus])

  // When workspace opens, close the activity panel so the store reflects the
  // correct state. Track whether it was open so we can restore it on close.
  const activityOpenBeforeWorkbenchRef = useRef<boolean>(false)
  useEffect(() => {
    if (!activeTabId) return
    if (showWorkbench) {
      activityOpenBeforeWorkbenchRef.current = isActivityPanelOpen
      if (isActivityPanelOpen) closeActivityPanel(activeTabId)
    } else if (!showWorkbench && activityOpenBeforeWorkbenchRef.current) {
      activityOpenBeforeWorkbenchRef.current = false
      openActivityPanel(activeTabId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWorkbench, activeTabId])

  const handleOpenSubagentRun = useCallback((payload: OpenSubagentPayload) => {
    if (
      payload.teamName &&
      payload.teamMemberName &&
      payload.teamStartedAt !== undefined
    ) {
      void useTeamStore.getState().openMemberFromActivity(
        payload.sessionId,
        payload.teamName,
        payload.teamMemberName,
        payload.teamStartedAt,
      )
      return
    }

    const targetSessionId = useTabStore.getState().openSubagentTab(
      payload.sessionId,
      payload.toolUseId,
      payload.title,
      payload.taskId,
    )
    useActivityPanelStore.getState().open(targetSessionId)
  }, [])
  const handleOpenTeamMember = useCallback((member: TeamMember) => {
    useTeamStore.getState().openMemberSession(member)
  }, [])
  const handleClearActivityBackgroundTasks = useCallback((taskKeys: string[]) => {
    if (!activeTabId || taskKeys.length === 0) return
    dismissActivityBackgroundTaskKeys(activeTabId, taskKeys)
  }, [activeTabId, dismissActivityBackgroundTaskKeys])
  const handleStopActivityBackgroundTask = useCallback((taskId: string) => {
    if (!activeTabId) return
    stopBackgroundTask(activeTabId, taskId)
  }, [activeTabId, stopBackgroundTask])

  const lastUpdated = useMemo(() => {
    if (!session?.modifiedAt) return ''
    const diff = Date.now() - new Date(session.modifiedAt).getTime()
    if (diff < 60000) return t('session.timeJustNow')
    if (diff < 3600000) return t('session.timeMinutes', { n: Math.floor(diff / 60000) })
    if (diff < 86400000) return t('session.timeHours', { n: Math.floor(diff / 3600000) })
    return t('session.timeDays', { n: Math.floor(diff / 86400000) })
  }, [session?.modifiedAt, t])

  useEffect(() => {
    if (!activeTabId || showUnifiedActivity || legacyDismissedBackgroundTaskKeys.size === 0) return
    const currentTaskKeys = new Set(backgroundTasks.map(createBackgroundTaskDismissKey))
    const nextDismissed = new Set([...legacyDismissedBackgroundTaskKeys].filter((taskKey) => currentTaskKeys.has(taskKey)))
    if (nextDismissed.size === legacyDismissedBackgroundTaskKeys.size) return

    setDismissedBackgroundTaskKeysBySession((current) => {
      const next = { ...current }
      if (nextDismissed.size === 0) {
        delete next[activeTabId]
      } else {
        next[activeTabId] = nextDismissed
      }
      return next
    })
  }, [activeTabId, backgroundTasks, legacyDismissedBackgroundTaskKeys, showUnifiedActivity])

  if (!activeTabId) return null

  // The activity rail is an absolutely positioned overlay, so it no longer
  // squeezes the column by itself — the column yields with padding instead.
  const showActivityRail = showUnifiedActivity && Boolean(activityModel) &&
    hasVisibleActivity &&
    !showRightPanel &&
    !isMobileLayout &&
    isSessionTabState(activeTabId, activeTabType)
  const isActivityRailOpen = showActivityRail && isActivityPanelOpen
  const headerMetadataCandidates: Array<SessionHeaderMetaItem | null> = [
    isChatActive
      ? {
          key: 'active',
          content: (
            <span className="flex shrink-0 items-center gap-1.5 text-[var(--color-text-secondary)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse-dot" />
              {t('session.active')}
            </span>
          ),
        }
      : null,
    worktreeName
      ? {
          key: 'worktree',
          content: (
            <Tooltip
              placement="bottom-start"
              content={<WorktreeDetails name={worktreeName} path={worktreePath} />}
            >
              <span
                data-testid="session-worktree-indicator"
                tabIndex={0}
                className="flex min-w-0 max-w-[260px] shrink cursor-help items-center gap-1 rounded-[4px] text-[var(--color-text-secondary)] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
              >
                <GitFork size={11} className="shrink-0 text-[var(--color-brand)]" aria-hidden="true" />
                <span className="shrink-0 capitalize">{t('sidebar.worktree')}:</span>
                <span className="min-w-0 truncate font-medium">{worktreeName}</span>
              </span>
            </Tooltip>
          ),
        }
      : null,
    totalTokens > 0
      ? {
          key: 'tokens',
          content: (
            <span
              className="shrink-0"
              title={t('session.apiTokenBreakdown', {
                total: totalTokens.toLocaleString(),
                input: tokenUsage.input_tokens.toLocaleString(),
                output: tokenUsage.output_tokens.toLocaleString(),
                cache: cachedTokens.toLocaleString(),
              })}
            >
              {t('session.apiTokens', { count: formatTokenCount(totalTokens) })}
            </span>
          ),
        }
      : null,
    lastUpdated
      ? {
          key: 'updated',
          content: <span className="truncate">{t('session.lastUpdated', { time: lastUpdated })}</span>,
        }
      : null,
    !showRightPanel && visibleMessageCount > 0
      ? {
          key: 'messages',
          content: <span className="shrink-0">{t('session.messages', { count: visibleMessageCount })}</span>,
        }
      : null,
  ]
  const headerMetadata = headerMetadataCandidates.filter(
    (item): item is SessionHeaderMetaItem => item !== null,
  )

  return (
    <SessionChatSurface
      surfaceKind="main"
      isMobileLayout={isMobileLayout}
      compact={showRightPanel}
      activityRailOpen={isActivityRailOpen}
      contentRowTestId="active-session-content-row"
      chatColumnTestId="active-session-chat-column"
      activityRail={activityModel && showActivityRail ? (
        <SessionActivityPanel
          model={activityModel}
          open={isActivityPanelOpen}
          onClose={() => closeActivityPanel(activeTabId)}
          onOpenSubagent={handleOpenSubagentRun}
          onClearFinishedBackgroundTasks={handleClearActivityBackgroundTasks}
          onOpenMember={handleOpenTeamMember}
          onStopBackgroundTask={handleStopActivityBackgroundTask}
          stoppingBackgroundTaskIds={stoppingBackgroundTaskIds}
          placement="rail"
        />
      ) : null}
      sidePanel={showWorkbench ? (
        <>
          <WorkspaceResizeHandle panelRef={workbenchPanelRef} />
          <aside
            ref={workbenchPanelRef}
            data-testid="workbench-panel"
            className="flex h-full shrink-0 flex-col bg-[var(--color-surface)]"
            style={{ width: rightPanelWidth, maxWidth: '62%', minWidth: 'min(420px, 54%)' }}
          >
            <WorkbenchPanel sessionId={activeTabId} />
          </aside>
        </>
      ) : null}
      overlay={(
        <>
          <ComputerUsePermissionModal
            sessionId={activeTabId}
            request={pendingComputerUsePermission?.request ?? null}
          />
          {!isMemberSession && pendingProviderTransition ? (
            <Modal
              open
              onClose={() => useChatStore.getState().cancelProviderTransition(activeTabId)}
              title={t('chat.providerTransitionTitle')}
              footer={(
                <>
                  <button
                    type="button"
                    onClick={() => useChatStore.getState().cancelProviderTransition(activeTabId)}
                    className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                  >
                    {t('chat.providerTransitionCancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void useChatStore.getState().confirmProviderTransition(activeTabId)}
                    className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-white"
                  >
                    {t('chat.providerTransitionConfirm')}
                  </button>
                </>
              )}
            >
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t('chat.providerTransitionBody', { count: pendingProviderTransition.messageCount })}
              </p>
            </Modal>
          ) : null}
          {!isMemberSession && runtimeConfigError ? (
            <div
              role="alert"
              className="absolute bottom-20 left-1/2 z-40 max-w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-surface-container-lowest)] px-4 py-3 text-sm text-[var(--color-error)] shadow-lg"
            >
              {runtimeConfigError.message}
            </div>
          ) : null}
        </>
      )}
    >
      {isMemberSession && (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-container)]">
          <div className="mx-auto flex max-w-[900px] items-center justify-between gap-4 px-8 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                {memberInfo?.status === 'running' && (
                  <span className="flex h-2 w-2 rounded-full bg-[var(--color-warning)] animate-pulse-dot" />
                )}
                {memberInfo?.status === 'completed' && (
                  <span className="material-symbols-outlined text-[14px] text-[var(--color-success)]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                )}
                <span className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">smart_toy</span>
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {memberInfo?.role}
                </span>
                {activeTeam && (
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">
                    @ {activeTeam.name}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
                {t('teams.memberSessionHint')}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => {
                if (activeTeam?.leadSessionId) {
                  useTabStore.getState().openTab(
                    activeTeam.leadSessionId,
                    t('teams.leader'),
                    'session',
                  )
                }
              }}
              disabled={!activeTeam?.leadSessionId}
              icon={<span className="material-symbols-outlined text-[14px]">arrow_back</span>}
            >
              {t('teams.backToLeader')}
            </Button>
          </div>
        </div>
      )}

      {isEmpty ? (
            <div
              data-testid="empty-session-hero"
              className={[
                'brand-seal-glow flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-8 pt-8',
                compactEmptyHero ? 'pb-6' : 'pb-32',
              ].join(' ')}            >
              <div className="flex max-w-[420px] flex-col items-center gap-[13px] text-center">
                <BrandSeal size={compactEmptyHero ? 'lg' : 'xl'} />
                <h1
                  className={`${compactEmptyHero ? 'text-2xl' : 'text-[27px]'} font-bold tracking-tight text-[var(--color-text-primary)]`}
                  style={{ fontFamily: 'var(--font-headline)' }}
                >
                  {t('empty.title')}
                </h1>
                <p
                  className={`mx-auto -mt-1 text-[var(--color-text-secondary)] ${compactEmptyHero ? 'max-w-[280px] text-sm leading-6' : 'text-[15px] leading-[1.7]'}`}
                  style={{ fontFamily: 'var(--font-body)' }}
                >
                  {t('empty.subtitle')}
                </p>
              </div>
              {!isMemberSession && !isMobileLayout && activeTabId && session?.workDir && (
                <RecentActivityCard
                  workDir={session.workDir}
                  excludeSessionId={activeTabId}
                  hideContinueSessionButton
                  onContinueSession={(sessionId) => {
                    useTabStore.getState().openTab(sessionId, 'New Session')
                    connectToSession(sessionId)
                  }}
                  onAutoHandoff={async (previousSessionId, previousSessionTitle, fallbackText, setStage, options) => {
                    // 1. Resolve summary (cached → generated → null). Any
                    //    failure degrades silently to the zero-token
                    //    textarea-prefill path.
                    setStage('reading-cache')
                    let summary = null
                    try {
                      const cached = await projectsApi.getSessionSummary(previousSessionId)
                      summary = cached.summary
                    } catch {
                      // GET error → fall through to generation path below.
                    }
                    if (!summary) {
                      setStage('generating-summary')
                      try {
                        const fresh = await projectsApi.generateSessionSummary(previousSessionId)
                        summary = fresh.summary
                      } catch {
                        summary = null
                      }
                    }

                    if (!summary) {
                      // Zero-token fallback: write the static hand-off
                      // paragraph into the composer via the existing
                      // composer-prefill event.
                      const detail: ComposerPrefillDetail = {
                        sessionId: activeTabId,
                        text: fallbackText,
                      }
                      window.dispatchEvent(
                        new CustomEvent(COMPOSER_PREFILL_EVENT, { detail }),
                      )
                      return
                    }

                    setStage('starting-session')

                    // Stash hand-off info on the active session so the
                    // chat header can render a "↗ continued from..." chip.
                    useSessionRuntimeStore.getState().setHandoffInfo(activeTabId, {
                      previousSessionId,
                      previousSessionTitle,
                      approxTokens: Math.ceil(
                        (summary.main.length + summary.recent.length) / 4,
                      ),
                      generatedAt: summary.generatedAt,
                    })

                    // 2. Stage hand-off on the live session and auto-send a
                    //    short trigger message. Server reads cached summary
                    //    via WS message, restarts CLI with --append-system-
                    //    prompt, and the next user_message kicks off the AI
                    //    turn with full context already in system prompt.
                    wsManager.send(activeTabId, {
                      type: 'set_handoff_summary',
                      previousSessionId,
                      ...(options?.deep ? { deep: true } : {}),
                    })
                    useChatStore.getState().sendMessage(
                      activeTabId,
                      t('empty.recentActivity.continueTriggerMessage'),
                    )
                  }}
                />
              )}
              {!isMemberSession && !isMobileLayout && activeTabId && (
                <WelcomeTaskCards
                  workDir={session?.workDir || undefined}
                  excludeSessionId={activeTabId}
                  onApplyTask={(card: WelcomeTaskCard, promptText: string) => {
                    // Push the starter prompt into ChatInput's draft via a
                    // window event — ChatInput listens for this and sets its
                    // textarea state when the sessionId matches the active tab.
                    const detail: ComposerPrefillDetail = {
                      sessionId: activeTabId,
                      text: promptText,
                    }
                    window.dispatchEvent(new CustomEvent(COMPOSER_PREFILL_EVENT, { detail }))
                    if (card.orchestrate) {
                      // Session already exists here (we're in ActiveSession),
                      // so this immediately persists the preference and
                      // pushes the WS message if connected. Won't disable an
                      // existing toggle — non-orchestration cards leave it.
                      useChatStore.getState().setSessionCoordinatorMode(activeTabId, true)
                    }
                  }}
                />
              )}
            </div>
          ) : (
            <>
              {!isMobileLayout && (
                <SessionChatHeader
                  title={headerTitle}
                  compact={showRightPanel}
                  metadata={headerMetadata}
                >
                  {session && getSessionWorkspaceState(session) !== 'available' && (
                    <div className={`mt-2 inline-flex max-w-full items-center gap-2 rounded-[var(--radius-md)] border px-3 py-1.5 text-[11px] ${
                      getSessionWorkspaceState(session) === 'worktree_removed'
                        ? 'border-[var(--color-border)] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]'
                        : 'border-[var(--color-error)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
                    }`}>
                      <span className="material-symbols-outlined text-[14px]">
                        {getSessionWorkspaceState(session) === 'worktree_removed' ? 'history' : 'warning'}
                      </span>
                      <span className="truncate">
                        {getSessionWorkspaceState(session) === 'worktree_removed'
                          ? t('session.worktreeRemoved', { dir: session.projectRoot || '' })
                          : t('session.workspaceUnavailable', { dir: session.workDir || 'directory no longer exists' })}
                      </span>
                    </div>
                  )}
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
                    {handoffInfoForActive ? (
                      <span
                        data-testid="session-handoff-chip"
                        title={t('session.handoffChipTooltip', {
                          title: handoffInfoForActive.previousSessionTitle,
                          tokens: handoffInfoForActive.approxTokens,
                        })}
                        className="inline-flex shrink-0 items-center gap-0.5 cursor-help text-[var(--color-primary)]"
                      >
                        {t('session.handoffChip', { tokens: handoffInfoForActive.approxTokens })}
                      </span>
                    ) : null}
                    {coordinatorModeForActive ? (
                      <span
                        data-testid="session-coordinator-chip"
                        title={t('session.coordinatorChipTooltip')}
                        className="inline-flex shrink-0 items-center gap-1 cursor-help text-[var(--color-primary)]"
                      >
                        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">hub</span>
                        {t('session.coordinatorChip')}
                      </span>
                    ) : null}
                    {soloPipelineModeForActive ? (
                      <span
                        data-testid="session-solo-chip"
                        title={t('session.soloPipelineChipTooltip')}
                        className="inline-flex shrink-0 items-center gap-1 cursor-help text-[var(--color-primary)]"
                      >
                        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">linear_scale</span>
                        {t('session.soloPipelineChip')}
                      </span>
                    ) : null}
                    {rePipelineModeForActive ? (
                      <span
                        data-testid="session-re-chip"
                        title={t('session.rePipelineChipTooltip')}
                        className="inline-flex shrink-0 items-center gap-1 cursor-help text-[var(--color-primary)]"
                      >
                        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">troubleshoot</span>
                        {t('session.rePipelineChip')}
                      </span>
                    ) : null}
                  </div>
                  <ActiveGoalStrip
                    goal={activeGoal}
                    isRunning={isActive}
                    compact={showRightPanel}
                  />
                  {agentTeamsSnapshot ? (
                    <AgentTeamsStrip
                      snapshot={agentTeamsSnapshot}
                      compact={showRightPanel}
                      onOpen={() => useTabStore.getState().openTeamWorkbenchTab(
                        activeTabId,
                        agentTeamsSnapshot.team.name,
                      )}
                    />
                  ) : null}
                  {soloPipelineModeForActive && activeTabId ? (
                    <SoloCouncilPanel
                      sessionId={activeTabId}
                      compact={showRightPanel}
                    />
                  ) : null}
                </SessionChatHeader>
              )}

              {isHistoryLoading ? (
                <div className="flex flex-1 items-center justify-center p-8">
                  <LoadingState label={t('common.loading')} variant="inline" size="md" />
                </div>
              ) : historyError ? (
                <div role="alert" className="flex flex-1 items-center justify-center p-8 text-sm text-[var(--color-error)]">
                  {historyError}
                </div>
              ) : (
                <MessageList compact={showRightPanel} mobileLayout={isMobileLayout} />
              )}
            </>
          )}

          {showLegacyActivity && !isMemberSession && <SessionTaskBar />}
          {showLegacyActivity && <TeamStatusBar />}
          {showLegacyActivity && !isMemberSession ? (
            <BackgroundTasksBar
              key={activeTabId}
              tasks={backgroundTasks}
              compact={showRightPanel}
              dismissedFinishedTaskKeys={legacyDismissedBackgroundTaskKeys}
              onClearFinished={(taskKeys) => {
                if (!activeTabId || taskKeys.length === 0) return
                setDismissedBackgroundTaskKeysBySession((current) => ({
                  ...current,
                  [activeTabId]: new Set([
                    ...(current[activeTabId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS),
                    ...taskKeys,
                  ]),
                }))
              }}
              onStopTask={(taskId) => stopBackgroundTask(activeTabId, taskId)}
            />
          ) : null}

          {showUnifiedActivity && activityModel && hasVisibleActivity && isMobileLayout && isSessionTabState(activeTabId, activeTabType) ? (
            <>
              <div className="absolute right-3 top-3 z-30">
                <SessionActivityButton sessionId={activeTabId} />
              </div>
              <SessionActivityPanel
                model={activityModel}
                open={isActivityPanelOpen}
                onClose={() => closeActivityPanel(activeTabId)}
                onOpenSubagent={handleOpenSubagentRun}
                onClearFinishedBackgroundTasks={handleClearActivityBackgroundTasks}
                onOpenMember={handleOpenTeamMember}
                onStopBackgroundTask={handleStopActivityBackgroundTask}
                stoppingBackgroundTaskIds={stoppingBackgroundTaskIds}
                placement="overlay"
              />
            </>
          ) : null}

          <ChatInput
            variant={isEmpty && !isMemberSession && !showRightPanel ? 'hero' : 'default'}
            compact={showRightPanel}
          />

          {terminalPanelRuntimeId && activeTabId ? (
            <div
              data-testid="session-terminal-panel"
              className={[
                'flex min-h-0 shrink-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]',
                showTerminalPanel ? '' : 'hidden',
              ].join(' ')}
              style={{ height: showTerminalPanel ? terminalPanelHeight : 0 }}
            >
              {showTerminalPanel && <TerminalResizeHandle />}
              <TerminalSettings
                active={showTerminalPanel}
                docked
                cwd={getSessionTerminalCwd(session)}
                runtimeId={terminalPanelRuntimeId}
                preserveOnUnmount
                testId={`session-terminal-host-${activeTabId}`}
                onOpenInTab={() => {
                  useTerminalPanelStore.getState().closePanel(activeTabId)
                  useTabStore.getState().openTerminalTab(getSessionTerminalCwd(session), terminalPanelRuntimeId)
                  useTerminalPanelStore.getState().detachRuntime(activeTabId)
                }}
                onClose={() => useTerminalPanelStore.getState().closePanel(activeTabId)}
              />
            </div>
          ) : null}
    </SessionChatSurface>
  )
}
