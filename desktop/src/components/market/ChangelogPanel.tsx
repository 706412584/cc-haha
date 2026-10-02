import { ExternalLink } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import type { NormalizedSkillDetail } from '../../types/market'
import { formatIsoDate, safeUrl } from './marketFormat'

/**
 * The latest release note, as upstream published it. Upstream keeps only the
 * newest one; the registry page has the rest, so it is linked when known.
 */
export function ChangelogPanel({
  changelog,
  version,
  pageUrl,
}: {
  changelog?: NormalizedSkillDetail['changelog']
  /** The skill's current version, used when the note does not name its own. */
  version?: string
  pageUrl?: string
}) {
  const t = useTranslation()
  const href = safeUrl(pageUrl)
  const releaseVersion = changelog?.version || version
  const published = formatIsoDate(changelog?.publishedAt)

  return (
    <Card
      radius="xl"
      surface="base"
      padding="none"
      className="px-6 py-5 sm:px-[30px]"
      data-testid="market-changelog-panel"
    >
      <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">{t('market.detail.changelog')}</h2>
      {changelog ? (
        <article className="mt-3.5">
          <header className="flex flex-wrap items-center gap-2.5">
            {releaseVersion && (
              <Badge variant="outline" size="sm" pill={false} mono>
                {releaseVersion.startsWith('v') ? releaseVersion : `v${releaseVersion}`}
              </Badge>
            )}
            {published && <span className="font-mono text-xs text-[var(--color-text-tertiary)]">{published}</span>}
          </header>
          <p className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-[1.7] text-[var(--color-text-secondary)]">
            {changelog.text}
          </p>
        </article>
      ) : (
        <p className="mt-3 text-sm text-[var(--color-text-tertiary)]">{t('market.detail.noChangelog')}</p>
      )}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-4 inline-flex w-fit items-center gap-1 rounded-[var(--radius-sm)] text-[13px] font-medium text-[var(--color-brand)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        >
          {t('market.detail.sourcePage')}
          <ExternalLink className="h-3 w-3" strokeWidth={1.8} aria-hidden="true" />
        </a>
      )}
    </Card>
  )
}
