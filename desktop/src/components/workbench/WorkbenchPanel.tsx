import { ArrowLeft, FolderOpen, Globe, Maximize2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'
import {
  useWorkspacePanelStore,
  type WorkbenchMode,
} from '../../stores/workspacePanelStore'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { WORKBENCH_TAB_PREFIX, useTabStore } from '../../stores/tabStore'
import { WorkspacePanel } from '../workspace/WorkspacePanel'
import { BrowserSurface } from '../browser/BrowserSurface'

type WorkbenchPanelProps = {
  sessionId: string
  variant?: 'panel' | 'tab'
  onClose?: () => void
}

const MODE_ITEMS: ReadonlyArray<{
  mode: WorkbenchMode
  labelKey: 'workbench.modeWorkspace' | 'workbench.modeBrowser'
  Icon: typeof FolderOpen
}> = [
  { mode: 'workspace', labelKey: 'workbench.modeWorkspace', Icon: FolderOpen },
  { mode: 'browser', labelKey: 'workbench.modeBrowser', Icon: Globe },
]

/**
 * Unified right-side "Workbench" panel. Hosts the file workspace and the native
 * browser surface behind a single per-session mode switch (file ↔ browser),
 * sharing the panel's open state and width via {@link useWorkspacePanelStore}.
 */
export function WorkbenchPanel({ sessionId, variant = 'panel', onClose }: WorkbenchPanelProps) {
  const t = useTranslation()
  const mode = useWorkspacePanelStore((state) => state.getMode(sessionId))
  const setMode = useWorkspacePanelStore((state) => state.setMode)
  const closePanel = useWorkspacePanelStore((state) => state.closePanel)
  const ensureBlankBrowser = useBrowserPanelStore((state) => state.ensureBlank)
  const isTabVariant = variant === 'tab'

  const handleModeSelect = (nextMode: WorkbenchMode) => {
    if (nextMode === 'browser') {
      ensureBlankBrowser(sessionId)
    }
    setMode(sessionId, nextMode)
  }

  const handleExpand = () => {
    const origin = useWorkspacePanelStore.getState().getOrigin(sessionId)
    useTabStore.getState().openWorkbenchTab(sessionId, t('workbench.tabTitle'), {
      sourceSessionId: sessionId,
      ...(origin ?? {}),
    })
    closePanel(sessionId)
  }

  const handleClose = () => {
    if (onClose) {
      onClose()
      return
    }
    closePanel(sessionId)
  }

  const handleReturn = () => {
    const store = useTabStore.getState()
    const activeTab = store.tabs.find((tab) => tab.sessionId === store.activeTabId)
    const tabId = activeTab?.type === 'workbench' && activeTab.workbenchSessionId === sessionId
      ? activeTab.sessionId
      : `${WORKBENCH_TAB_PREFIX}${sessionId}`
    store.returnFromWorkbench(tabId)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-surface)]">
      <header
        data-testid="workbench-navigation"
        aria-label={t('workbench.navigation')}
        className="flex h-12 shrink-0 items-center gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4"
      >
        {isTabVariant && (
          <Button
            variant="ghost"
            size="base"
            onClick={handleReturn}
            icon={<ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />}
            className="shrink-0"
          >
            {t('workbench.backToConversation')}
          </Button>
        )}
        <div
          role="tablist"
          aria-label={t('workbench.modeSwitch')}
          className="inline-flex items-center gap-0.5 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] p-0.5"
        >
          {MODE_ITEMS.map(({ mode: itemMode, labelKey, Icon }) => {
            const isActive = mode === itemMode
            return (
              <button
                key={itemMode}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleModeSelect(itemMode)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-[12px] font-medium transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                  isActive
                    ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-card)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                <Icon size={15} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                <span>{t(labelKey)}</span>
              </button>
            )
          })}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!isTabVariant && (
            <IconButton
              icon={<Maximize2 size={15} strokeWidth={2} aria-hidden="true" />}
              label={t('workbench.expand')}
              onClick={handleExpand}
              size="sm"
              tone="muted"
            />
          )}
          <IconButton
            icon={<X size={16} strokeWidth={2} aria-hidden="true" />}
            label={t('workbench.close')}
            onClick={handleClose}
            size="sm"
            tone="muted"
            showTooltip={false}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === 'browser' ? (
          <BrowserSurface sessionId={sessionId} />
        ) : (
          <WorkspacePanel sessionId={sessionId} embedded forceVisible={isTabVariant} />
        )}
      </div>
    </div>
  )
}
