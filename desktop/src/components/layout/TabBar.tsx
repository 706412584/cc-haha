import { forwardRef, useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  MARKET_TAB_ID,
  OFFICE_TAB_PREFIX,
  SUBAGENT_TAB_PREFIX,
  TERMINAL_TAB_PREFIX,
  TRACE_LIST_TAB_ID,
  TRACE_TAB_PREFIX,
  WORKBENCH_TAB_PREFIX,
  useTabStore,
  type Tab,
} from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { isPlaceholderSessionTitle } from '../../lib/sessionTitle'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useCLITaskStore } from '../../stores/cliTaskStore'
import { useTeamStore } from '../../stores/teamStore'
import { StatusDot } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { hasRunningBackgroundTasks } from '../../lib/backgroundTasks'
import { WindowControls, showWindowControls } from './WindowControls'
import { OpenProjectMenu } from './OpenProjectMenu'
import { Building2, Folder, FolderOpen, SquareTerminal } from 'lucide-react'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { buildSessionActivityModel, hasVisibleSessionActivity } from '../activity/sessionActivityModel'
import { SessionActivityButton } from '../activity/SessionActivityButton'
import { useActivityPanelStore } from '../../stores/activityPanelStore'
import { getSessionBrowsablePath } from '../../lib/sessionWorkspace'

const TAB_WIDTH = 180
const DRAG_START_THRESHOLD = 4
const desktopHost = getDesktopHost()
const isDesktopRuntime = desktopHost.isDesktop
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: readonly string[] = []

type PendingCloseRequest = {
  tabs: Tab[]
  runningSessionIds: string[]
}

function isSessionTab(tab: Tab | null) {
  if (!tab) return false
  const tabType = (tab as Partial<Tab>).type
  if (tabType === 'session') return true
  if (tabType) return false
  return isSessionTabId(tab.sessionId)
}

function isSessionTabId(tabId: string | null) {
  if (!tabId) return false
  return tabId !== SETTINGS_TAB_ID &&
    tabId !== SCHEDULED_TAB_ID &&
    tabId !== MARKET_TAB_ID &&
    tabId !== TRACE_LIST_TAB_ID &&
    !tabId.startsWith(TERMINAL_TAB_PREFIX) &&
    !tabId.startsWith(TRACE_TAB_PREFIX) &&
    !tabId.startsWith(WORKBENCH_TAB_PREFIX) &&
    !tabId.startsWith(SUBAGENT_TAB_PREFIX) &&
    !tabId.startsWith(OFFICE_TAB_PREFIX)
}

export function TabBar() {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const closeTab = useTabStore((s) => s.closeTab)
  const sessionTabIds = useMemo(
    () => tabs.filter((tab) => isSessionTab(tab)).map((tab) => tab.sessionId),
    [tabs],
  )
  const activeChatSessionIds = useChatStore(useShallow((s) =>
    sessionTabIds.filter((sessionId) => {
      const sessionState = s.sessions[sessionId]
      return !!sessionState &&
        (sessionState.chatState !== 'idle' || hasRunningBackgroundTasks(sessionState.backgroundAgentTasks))
    })
  ))
  const disconnectSession = useChatStore((s) => s.disconnectSession)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId) ?? null
  const isActiveSessionTab = isSessionTab(activeTab) || isSessionTabId(activeTabId)
  const activeSession = useSessionStore((state) =>
    activeTabId ? state.sessions.find((session) => session.id === activeTabId) : undefined,
  )
  const openProjectPath = isActiveSessionTab
    ? getSessionBrowsablePath(activeSession) ?? null
    : null
  // The right-side panel is now a single unified "workbench" with a per-session
  // mode (file ↔ browser). The folder/browser toolbar buttons reflect whether
  // the panel is open in their respective mode.
  const isWorkbenchOpen = useWorkspacePanelStore((state) =>
    activeTabId && isActiveSessionTab ? state.isPanelOpen(activeTabId) : false,
  )
  const workbenchMode = useWorkspacePanelStore((state) =>
    activeTabId && isActiveSessionTab ? state.getMode(activeTabId) : 'workspace',
  )
  const isWorkspacePanelOpen = isWorkbenchOpen && workbenchMode === 'workspace'
  const isTerminalPanelOpen = useTerminalPanelStore((state) =>
    activeTabId && isActiveSessionTab ? state.isPanelOpen(activeTabId) : false,
  )
  const agentOfficeSurface = useSettingsStore((state) => state.agentOfficeSurface)
  const unifiedActivityPanelEnabled = useSettingsStore((state) => state.unifiedActivityPanelEnabled)
  const isActiveMemberSession = useTeamStore((state) =>
    activeTabId ? Boolean(state.getMemberBySessionId(activeTabId)) : false,
  )
  const cliTasks = useCLITaskStore((state) => state.tasks)
  const cliTasksSessionId = useCLITaskStore((state) => state.sessionId)
  const cliTasksCompletedAndDismissed = useCLITaskStore((state) => state.completedAndDismissed)
  const dismissedBackgroundTaskKeyList = useActivityPanelStore((state) =>
    activeTabId
      ? state.dismissedBackgroundTaskKeysBySession[activeTabId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
      : EMPTY_DISMISSED_BACKGROUND_TASK_KEYS,
  )
  const dismissedBackgroundTaskKeys = useMemo(
    () => new Set(dismissedBackgroundTaskKeyList),
    [dismissedBackgroundTaskKeyList],
  )
  const activityTeamMembers = useTeamStore(useShallow((state) => {
    const activeTeam = state.activeTeam
    if (!activeTabId || !activeTeam || activeTeam.leadSessionId !== activeTabId) {
      return []
    }
    return activeTeam.members.filter((member) =>
      !activeTeam.leadAgentId || member.agentId !== activeTeam.leadAgentId
    )
  }))
  const activityState = useChatStore(useShallow((state) => {
    if (!activeTabId || !isActiveSessionTab) {
      return { hasVisibleActivity: false }
    }
    const sessionState = state.sessions[activeTabId]
    const includeCliTasks = cliTasksSessionId === activeTabId

    const model = buildSessionActivityModel({
      sessionId: activeTabId,
      messages: sessionState?.messages ?? [],
      tasks: includeCliTasks ? cliTasks : [],
      completedAndDismissed: includeCliTasks ? cliTasksCompletedAndDismissed : false,
      backgroundTasks: Object.values(sessionState?.backgroundAgentTasks ?? {}),
      dismissedBackgroundTaskKeys,
      agentNotifications: Object.values(sessionState?.agentTaskNotifications ?? {}),
      teamMembers: activityTeamMembers,
    })
    return {
      hasVisibleActivity: hasVisibleSessionActivity(model),
    }
  }))
  const showActivityButton = unifiedActivityPanelEnabled &&
    activeTabId &&
    !isActiveMemberSession &&
    activityState.hasVisibleActivity &&
    !isWorkbenchOpen

  const moveTab = useTabStore((s) => s.moveTab)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [pendingCloseRequest, setPendingCloseRequest] = useState<PendingCloseRequest | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null)
  const [dragOffsetX, setDragOffsetX] = useState(0)
  const dragIndexRef = useRef<number | null>(null)
  const pendingDragRef = useRef<{ index: number; startX: number; startY: number } | null>(null)
  const suppressClickRef = useRef(false)
  const tabRefs = useRef(new Map<string, HTMLDivElement | null>())
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const t = useTranslation()
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tab of tabs) {
      if (isSessionTab(tab) && tab.status === 'running') ids.add(tab.sessionId)
    }
    for (const sessionId of activeChatSessionIds) {
      ids.add(sessionId)
    }
    return ids
  }, [activeChatSessionIds, tabs])

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateScrollState()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState)
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState, tabs.length])

  useEffect(() => {
    if (!activeTabId) return
    const activeTabEl = tabRefs.current.get(activeTabId)
    if (!activeTabEl) return

    activeTabEl.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    })

    const frame = window.requestAnimationFrame(updateScrollState)
    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId, tabs.length, updateScrollState])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  // Every item in the menu clears `contextMenu` itself, so excluding the menu
  // from "outside" keeps the previous behavior while dropping the hand-rolled
  // document listener.
  useDismissable({
    open: contextMenu !== null,
    refs: [contextMenuRef],
    onDismiss: closeContextMenu,
  })

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: direction === 'left' ? -TAB_WIDTH : TAB_WIDTH, behavior: 'smooth' })
  }

  const handleTabWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    const el = scrollRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    event.preventDefault()
    el.scrollLeft += event.deltaY
  }

  const closeTabWithCleanup = useCallback((tab: Tab) => {
    if (isSessionTab(tab)) {
      useWorkspacePanelStore.getState().clearSession(tab.sessionId)
      useTerminalPanelStore.getState().clearSession(tab.sessionId)
      useActivityPanelStore.getState().close(tab.sessionId)
    }
    closeTab(tab.sessionId)
  }, [closeTab])

  const getRunningSessionIds = useCallback((targetTabs: Tab[]) => {
    const chatSessions = useChatStore.getState().sessions
    return targetTabs
      .filter((tab) => isSessionTab(tab))
      .filter((tab) => {
        const sessionState = chatSessions[tab.sessionId]
        return !!sessionState &&
          (sessionState.chatState !== 'idle' || hasRunningBackgroundTasks(sessionState.backgroundAgentTasks))
      })
      .map((tab) => tab.sessionId)
  }, [])

  const closeTabsWithPolicy = useCallback((targetTabs: Tab[], runningSessionIds: string[], stopRunning: boolean) => {
    const runningSessionSet = new Set(runningSessionIds)

    for (const tab of targetTabs) {
      if (isSessionTab(tab)) {
        const isRunning = runningSessionSet.has(tab.sessionId)
        if (isRunning && stopRunning) {
          useChatStore.getState().stopGeneration(tab.sessionId)
        }
        if (!isRunning || stopRunning) {
          // Auto-delete empty sessions (placeholder title, no messages sent)
          const sessionEntry = useSessionStore.getState().sessions.find((s) => s.id === tab.sessionId)
          const chatEntry = useChatStore.getState().sessions[tab.sessionId]
          if (isPlaceholderSessionTitle(sessionEntry?.title) && (!chatEntry || chatEntry.messages.length === 0)) {
            void useSessionStore.getState().deleteSession(tab.sessionId)
          }
          disconnectSession(tab.sessionId)
        }
      }
      closeTabWithCleanup(tab)
    }
  }, [closeTabWithCleanup, disconnectSession])

  const requestCloseTabs = useCallback((targetTabs: Tab[]) => {
    if (targetTabs.length === 0) return
    const runningSessionIds = getRunningSessionIds(targetTabs)

    if (runningSessionIds.length > 0) {
      setPendingCloseRequest({ tabs: targetTabs, runningSessionIds })
      return
    }

    closeTabsWithPolicy(targetTabs, [], false)
  }, [closeTabsWithPolicy, getRunningSessionIds])

  const handleClose = (sessionId: string) => {
    const tab = tabs.find((t) => t.sessionId === sessionId)
    if (!tab) return
    requestCloseTabs([tab])
  }

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY })
  }

  const handleCloseOthers = (sessionId: string) => {
    setContextMenu(null)
    const otherTabs = tabs.filter((t) => t.sessionId !== sessionId)
    requestCloseTabs(otherTabs)
  }

  const handleCloseLeft = (sessionId: string) => {
    setContextMenu(null)
    const idx = tabs.findIndex((t) => t.sessionId === sessionId)
    const leftTabs = tabs.slice(0, idx)
    requestCloseTabs(leftTabs)
  }

  const handleCloseRight = (sessionId: string) => {
    setContextMenu(null)
    const idx = tabs.findIndex((t) => t.sessionId === sessionId)
    const rightTabs = tabs.slice(idx + 1)
    requestCloseTabs(rightTabs)
  }

  const handleCloseAll = () => {
    setContextMenu(null)
    requestCloseTabs(tabs)
  }

  const getTargetIndexFromClientX = useCallback((clientX: number) => {
    for (let index = 0; index < tabs.length; index++) {
      const tab = tabs[index]
      if (!tab) continue
      const el = tabRefs.current.get(tab.sessionId)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) return index
    }

    return tabs.length > 0 ? tabs.length - 1 : null
  }, [tabs])

  const finalizeDrag = useCallback((targetIndex: number | null) => {
    if (dragIndexRef.current !== null && targetIndex !== null && dragIndexRef.current !== targetIndex) {
      moveTab(dragIndexRef.current, targetIndex)
    }
    dragIndexRef.current = null
    pendingDragRef.current = null
    setDraggingSessionId(null)
    setDragOffsetX(0)
    setDragOverIndex(null)
  }, [moveTab])

  const handlePointerMove = useCallback((event: MouseEvent) => {
    const pending = pendingDragRef.current
    if (!pending) return

    const deltaX = Math.abs(event.clientX - pending.startX)
    const deltaY = Math.abs(event.clientY - pending.startY)

    if (dragIndexRef.current === null) {
      if (Math.max(deltaX, deltaY) < DRAG_START_THRESHOLD) return
      dragIndexRef.current = pending.index
      suppressClickRef.current = true
      setDraggingSessionId(tabs[pending.index]?.sessionId ?? null)
    }

    setDragOffsetX(event.clientX - pending.startX)

    const targetIndex = getTargetIndexFromClientX(event.clientX)
    if (targetIndex === null || targetIndex === dragIndexRef.current) {
      setDragOverIndex(null)
      return
    }

    setDragOverIndex(targetIndex)
  }, [getTargetIndexFromClientX])

  const handlePointerUp = useCallback(() => {
    finalizeDrag(dragOverIndex)
  }, [dragOverIndex, finalizeDrag])

  useEffect(() => {
    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
    return () => {
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  useEffect(() => {
    if (!draggingSessionId) return
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = 'grabbing'
    return () => {
      document.body.style.cursor = previousCursor
    }
  }, [draggingSessionId])

  const handleTabMouseDown = (event: React.MouseEvent, index: number) => {
    if (event.button !== 0) return
    pendingDragRef.current = { index, startX: event.clientX, startY: event.clientY }
  }

  const handleTabClick = (sessionId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setActiveTab(sessionId)
  }

  return (
    <div
      data-testid="tab-bar"
      data-desktop-drag-region={isDesktopRuntime ? true : undefined}
      className="flex min-h-[52px] items-stretch bg-[var(--color-surface)] select-none border-b border-[var(--color-border)]"
    >

      {canScrollLeft && (
        <button type="button" onClick={() => scroll('left')} aria-label={t('tabs.scrollLeft')} className="flex h-[52px] w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]">
          <span className="material-symbols-outlined text-[16px]">chevron_left</span>
        </button>
      )}

      <div
        ref={scrollRef}
        data-testid="tab-bar-scroll-region"
        data-desktop-drag-region={isDesktopRuntime ? true : undefined}
        className="min-w-0 flex-1 flex items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onDragOver={(e) => e.preventDefault()}
        onWheel={handleTabWheel}
      >
        {tabs.map((tab, index) => {
          const displayTitle = tab.type === 'settings'
            ? t('settings.title')
            : (tab.title || t('tabs.untitled'))
          return (
            <TabItem
              key={tab.sessionId}
              ref={(node) => { tabRefs.current.set(tab.sessionId, node) }}
              tab={tab}
              displayTitle={displayTitle}
              closeLabel={t('tabs.closeTab', { title: displayTitle })}
              isRunning={runningSessionIds.has(tab.sessionId)}
              isActive={tab.sessionId === activeTabId}
              isDragOver={dragOverIndex === index}
              isDragging={tab.sessionId === draggingSessionId}
              dragOffsetX={tab.sessionId === draggingSessionId ? dragOffsetX : 0}
              runningLabel={t('tabs.sessionRunning')}
              onClick={() => handleTabClick(tab.sessionId)}
              onClose={() => handleClose(tab.sessionId)}
              onContextMenu={(e) => handleContextMenu(e, tab.sessionId)}
              onMouseDown={(event) => handleTabMouseDown(event, index)}
            />
          )
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-l border-[var(--color-border)] px-2">
        {showActivityButton && activeTabId && (
          <SessionActivityButton sessionId={activeTabId} />
        )}
        {isDesktopRuntime && isActiveSessionTab && activeTabId && (
          <IconButton
            icon={<Building2 size={17} strokeWidth={1.9} />}
            label={t('agentOffice.title')}
            onClick={() => {
              if (agentOfficeSurface === 'tab') {
                useTabStore.getState().openOfficeTab(activeTabId, t('agentOffice.title'))
                return
              }
              useUIStore.getState().openModal(`agentOffice:${activeTabId}`)
            }}
            size="md"
            tone="muted"
          />
        )}
        {isDesktopRuntime && isActiveSessionTab && (
          <OpenProjectMenu path={openProjectPath} />
        )}
        <IconButton
          icon={<SquareTerminal size={17} strokeWidth={1.9} />}
          label={t('tabs.openTerminal')}
          onClick={() => {
            if (activeTabId && isActiveSessionTab) {
              useTerminalPanelStore.getState().togglePanel(activeTabId)
              return
            }
            useTabStore.getState().openTerminalTab()
          }}
          size="md"
          tone={isTerminalPanelOpen ? 'default' : 'muted'}
          pressed={isTerminalPanelOpen}
          data-active={isTerminalPanelOpen ? 'true' : 'false'}
        />
        {isActiveSessionTab && activeTabId && (
          <IconButton
            icon={isWorkspacePanelOpen ? <FolderOpen size={18} strokeWidth={1.9} /> : <Folder size={18} strokeWidth={1.9} />}
            label={t(isWorkspacePanelOpen ? 'tabs.hideWorkspace' : 'tabs.showWorkspace')}
            onClick={() => {
              const workbench = useWorkspacePanelStore.getState()
              if (workbench.isPanelOpen(activeTabId) && workbench.getMode(activeTabId) === 'workspace') {
                workbench.closePanel(activeTabId)
              } else {
                workbench.setMode(activeTabId, 'workspace')
                workbench.openPanel(activeTabId)
              }
            }}
            size="md"
            tone={isWorkspacePanelOpen ? 'default' : 'muted'}
            pressed={isWorkspacePanelOpen}
            data-active={isWorkspacePanelOpen ? 'true' : 'false'}
          />
        )}
      </div>

      {isDesktopRuntime && (
        <div
          data-testid="tab-bar-drag-gutter"
          data-desktop-drag-region
          aria-hidden="true"
          className={`min-h-[52px] flex-shrink-0 ${showWindowControls ? 'w-3' : 'w-4'}`}
        />
      )}

      {canScrollRight && (
        <button type="button" onClick={() => scroll('right')} aria-label={t('tabs.scrollRight')} className="flex h-[52px] w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]">
          <span className="material-symbols-outlined text-[16px]">chevron_right</span>
        </button>
      )}

      <WindowControls />

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[var(--z-dropdown)] min-w-[180px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-2 shadow-[var(--shadow-dropdown)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { handleClose(contextMenu.sessionId); setContextMenu(null) }}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.close')}
          </button>
          <button
            onClick={() => handleCloseOthers(contextMenu.sessionId)}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeOthers')}
          </button>
          <button
            onClick={() => handleCloseLeft(contextMenu.sessionId)}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeLeft')}
          </button>
          <button
            onClick={() => handleCloseRight(contextMenu.sessionId)}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeRight')}
          </button>
          <div className="my-1.5 border-t border-[var(--color-border)]" />
          <button
            onClick={handleCloseAll}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeAll')}
          </button>
        </div>
      )}

      <ActionDialog
        open={pendingCloseRequest !== null}
        onClose={() => setPendingCloseRequest(null)}
        title={pendingCloseRequest && pendingCloseRequest.runningSessionIds.length > 1
          ? t('tabs.closeAllConfirmTitle')
          : t('tabs.closeConfirmTitle')}
        body={pendingCloseRequest && pendingCloseRequest.runningSessionIds.length > 1
          ? t('tabs.closeAllConfirmMessage', { count: pendingCloseRequest.runningSessionIds.length })
          : t('tabs.closeConfirmMessage')}
        actions={[
          {
            label: t('common.cancel'),
            onClick: () => setPendingCloseRequest(null),
            variant: 'secondary',
          },
          {
            label: t('tabs.closeConfirmKeep'),
            onClick: () => {
              if (!pendingCloseRequest) return
              closeTabsWithPolicy(pendingCloseRequest.tabs, pendingCloseRequest.runningSessionIds, false)
              setPendingCloseRequest(null)
            },
            variant: 'secondary',
          },
          {
            label: pendingCloseRequest && pendingCloseRequest.runningSessionIds.length > 1
              ? t('tabs.closeAllConfirmStop')
              : t('tabs.closeConfirmStop'),
            onClick: () => {
              if (!pendingCloseRequest) return
              closeTabsWithPolicy(pendingCloseRequest.tabs, pendingCloseRequest.runningSessionIds, true)
              setPendingCloseRequest(null)
            },
            variant: 'danger',
          },
        ]}
      />
    </div>
  )
}

const TabItem = forwardRef<HTMLDivElement, {
  tab: Tab
  displayTitle: string
  closeLabel: string
  isRunning: boolean
  isActive: boolean
  isDragOver: boolean
  isDragging: boolean
  dragOffsetX: number
  runningLabel: string
  onClick: () => void
  onClose: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onMouseDown: (event: React.MouseEvent) => void
}>(({ tab, displayTitle, closeLabel, isRunning, isActive, isDragOver, isDragging, dragOffsetX, runningLabel, onClick, onClose, onContextMenu, onMouseDown }, ref) => {
  return (
    <div
      ref={ref}
      data-dragging={isDragging ? 'true' : 'false'}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      className={`
        tab-bar-interactive group relative flex min-h-[52px] flex-shrink-0 items-center gap-1.5 px-3
        ${isDragging ? 'z-[var(--z-sticky)] cursor-grabbing' : 'cursor-grab'}
        transition-[background-color,box-shadow,opacity,transform] duration-150 ease-out
        ${isActive
          // Underline, not a pill: the active tab shares the bar's ground and is
          // marked by a 3px terracotta rule plus weight on the label.
          ? 'bg-transparent shadow-[inset_0_-3px_0_var(--color-brand)]'
          : 'bg-transparent hover:bg-[var(--color-surface-hover)]'
        }
        ${isDragging ? 'opacity-95 shadow-[var(--shadow-overlay)] ring-1 ring-[var(--color-border)]' : ''}
        ${isDragOver ? 'before:absolute before:left-0 before:top-[4px] before:bottom-[4px] before:w-[3px] before:bg-[var(--color-brand)] before:rounded-full' : ''}
      `}
      style={{
        width: TAB_WIDTH,
        maxWidth: TAB_WIDTH,
        transform: isDragging ? `translateX(${dragOffsetX}px) scale(1.02)` : undefined,
      }}
    >
      {tab.type === 'session' && isRunning && (
        <StatusDot tone="brand" pulse label={runningLabel} className="flex-shrink-0" />
      )}
      {tab.type === 'session' && tab.status === 'error' && (
        <StatusDot tone="danger" className="flex-shrink-0" />
      )}
      {tab.type === 'settings' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">settings</span>
      )}
      {tab.type === 'scheduled' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">schedule</span>
      )}
      {tab.type === 'terminal' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">terminal</span>
      )}
      {tab.type === 'workbench' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">view_sidebar</span>
      )}

      <span className={`flex-1 truncate text-xs ${isActive ? 'text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)]'}`}>
        {displayTitle}
      </span>

      {/*
        The fade lives on the wrapper, not on the button: `IconButton` pins
        `transition-colors`, which does not cover opacity, and a competing
        `transition-[…]` in `className` would resolve by stylesheet order.
      */}
      <span className="-mr-1 flex-shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        <IconButton
          icon="close"
          label={closeLabel}
          onMouseDown={(e) => { e.stopPropagation() }}
          onClick={(e) => { e.stopPropagation(); onClose() }}
          size="xs"
          tone="muted"
          showTooltip={false}
        />
      </span>
    </div>
  )
})
TabItem.displayName = 'TabItem'
