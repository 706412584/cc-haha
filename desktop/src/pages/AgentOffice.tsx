import { lazy, Suspense } from 'react'
import { ArrowLeft, Maximize2 } from 'lucide-react'
import { useTranslation } from '../i18n'
import { useTabStore } from '../stores/tabStore'
import { Button } from '../components/shared/Button'
import { Modal } from '../components/shared/Modal'
import { useSessionActivityModel } from '../components/activity/useSessionActivityModel'
import { useTeamStore } from '../stores/teamStore'
import { useChatStore } from '../stores/chatStore'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import { getDesktopHost } from '../lib/desktopHost'

const AgentOfficeRuntime = lazy(() =>
  import('../components/agentOffice/AgentOfficeRuntime').then((module) => ({
    default: module.AgentOfficeRuntime,
  })),
)

function AgentOfficeContent({ sessionId }: { sessionId: string }) {
  const activity = useSessionActivityModel(sessionId)
  const stopBackgroundTask = useChatStore((state) => state.stopBackgroundTask)
  const dismissActivityRows = useActivityPanelStore((state) => state.dismissBackgroundTaskKeys)

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
