import { useEffect, useMemo, useState } from 'react'
import { usePluginStore, type PluginActionTarget } from '../../stores/pluginStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import type { PluginSummary } from '../../types/plugin'

type PluginBucket = 'attention' | 'enabled' | 'disabled'
type BatchAction = 'enable' | 'disable'

export function PluginList() {
  const {
    plugins,
    marketplaces,
    summary,
    lastReloadSummary,
    isLoading,
    isApplying,
    error,
    fetchPlugins,
    fetchPluginDetail,
    reloadPlugins,
    bulkEnablePlugins,
    bulkDisablePlugins,
  } = usePluginStore()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const addToast = useUIStore((s) => s.addToast)
  const t = useTranslation()
  const [selectedPluginIds, setSelectedPluginIds] = useState<Set<string>>(() => new Set())
  const [confirmBatchAction, setConfirmBatchAction] = useState<BatchAction | null>(null)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = activeSession?.workDir || undefined

  useEffect(() => {
    void fetchPlugins(currentWorkDir)
  }, [fetchPlugins, currentWorkDir])

  const grouped = useMemo(() => {
    const buckets: Record<PluginBucket, PluginSummary[]> = {
      attention: [],
      enabled: [],
      disabled: [],
    }

    for (const plugin of plugins) {
      if (plugin.hasErrors) {
        buckets.attention.push(plugin)
      } else if (plugin.enabled) {
        buckets.enabled.push(plugin)
      } else {
        buckets.disabled.push(plugin)
      }
    }

    return buckets
  }, [plugins])

  useEffect(() => {
    setSelectedPluginIds((current) => {
      const selectableIds = new Set(plugins.filter(canMutatePlugin).map((plugin) => plugin.id))
      const next = new Set([...current].filter((id) => selectableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [plugins])

  const selectedPlugins = useMemo(
    () => plugins.filter((plugin) => selectedPluginIds.has(plugin.id) && canMutatePlugin(plugin)),
    [plugins, selectedPluginIds],
  )
  const enableCandidates = useMemo(
    () => selectedPlugins.filter((plugin) => !plugin.enabled),
    [selectedPlugins],
  )
  const disableCandidates = useMemo(
    () => selectedPlugins.filter((plugin) => plugin.enabled),
    [selectedPlugins],
  )
  const confirmBatchPlugins = confirmBatchAction === 'enable' ? enableCandidates : disableCandidates
  const confirmBatchNames = useMemo(
    () => formatPluginNames(confirmBatchPlugins),
    [confirmBatchPlugins],
  )

  const handleReload = async () => {
    try {
      const reloadSummary = await reloadPlugins(currentWorkDir, activeSessionId || undefined)
      addToast({
        type: reloadSummary.errors > 0 ? 'warning' : 'success',
        message: t('settings.plugins.reloadToast', {
          enabled: String(reloadSummary.enabled),
          skills: String(reloadSummary.skills),
          errors: String(reloadSummary.errors),
        }),
      })
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const togglePluginSelection = (pluginId: string, selected: boolean) => {
    setSelectedPluginIds((current) => {
      const next = new Set(current)
      if (selected) {
        next.add(pluginId)
      } else {
        next.delete(pluginId)
      }
      return next
    })
  }

  const clearSelection = () => {
    setSelectedPluginIds(new Set())
  }

  const toActionTargets = (items: PluginSummary[]): PluginActionTarget[] =>
    items.map((plugin) => ({ id: plugin.id, scope: plugin.scope }))

  const handleBatchConfirm = async () => {
    if (!confirmBatchAction) return

    const action = confirmBatchAction
    const targets = action === 'enable' ? enableCandidates : disableCandidates
    if (targets.length === 0) {
      setConfirmBatchAction(null)
      return
    }

    try {
      const changed = action === 'enable'
        ? await bulkEnablePlugins(toActionTargets(targets), currentWorkDir, activeSessionId || undefined)
        : await bulkDisablePlugins(toActionTargets(targets), currentWorkDir, activeSessionId || undefined)

      setSelectedPluginIds((current) => {
        const next = new Set(current)
        for (const plugin of targets) {
          next.delete(plugin.id)
        }
        return next
      })
      setConfirmBatchAction(null)
      addToast({
        type: 'success',
        message: t(action === 'enable' ? 'settings.plugins.bulkEnableToast' : 'settings.plugins.bulkDisableToast', {
          count: String(changed),
        }),
      })
    } catch (err) {
      setConfirmBatchAction(null)
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (isLoading) {
    return <LoadingState label={t('common.loading')} labelHidden />
  }

  if (error) {
    // Was a bare red line of text with no role, so a screen reader only found
    // the failure by walking into it.
    return <ErrorState title={error} />
  }

  if (plugins.length === 0) {
    return (
      <EmptyState
        icon={<span className="material-symbols-outlined text-[20px]">extension</span>}
        title={t('settings.plugins.empty')}
        description={t('settings.plugins.emptyHint')}
        action={{ label: t('settings.plugins.refresh'), onClick: () => void fetchPlugins(currentWorkDir) }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] shadow-[var(--shadow-card)] overflow-hidden">
        <div className="flex flex-col gap-4 px-5 py-5 min-w-0">
          <div className="flex flex-col gap-4 min-w-0 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 max-w-4xl">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)] mb-2">
                {t('settings.plugins.browserEyebrow')}
              </div>
              <div className="flex items-center gap-3 mb-2">
                <span className="material-symbols-outlined text-[22px] text-[var(--color-brand)]">
                  extension
                </span>
                <h3
                  className="text-[21px] font-semibold leading-tight text-[var(--color-text-primary)]"
                  style={{ fontFamily: 'var(--font-headline)' }}
                >
                  {t('settings.plugins.browserTitle')}
                </h3>
              </div>
              <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                {t('settings.plugins.browserDescription')}
              </p>
            </div>

            <div className="flex flex-wrap gap-2 xl:justify-end">
              {/* `size="sm"` plus `min-h-9` was two heights fighting; `md` is
                  h-9 outright. The material icon also moves into `icon`, so
                  `loading` swaps it for the spinner instead of rendering both. */}
              <Button
                variant="secondary"
                size="md"
                className="flex-1 sm:flex-none"
                icon={<span className="material-symbols-outlined text-[16px]" aria-hidden="true">refresh</span>}
                onClick={() => void fetchPlugins(currentWorkDir)}
              >
                {t('settings.plugins.refresh')}
              </Button>
              <Button
                size="md"
                className="flex-1 sm:flex-none"
                icon={<span className="material-symbols-outlined text-[16px]" aria-hidden="true">sync</span>}
                onClick={handleReload}
                loading={isApplying}
              >
                {t('settings.plugins.apply')}
              </Button>
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4">
            <SummaryCard
              label={t('settings.plugins.summary.total')}
              value={String(summary?.total ?? plugins.length)}
              icon="extension"
            />
            <SummaryCard
              label={t('settings.plugins.summary.enabled')}
              value={String(summary?.enabled ?? plugins.filter((plugin) => plugin.enabled).length)}
              icon="check_circle"
            />
            <SummaryCard
              label={t('settings.plugins.summary.attention')}
              value={String(grouped.attention.length)}
              icon="warning"
            />
            <SummaryCard
              label={t('settings.plugins.summary.marketplaces')}
              value={String(summary?.marketplaceCount ?? marketplaces.length)}
              icon="storefront"
            />
          </div>

          {lastReloadSummary && (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              {t('settings.plugins.lastReload', {
                enabled: String(lastReloadSummary.enabled),
                skills: String(lastReloadSummary.skills),
                errors: String(lastReloadSummary.errors),
              })}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">
              checklist
            </span>
            <span className="font-medium text-[var(--color-text-primary)]">
              {t('settings.plugins.selectionCount', { count: String(selectedPlugins.length) })}
            </span>
            {selectedPlugins.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                {t('settings.plugins.clearSelection')}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              size="base"
              icon={<span className="material-symbols-outlined text-[16px]" aria-hidden="true">toggle_on</span>}
              disabled={enableCandidates.length === 0 || isApplying}
              onClick={() => setConfirmBatchAction('enable')}
            >
              {t('settings.plugins.enableSelected')}
            </Button>
            <Button
              variant="secondary"
              size="base"
              icon={<span className="material-symbols-outlined text-[16px]" aria-hidden="true">toggle_off</span>}
              disabled={disableCandidates.length === 0 || isApplying}
              onClick={() => setConfirmBatchAction('disable')}
            >
              {t('settings.plugins.disableSelected')}
            </Button>
          </div>
        </div>
      </section>

      {marketplaces.length > 0 && (
        <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
            <h4
              className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)]"
              style={{ fontFamily: 'var(--font-headline)' }}
            >
              {t('settings.plugins.marketplacesTitle')}
            </h4>
            <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
              {t('settings.plugins.marketplacesHint')}
            </p>
          </div>
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {marketplaces.map((marketplace) => (
              <div
                key={marketplace.name}
                className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                    {marketplace.name}
                  </span>
                  <Badge tone={marketplace.autoUpdate ? 'success' : 'neutral'}>
                    {marketplace.autoUpdate
                      ? t('settings.plugins.marketplaceAutoUpdateOn')
                      : t('settings.plugins.marketplaceAutoUpdateOff')}
                  </Badge>
                </div>
                <div className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)] break-words">
                  {marketplace.source}
                </div>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
                  <span>{t('settings.plugins.marketplaceInstalledCount', { count: String(marketplace.installedCount) })}</span>
                  {marketplace.lastUpdated && (
                    <span>{t('settings.plugins.marketplaceUpdatedAt', { value: new Date(marketplace.lastUpdated).toLocaleString() })}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {renderGroup('attention', grouped.attention, {
        fetchPluginDetail,
        cwd: currentWorkDir,
        t,
        selectedPluginIds,
        onToggleSelection: togglePluginSelection,
      })}
      {renderGroup('enabled', grouped.enabled, {
        fetchPluginDetail,
        cwd: currentWorkDir,
        t,
        selectedPluginIds,
        onToggleSelection: togglePluginSelection,
      })}
      {renderGroup('disabled', grouped.disabled, {
        fetchPluginDetail,
        cwd: currentWorkDir,
        t,
        selectedPluginIds,
        onToggleSelection: togglePluginSelection,
      })}

      <ConfirmDialog
        open={confirmBatchAction !== null}
        onClose={() => setConfirmBatchAction(null)}
        onConfirm={handleBatchConfirm}
        title={confirmBatchAction === 'enable'
          ? t('settings.plugins.bulkEnableTitle', { count: String(confirmBatchPlugins.length) })
          : t('settings.plugins.bulkDisableTitle', { count: String(confirmBatchPlugins.length) })}
        body={confirmBatchAction === 'enable'
          ? t('settings.plugins.bulkEnableBody', { names: confirmBatchNames })
          : t('settings.plugins.bulkDisableBody', { names: confirmBatchNames })}
        confirmLabel={confirmBatchAction === 'enable' ? t('settings.plugins.enable') : t('settings.plugins.disable')}
        cancelLabel={t('common.cancel')}
        confirmVariant={confirmBatchAction === 'disable' ? 'danger' : 'primary'}
        loading={isApplying}
      />
    </div>
  )
}

type RenderGroupOptions = {
  fetchPluginDetail: (id: string, cwd?: string) => Promise<void>
  cwd: string | undefined
  t: ReturnType<typeof useTranslation>
  selectedPluginIds: Set<string>
  onToggleSelection: (pluginId: string, selected: boolean) => void
}

function renderGroup(
  bucket: PluginBucket,
  items: PluginSummary[],
  {
    fetchPluginDetail,
    cwd,
    t,
    selectedPluginIds,
    onToggleSelection,
  }: RenderGroupOptions,
) {
  if (items.length === 0) return null

  const titleKey =
    bucket === 'attention'
      ? 'settings.plugins.group.attention'
      : bucket === 'enabled'
        ? 'settings.plugins.group.enabled'
        : 'settings.plugins.group.disabled'

  return (
    <section
      key={bucket}
      className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden"
    >
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
        <div className="min-w-0">
          <h4
            className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)]"
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {t(titleKey)}
          </h4>
          <p className="text-xs leading-5 text-[var(--color-text-tertiary)] mt-1">
            {t('settings.plugins.groupHint', { count: String(items.length) })}
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-[var(--color-text-tertiary)]">{items.length}</span>
      </div>
      <div className="flex flex-col p-2">
        {items.map((plugin) => (
          <div
            key={plugin.id}
            className={`group rounded-[var(--radius-lg)] border px-3 py-3 transition-[background-color,border-color] duration-150 ease-out hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] ${
              selectedPluginIds.has(plugin.id)
                ? 'border-[var(--color-primary-fixed-dim)] bg-[var(--color-surface-selected)]'
                : 'border-transparent'
            }`}
          >
            <div className="flex items-start gap-3">
              {canMutatePlugin(plugin) ? (
                <Checkbox
                  label={t('settings.plugins.selectPlugin', { name: plugin.name })}
                  labelHidden
                  checked={selectedPluginIds.has(plugin.id)}
                  onChange={(event) => onToggleSelection(plugin.id, event.currentTarget.checked)}
                  containerClassName="h-6 w-6 shrink-0"
                />
              ) : (
                <span className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() => void fetchPluginDetail(plugin.id, cwd)}
                className="flex min-w-0 flex-1 items-start gap-3 rounded-[var(--radius-lg)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]"
              >
                <span className="mt-0.5 material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
                  {plugin.hasErrors ? 'warning' : plugin.enabled ? 'extension' : 'extension_off'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--color-text-primary)] break-all">
                      {plugin.name}
                    </span>
                    <StatusPill plugin={plugin} />
                    <ScopePill scope={plugin.scope} />
                    {plugin.version && <Badge mono>v{plugin.version}</Badge>}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)] break-words">
                    {plugin.description || t('settings.plugins.noDescription')}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
                    <span>{plugin.marketplace}</span>
                    {plugin.componentCounts.skills > 0 && (
                      <span>{t('settings.plugins.capability.skills', { count: String(plugin.componentCounts.skills) })}</span>
                    )}
                    {plugin.componentCounts.agents > 0 && (
                      <span>{t('settings.plugins.capability.agents', { count: String(plugin.componentCounts.agents) })}</span>
                    )}
                    {plugin.componentCounts.mcpServers > 0 && (
                      <span>{t('settings.plugins.capability.mcpServers', { count: String(plugin.componentCounts.mcpServers) })}</span>
                    )}
                    {plugin.errors.length > 0 && (
                      <span className="text-[var(--color-error)]">
                        {t('settings.plugins.errorCount', { count: String(plugin.errors.length) })}
                      </span>
                    )}
                  </div>
                </div>
                <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100">
                  chevron_right
                </span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function canMutatePlugin(plugin: PluginSummary) {
  return plugin.scope !== 'managed' && plugin.scope !== 'builtin'
}

function formatPluginNames(plugins: PluginSummary[]) {
  return plugins.map((plugin) => plugin.name).join(', ')
}

function SummaryCard({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: string
}) {
  return (
    <Card radius="lg" padding="sm" className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        <span className="material-symbols-outlined text-[14px] flex-shrink-0">{icon}</span>
        <span className="min-w-0 truncate text-[10px] leading-4">
          {label}
        </span>
      </div>
      <div
        className="mt-1.5 truncate text-[21px] font-semibold leading-none text-[var(--color-text-primary)]"
        style={{ fontFamily: 'var(--font-headline)' }}
      >
        {value}
      </div>
    </Card>
  )
}

function StatusPill({ plugin }: { plugin: PluginSummary }) {
  const t = useTranslation()

  if (plugin.hasErrors) {
    return <Badge tone="danger">{t('settings.plugins.status.attention')}</Badge>
  }

  return (
    <Badge tone={plugin.enabled ? 'success' : 'neutral'}>
      {plugin.enabled
        ? t('settings.plugins.status.enabled')
        : t('settings.plugins.status.disabled')}
    </Badge>
  )
}

function ScopePill({ scope }: { scope: PluginSummary['scope'] }) {
  const t = useTranslation()
  return <Badge variant="outline">{t(`settings.plugins.scope.${scope}`)}</Badge>
}
