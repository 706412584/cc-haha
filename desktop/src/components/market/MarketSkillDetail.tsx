import { useCallback, useMemo } from 'react'
import { ArrowLeft, CircleAlert, Download, KeyRound, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { Skeleton, SkeletonGroup } from '@/components/ui/Skeleton'
import { useMarketStore } from '../../stores/marketStore'
import { SkillDetailView, type SkillDetailMetaItem } from './SkillDetailView'

function formatCount(value?: number): string {
  if (value === undefined) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatDate(ts?: number): string {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleDateString()
  } catch {
    return '—'
  }
}

export function MarketSkillDetail({
  onRequestInstall,
  onRequestUninstall,
}: {
  onRequestInstall: (id: string) => void
  onRequestUninstall: (id: string) => void
}) {
  const t = useTranslation()
  const selectedId = useMarketStore((s) => s.selectedId)
  const detail = useMarketStore((s) => s.detail)
  const isDetailLoading = useMarketStore((s) => s.isDetailLoading)
  const detailError = useMarketStore((s) => s.detailError)
  const installingIds = useMarketStore((s) => s.installingIds)
  const installError = useMarketStore((s) => s.installError)
  const backToList = useMarketStore((s) => s.backToList)
  const refreshDetail = useMarketStore((s) => s.refreshDetail)
  const fetchFileContent = useMarketStore((s) => s.fetchFileContent)

  const loadFile = useCallback(
    (path: string) => {
      if (!selectedId) return Promise.reject(new Error('No skill selected'))
      return fetchFileContent(selectedId, path)
    },
    [selectedId, fetchFileContent],
  )

  const meta = useMemo<SkillDetailMetaItem[]>(() => {
    if (!detail) return []
    const items: SkillDetailMetaItem[] = [
      {
        label: t('market.detail.author'),
        value: detail.author.displayName || detail.author.handle || '—',
      },
      { label: t('market.detail.downloads'), value: formatCount(detail.stats.downloads) },
    ]
    if (detail.stats.installs !== undefined) {
      items.push({ label: t('market.detail.installs'), value: formatCount(detail.stats.installs) })
    }
    if (detail.stats.stars !== undefined) {
      items.push({ label: t('market.detail.stars'), value: formatCount(detail.stats.stars) })
    }
    items.push({ label: t('market.detail.updated'), value: formatDate(detail.updatedAt) })
    if (detail.category) items.push({ label: t('market.detail.category'), value: detail.category })
    if (detail.license) items.push({ label: t('market.detail.license'), value: detail.license })
    if (detail.requiresApiKey) {
      items.push({
        label: t('market.detail.requiresApiKey'),
        value: <KeyRound className="ml-auto h-4 w-4 text-[var(--color-warning)]" strokeWidth={2} aria-hidden="true" />,
      })
    }
    return items
  }, [detail, t])

  if (!selectedId) return null

  if (isDetailLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-surface)]" data-testid="market-detail-loading">
        <div className="mx-auto w-full max-w-[1280px] px-6 py-6 lg:px-11">
          <Button
            variant="ghost"
            size="base"
            icon={<ArrowLeft className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />}
            onClick={backToList}
          >
            {t('market.detail.back')}
          </Button>
          <SkeletonGroup label={t('market.loading')} className="mt-[18px]">
            <div className="flex items-start gap-6 pb-6">
              <Skeleton shape="block" width="92px" height="92px" radius="lg" tone="strong" className="flex-shrink-0" />
              <div className="min-w-0 flex-1 pt-1">
                <Skeleton height="0.75rem" className="w-32" />
                <Skeleton height="2rem" tone="strong" className="mt-3 w-64 max-w-full" />
                <Skeleton height="0.75rem" className="mt-4 w-[min(100%,36rem)]" />
              </div>
            </div>
            <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-9">
              <div>
                <Skeleton height="2.75rem" className="w-52" />
                <div className="mt-[22px] h-72 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]" />
              </div>
              <div className="order-first h-72 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] lg:order-none" />
            </div>
          </SkeletonGroup>
        </div>
      </div>
    )
  }

  if (detailError || !detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-20 text-center" data-testid="market-detail-error">
        <CircleAlert className="h-9 w-9 text-[var(--color-error)]" strokeWidth={1.7} aria-hidden="true" />
        <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('market.detail.loadError')}</p>
        {detailError && <p className="max-w-md break-words text-xs text-[var(--color-text-tertiary)]">{detailError}</p>}
        <div className="mt-1 flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
            onClick={() => void refreshDetail(selectedId)}
          >
            {t('market.retry')}
          </Button>
          <Button variant="ghost" onClick={backToList}>
            {t('market.detail.back')}
          </Button>
        </div>
      </div>
    )
  }

  const installing = installingIds.has(detail.id)
  const mirrorSource = detail.mirrors?.length
    ? detail.mirrors[0]!.split(':')[0]
    : detail.upstream
      ? detail.upstream.source
      : null

  const actions = (
    <>
      {detail.installState === 'installable' && (
        <Button
          size="lg"
          data-testid="market-install-button"
          data-market-skill-action-id={detail.id}
          loading={installing}
          icon={<Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
          onClick={() => onRequestInstall(detail.id)}
        >
          {installing ? t('market.install.installing') : t('market.install.action')}
        </Button>
      )}
      {detail.installState === 'installed' && (
        <Button
          variant="danger-outline"
          size="lg"
          data-testid="market-uninstall-button"
          data-market-skill-action-id={detail.id}
          loading={installing}
          icon={<Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
          onClick={() => onRequestUninstall(detail.id)}
        >
          {installing ? t('market.uninstall.uninstalling') : t('market.uninstall.action')}
        </Button>
      )}
    </>
  )

  const banner = (
    <>
      {mirrorSource && (
        <p className="mt-3 text-[11px] text-[var(--color-text-tertiary)]">
          {t('market.detail.mirror', { source: t(`market.source.${mirrorSource as 'clawhub' | 'skillhub'}`) })}
        </p>
      )}
      {installError && installError.id === detail.id && (
        <div
          data-testid="market-install-error"
          className="mt-4 flex items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3.5 py-2.5 text-sm text-[var(--color-on-error-container)]"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.6} aria-hidden="true" />
          <span className="break-words">
            {installError.kind === 'generic'
              ? t('market.installError.generic', { message: installError.message })
              : t(`market.installError.${installError.kind}`)}
          </span>
        </div>
      )}
    </>
  )

  return (
    <SkillDetailView
      name={detail.name}
      version={detail.version}
      iconUrl={detail.iconUrl}
      sourceLabel={t(`market.source.${detail.source}`)}
      summary={detail.summary}
      securityStatus={detail.securityStatus}
      securityReports={detail.securityReports}
      installState={detail.installState}
      notInstallableReason={detail.notInstallableReason}
      actions={actions}
      banner={banner}
      meta={meta}
      description={detail.description}
      descriptionFrontmatter={detail.descriptionFrontmatter}
      files={detail.files.map((f) => ({ path: f.path, size: f.size, language: f.language, tooBig: f.tooBig }))}
      loadFile={loadFile}
      onBack={backToList}
      backLabel={t('market.detail.back')}
    />
  )
}
