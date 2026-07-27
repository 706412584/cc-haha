import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useTabStore } from '../../stores/tabStore'

export function StatusBar() {
  const { currentModel } = useSettingsStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const runtimeSelection = useSessionRuntimeStore((s) =>
    activeTabId ? s.selections[activeTabId] : undefined,
  )
  const projectPath = useSessionStore((s) => s.sessions.find((session) => session.id === activeTabId)?.projectPath)

  const projectName = projectPath
    ? projectPath.split('-').filter(Boolean).pop() || ''
    : ''
  const modelLabel = runtimeSelection?.modelId ?? currentModel?.name ?? null

  return (
    <div className="flex h-[var(--statusbar-height)] select-none items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-4 text-[11px]">
      <div className="flex min-w-0 items-center gap-3">
        {projectName && (
          <span className="truncate font-mono text-[var(--color-text-secondary)]">{projectName}</span>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-4">
        {modelLabel && (
          <span className="truncate font-mono text-[var(--color-text-tertiary)]">
            {modelLabel}
          </span>
        )}
      </div>
    </div>
  )
}
