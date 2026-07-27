import { lazy, Suspense, useEffect } from 'react'
import { ArrowLeft, Maximize2 } from 'lucide-react'
import { t, useTranslation } from '../i18n'
import { useTabStore } from '../stores/tabStore'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useSessionActivityModel } from '../components/activity/useSessionActivityModel'
import { useTeamStore } from '../stores/teamStore'
import { useChatStore } from '../stores/chatStore'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import { getDesktopHost } from '../lib/desktopHost'
import { useCLITaskStore } from '../stores/cliTaskStore'
import type { ActivityRow } from '../components/activity/sessionActivityModel'

const AgentOfficeRuntime = lazy(() =>
  import('../components/agentOffice/AgentOfficeRuntime').then((module) => ({
    default: module.AgentOfficeRuntime,
  })),
)

export function buildOfficeTaskDispatchMessage(sessionId: string, rows: ActivityRow[]): {
  content: string
  displayContent: string
} {
  const tasks = [...rows]
    .filter(row => row.section === 'tasks' && row.status === 'pending' && (row.blockedBy?.length ?? 0) === 0)
    .sort((left, right) => (left.taskId ?? left.id).localeCompare(right.taskId ?? right.id))
  const taskIds = Array.from(new Set(tasks.map(row => row.taskId ?? row.id)))
  const lines = tasks.map(row => `- #${row.taskId ?? row.id}: ${row.label}${row.owner ? ` (owner: ${row.owner})` : ''}`)
  return {
    content: [
      taskIds.length > 1
        ? 'Evaluate and process these ready tasks in parallel where their file scopes and dependencies allow.'
        : 'Process this ready task now.',
      `Session task list: ${sessionId}`,
      `Task IDs: ${taskIds.join(', ')}`,
      ...lines,
      'Respect blockedBy dependencies and use exact Task owners when coordinating named Agents.',
    ].join('\n'),
    displayContent: taskIds.length > 1
      ? t('agentOffice.dispatch.multiple', { tasks: tasks.map(row => row.label).join(', ') })
      : t('agentOffice.dispatch.single', { task: tasks[0]?.label ?? taskIds[0] ?? '' }),
  }
}

export function dispatchOfficeTasks(sessionId: string, rows: ActivityRow[]): void {
  const message = buildOfficeTaskDispatchMessage(sessionId, rows)
  const chatStore = useChatStore.getState()
  const chatState = chatStore.sessions[sessionId]?.chatState ?? 'idle'
  if (chatState === 'idle') {
    chatStore.sendMessage(sessionId, message.content, undefined, { displayContent: message.displayContent })
  } else {
    chatStore.enqueueMessage(sessionId, message.content, undefined, { displayContent: message.displayContent })
  }
}

function AgentOfficeContent({ sessionId }: { sessionId: string }) {
  const activity = useSessionActivityModel(sessionId)
  const stopBackgroundTask = useChatStore((state) => state.stopBackgroundTask)
  const dismissActivityRows = useActivityPanelStore((state) => state.dismissBackgroundTaskKeys)
  const fetchSessionTasks = useCLITaskStore((state) => state.fetchSessionTasks)

  useEffect(() => {
    void fetchSessionTasks(sessionId)
  }, [fetchSessionTasks, sessionId])

  const dispatchTasks = (taskIds: string[]) => {
    const taskIdSet = new Set(taskIds)
    const rows = activity.model.sections.tasks.rows.filter(row => taskIdSet.has(row.taskId ?? row.id))
    dispatchOfficeTasks(sessionId, rows)
  }

  return (
    <Suspense
      fallback={(
        <div className="flex h-full min-h-[420px] w-full items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-sm text-[var(--color-text-tertiary)]">
          Agent Office
        </div>
      )}
    >
      <AgentOfficeRuntime
        sessionId={sessionId}
        activity={activity}
        onOpenSubagent={(payload) => {
          useTabStore.getState().openSubagentTab(payload.sessionId, payload.toolUseId, payload.title)
        }}
        onOpenMember={(member) => useTeamStore.getState().openMemberSession(member)}
        onStopBackgroundTask={(taskId) => stopBackgroundTask(sessionId, taskId)}
        onDismissActivityRows={(keys) => dismissActivityRows(sessionId, keys)}
        onOpenOutputFile={(path) => {
          const shell = getDesktopHost().shell
          if (shell.showItemInFolder) void shell.showItemInFolder(path)
        }}
        onDispatchTasks={dispatchTasks}
        onSendQueuedMessageNow={(queuedMessageId) => useChatStore.getState().sendQueuedMessageNow(sessionId, queuedMessageId)}
        onRemoveQueuedMessage={(queuedMessageId) => useChatStore.getState().removeQueuedMessage(sessionId, queuedMessageId)}
        onSendMemberMessage={(member, content) => {
          const memberSessionId = member.sessionId ?? `team-member:${member.agentId}`
          void useTeamStore.getState().sendMessageToMember(memberSessionId, content)
        }}
        dispatchMode={activity.mainAgent.status === 'idle' ? 'now' : 'queue'}
      />
    </Suspense>
  )
}

export function AgentOfficePage({ sessionId, tabId }: { sessionId: string; tabId: string }) {
  const t = useTranslation()
  return (
    <div data-testid="agent-office-page" className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5">
        <button
          type="button"
          onClick={() => useTabStore.getState().returnFromOffice(tabId)}
          aria-label={t('agentOffice.returnToSession')}
          className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          <ArrowLeft size={16} />
          {t('agentOffice.returnToSession')}
        </button>
        <div className="h-5 w-px bg-[var(--color-border)]" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{t('agentOffice.title')}</h1>
          <p className="truncate text-xs text-[var(--color-text-tertiary)]">{sessionId}</p>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="h-full w-full max-w-6xl">
          <AgentOfficeContent sessionId={sessionId} />
        </div>
      </div>
    </div>
  )
}

export function AgentOfficeModal({
  sessionId,
  onClose,
  onExpand,
}: {
  sessionId: string
  onClose: () => void
  onExpand: () => void
}) {
  const t = useTranslation()

  return (
    <Modal
      open
      onClose={onClose}
      title={t('agentOffice.title')}
      width={1180}
      footer={(
        <Button
          type="button"
          variant="secondary"
          icon={<Maximize2 size={16} />}
          onClick={onExpand}
        >
          {t('agentOffice.expandToTab')}
        </Button>
      )}
    >
      <AgentOfficeContent sessionId={sessionId} />
    </Modal>
  )
}
