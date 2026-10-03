import { useTranslation } from '../../i18n'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import type { MarketCategory } from '../../types/market'
import { categoryLabel, useMarketLocale } from './catalogLocale'

/**
 * Category chips above the curated catalog.
 *
 * The categories are the catalog's own, so every chip has skills behind it and
 * its count is exact (static over the whole catalog, not the current filter).
 * Nothing renders until the server has sent them; a bar of "All" alone would
 * be a control with nothing to choose.
 *
 * Chips stay clickable while a page loads: the store drops superseded
 * responses, and dimming the whole row on every switch of a local list would
 * flicker for nothing.
 */
export function CategoryBar({
  categories,
  value,
  onChange,
}: {
  categories: readonly MarketCategory[]
  value: string
  onChange: (key: string) => void
}) {
  const t = useTranslation()
  const locale = useMarketLocale()
  if (categories.length === 0) return null

  const items = [
    { value: 'all', label: t('market.category.all') },
    ...categories.map((category) => ({
      value: category.key,
      label: (
        <>
          {categoryLabel(category, locale)}
          <span className="text-[11px] font-normal tabular-nums opacity-60">{category.count}</span>
        </>
      ),
    })),
  ]

  return (
    <div data-testid="market-category-bar">
      <SegmentedControl
        items={items}
        value={value}
        onChange={onChange}
        label={t('market.category.label')}
        appearance="chip"
      />
    </div>
  )
}
