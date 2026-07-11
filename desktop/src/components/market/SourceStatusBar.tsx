import { useTranslation } from '../../i18n'
import type { MarketSource, SourceStatusInfo } from '../../types/market'
import { MARKET_SOURCES } from '../../types/market'

const DOT_CLASSES: Record<SourceStatusInfo['status'], string> = {
  ok: 'bg-[var(--color-success)]',
  degraded: 'bg-[var(--color-warning)]',
  failed: 'bg-[var(--color-error)]',
  cached: 'bg-[var(--color-text-tertiary)]',
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

export function SourceStatusBar({
  sources,
  className = '',
}: {
  sources: Partial<Record<MarketSource, SourceStatusInfo>>
  className?: string
}) {
  const t = useTranslation()
  return (
    <div
      className={`flex flex-wrap items-center gap-1 rounded-lg bg-[var(--color-surface-container-low)] p-1 ${className}`}
      data-testid="market-source-status"
    >
      {MARKET_SOURCES.map((source) => {
        const info = sources[source]
        if (!info) return null
        const statusLabel =
          info.status === 'cached' && info.fetchedAt
            ? t('market.sourceStatus.cachedAt', { time: formatTime(info.fetchedAt) })
            : t(`market.sourceStatus.${info.status}`)
        return (
          <span
            key={source}
            data-testid={`market-source-status-${source}`}
            title={info.error || undefined}
            className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--color-text-secondary)]"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[info.status]}`} aria-hidden />
            <span className="font-medium text-[var(--color-text-primary)]">{t(`market.source.${source}`)}</span>
            <span className="text-[var(--color-text-tertiary)]">{statusLabel}</span>
          </span>
        )
      })}
    </div>
  )
}
