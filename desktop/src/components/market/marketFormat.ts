/** Compact counts: 482069 → 482.1k. Numeric and language-neutral. */
export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * Upstream timestamps are epoch millis; rendered as an ISO date so the same
 * skill reads the same in every locale and in the catalog's "updated" line.
 */
export function formatIsoDate(timestamp: number | undefined): string {
  if (timestamp === undefined) return ''
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

/** Only absolute http(s) links from upstream may become an `href`. */
export function safeUrl(url: string | undefined): string | undefined {
  return url !== undefined && /^https?:\/\//i.test(url) ? url : undefined
}
