import { useCallback, useMemo } from 'react'
import { ArrowLeft, CircleAlert, Download, KeyRound, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-surface-container-lowest)]" data-testid="market-detail-loading">
        <div className="mx-auto w-full max-w-[1320px] px-6 py-6 lg:px-8">
          <button
            type="button"
            onClick={backToList}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md pr-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            {t('market.detail.back')}
          </button>
          <div className="mt-5 animate-pulse">
            <div className="flex items-start gap-5 border-b border-[var(--color-border)]/70 pb-6">
              <div className="h-16 w-16 flex-shrink-0 rounded-[14px] bg-[var(--color-surface-container-high)]" />
              <div className="min-w-0 flex-1 pt-1">
                <div className="h-2.5 w-24 rounded bg-[var(--color-surface-container)]" />
                <div className="mt-3 h-6 w-64 max-w-full rounded bg-[var(--color-surface-container-high)]" />
                <div className="mt-4 h-3 w-[min(100%,36rem)] rounded bg-[var(--color-surface-container)]" />
              </div>
            </div>
            <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div>
                <div className="h-10 w-52 rounded bg-[var(--color-surface-container)]" />
                <div className="mt-5 h-72 rounded-xl border border-[var(--color-border)]/60 bg-[var(--color-surface-container-low)]" />
              </div>
              <div className="order-first h-72 rounded-xl border border-[var(--color-border)]/60 bg-[var(--color-surface-container-low)] lg:order-none" />
            </div>
          </div>
          <p className="sr-only">{t('market.loading')}</p>
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
          <button
            type="button"
            onClick={() => void refreshDetail(selectedId)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:scale-[0.98]"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {t('market.retry')}
          </button>
          <button
            type="button"
            onClick={backToList}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-4 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:scale-[0.98]"
          >
            {t('market.detail.back')}
          </button>
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
        <button
          type="button"
          data-testid="market-install-button"
          disabled={installing}
          onClick={() => onRequestInstall(detail.id)}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[image:var(--gradient-btn-primary)] px-5 text-sm font-semibold text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] transition-[filter,transform] hover:brightness-105 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:translate-y-px disabled:opacity-50"
        >
          {installing ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
          ) : (
            <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          )}
          {installing ? t('market.install.installing') : t('market.install.action')}
        </button>
      )}
      {detail.installState === 'installed' && (
        <button
          type="button"
          data-testid="market-uninstall-button"
          disabled={installing}
          onClick={() => onRequestUninstall(detail.id)}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--color-error)]/25 bg-[var(--color-surface)] px-5 text-sm font-medium text-[var(--color-error)] transition-colors hover:border-[var(--color-error)]/50 hover:bg-[var(--color-error-container)]/35 focus-visible:outline-none focus-visible:shadow-[var(--shadow-error-ring)] active:scale-[0.98] disabled:opacity-50"
        >
          {installing ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
          ) : (
            <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          )}
          {installing ? t('market.uninstall.uninstalling') : t('market.uninstall.action')}
        </button>
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
          className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--color-error)]/25 bg-[var(--color-error-container)]/35 px-3.5 py-2.5 text-sm text-[var(--color-text-primary)]"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--color-error)]" strokeWidth={2} aria-hidden="true" />
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
      files={detail.files.map((f) => ({ path: f.path, size: f.size, language: f.language, tooBig: f.tooBig }))}
      loadFile={loadFile}
      onBack={backToList}
      backLabel={t('market.detail.back')}
    />
  )
}
