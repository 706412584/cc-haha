import { ChevronDown } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Dropdown } from '../shared/Dropdown'
import { useMarketStore, type MarketFilters } from '../../stores/marketStore'
import type {
  MarketInstalledFilter,
  MarketSecurityFilter,
  MarketSourceFilter,
} from '../../types/market'

function FilterTrigger({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:scale-[0.98] ${
        active
          ? 'border-[var(--color-brand)]/35 bg-[var(--color-primary-fixed)] text-[var(--color-brand)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <span className={active ? 'text-[var(--color-brand)]/75' : 'text-[var(--color-text-tertiary)]'}>{label}</span>
      <span className="font-medium">{value}</span>
      <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
    </button>
  )
}

export function FilterBar({ className = '' }: { className?: string }) {
  const t = useTranslation()
  const filters = useMarketStore((s) => s.filters)
  const setFilter = useMarketStore((s) => s.setFilter)

  const sourceItems: Array<{ value: MarketSourceFilter; label: string }> = [
    { value: 'all', label: t('market.source.all') },
    { value: 'clawhub', label: t('market.source.clawhub') },
    { value: 'skillhub', label: t('market.source.skillhub') },
  ]
  const securityItems: Array<{ value: MarketSecurityFilter; label: string }> = [
    { value: 'all', label: t('market.security.all') },
    { value: 'verified', label: t('market.security.verified') },
    { value: 'benign', label: t('market.security.benign') },
    { value: 'unknown', label: t('market.security.unknown') },
    { value: 'flagged', label: t('market.security.flagged') },
  ]
  const installedItems: Array<{ value: MarketInstalledFilter; label: string }> = [
    { value: 'all', label: t('market.installedFilter.all') },
    { value: 'installed', label: t('market.installedFilter.installed') },
    { value: 'installable', label: t('market.installedFilter.installable') },
  ]

  const labelFor = <K extends keyof MarketFilters>(
    items: Array<{ value: MarketFilters[K]; label: string }>,
    value: MarketFilters[K],
  ) => items.find((i) => i.value === value)?.label ?? String(value)

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} data-testid="market-filter-bar">
      <Dropdown
        items={sourceItems}
        value={filters.source}
        onChange={(value) => setFilter('source', value)}
        width={220}
        trigger={
          <FilterTrigger
            label={t('market.filter.source')}
            value={labelFor(sourceItems, filters.source)}
            active={filters.source !== 'all'}
          />
        }
      />
      <Dropdown
        items={securityItems}
        value={filters.security}
        onChange={(value) => setFilter('security', value)}
        width={220}
        trigger={
          <FilterTrigger
            label={t('market.filter.security')}
            value={labelFor(securityItems, filters.security)}
            active={filters.security !== 'all'}
          />
        }
      />
      <Dropdown
        items={installedItems}
        value={filters.installed}
        onChange={(value) => setFilter('installed', value)}
        width={220}
        trigger={
          <FilterTrigger
            label={t('market.filter.installed')}
            value={labelFor(installedItems, filters.installed)}
            active={filters.installed !== 'all'}
          />
        }
      />
    </div>
  )
}
