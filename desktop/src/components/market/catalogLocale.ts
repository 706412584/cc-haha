import type { Locale } from '../../i18n/locale'
import { useSettingsStore } from '../../stores/settingsStore'
import type { MarketCategory, NormalizedSkill } from '../../types/market'

/**
 * Which copy of the curated catalog a reader sees.
 *
 * The catalog is edited in Simplified Chinese: summaries, tags and category
 * names. Chinese readers (zh and zh-TW) get those; everyone else gets the
 * upstream English summary and the category's English name, and no tags —
 * a row of Chinese chips under an English summary reads as noise, not
 * metadata. Live (non-curated) results carry the upstream's own text, which is
 * shown as it is in every locale.
 */
export function isChineseLocale(locale: Locale): boolean {
  return locale === 'zh' || locale === 'zh-TW'
}

export function skillSummary(skill: Pick<NormalizedSkill, 'summary' | 'summaryEn'>, locale: Locale): string {
  if (isChineseLocale(locale)) return skill.summary
  return skill.summaryEn || skill.summary
}

export function visibleTags(skill: Pick<NormalizedSkill, 'tags' | 'curated'>, locale: Locale): string[] {
  if (skill.curated && !isChineseLocale(locale)) return []
  return skill.tags
}

export function categoryLabel(category: Pick<MarketCategory, 'name' | 'nameEn'>, locale: Locale): string {
  if (isChineseLocale(locale)) return category.name
  return category.nameEn || category.name
}

/**
 * Display name of a skill's category. On a curated skill `category` is a
 * catalog key, resolved through the category list; on anything else it is the
 * upstream's raw string and is shown as is. An unknown key resolves to nothing
 * rather than leaking the key.
 */
export function resolveCategory(
  skill: Pick<NormalizedSkill, 'category' | 'curated'>,
  categories: readonly MarketCategory[],
  locale: Locale,
): string | undefined {
  if (!skill.category) return undefined
  if (!skill.curated) return skill.category
  const match = categories.find((category) => category.key === skill.category)
  return match ? categoryLabel(match, locale) : undefined
}

export function useMarketLocale(): Locale {
  return useSettingsStore((state) => state.locale)
}
