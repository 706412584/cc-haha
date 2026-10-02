import { Download, Star } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type { NormalizedSkill } from '../../types/market'
import { skillSummary, useMarketLocale, visibleTags } from './catalogLocale'
import { InstallStateBadge } from './InstallStateBadge'
import { formatCount } from './marketFormat'
import { SecurityBadge } from './SecurityBadge'
import { SkillAvatar } from './SkillAvatar'

const MAX_VISIBLE_TAGS = 3

/**
 * One catalog card: identity (avatar, name, version pill, source · author), a
 * two-line summary, a single chip row (scan verdict, featured mark, tags) and
 * a footer with the counts and the install action.
 *
 * The structure is fixed top to bottom with the footer pinned by `mt-auto`,
 * so a grid row lines up even when one card has no tags. The chip row is
 * clipped to one line for the same reason.
 *
 * The open affordance is one stretched `<button>` under the content: it is
 * focusable and keyboard-operable, and the card never pretends a div is a
 * link. The content above it is `pointer-events-none`, and the install button
 * opts back in — drop either half and the card stops opening or the button
 * stops installing.
 */
export function SkillCard({
  skill,
  onOpen,
  onInstall,
  installing,
}: {
  skill: NormalizedSkill
  onOpen: (id: string) => void
  onInstall?: (id: string) => void
  installing?: boolean
}) {
  const t = useTranslation()
  const locale = useMarketLocale()
  const tags = visibleTags(skill, locale)
  const extraTags = Math.max(0, tags.length - MAX_VISIBLE_TAGS)
  const showInstallButton = Boolean(onInstall) && skill.installState === 'installable'
  const author = skill.author.displayName || skill.author.handle
  const summary = skillSummary(skill, locale)

  return (
    <Card
      as="article"
      radius="xl"
      surface="base"
      padding="none"
      interactive
      lift
      className="group relative isolate flex min-h-[208px] min-w-0 flex-col gap-3 px-[18px] pb-4 pt-[18px]"
    >
      <button
        type="button"
        aria-label={skill.name}
        data-market-skill-open-id={skill.id}
        onClick={() => onOpen(skill.id)}
        className="absolute inset-0 z-0 rounded-[var(--radius-xl)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      />

      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-3">
        <SkillAvatar skill={skill} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-[15px] font-semibold leading-[22px] text-[var(--color-text-primary)]">
              {skill.name}
            </h3>
            {skill.version && (
              <Badge variant="outline" size="xs" pill={false} mono>
                v{skill.version}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-[18px] text-[var(--color-text-tertiary)]">
            <span className="flex-shrink-0">{t(`market.source.${skill.source}`)}</span>
            {author && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{author}</span>
              </>
            )}
          </p>
        </div>
      </div>

      <p className="pointer-events-none relative z-10 line-clamp-2 min-h-[42px] break-words text-[13px] leading-[21px] text-[var(--color-text-secondary)]">
        {summary || t('market.detail.noDescription')}
      </p>

      <div
        data-testid="market-card-chips"
        className="pointer-events-none relative z-10 flex max-h-6 min-w-0 flex-wrap items-center gap-1.5 overflow-hidden"
      >
        <SecurityBadge status={skill.securityStatus} short />
        {skill.featured && (
          <Badge tone="info" size="sm" pill={false} data-testid="market-card-featured">
            {t('market.featured')}
          </Badge>
        )}
        {tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
          <Badge key={tag} size="sm" pill={false}>
            {tag}
          </Badge>
        ))}
        {extraTags > 0 && (
          <Badge size="sm" pill={false}>
            {t('market.card.moreTags', { count: String(extraTags) })}
          </Badge>
        )}
      </div>

      <footer className="pointer-events-none relative z-10 mt-auto flex min-h-11 items-center justify-between gap-2.5 border-t border-[var(--color-border-separator)] pt-3">
        <div className="flex min-w-0 items-center gap-3.5 font-mono text-xs tabular-nums text-[var(--color-text-secondary)]">
          <span className="inline-flex items-center gap-1.5" title={t('market.detail.downloads')}>
            <Download className="h-3 w-3" strokeWidth={1.6} aria-hidden="true" />
            {formatCount(skill.stats.downloads)}
          </span>
          {typeof skill.stats.stars === 'number' && skill.stats.stars > 0 && (
            <span className="inline-flex items-center gap-1.5" title={t('market.detail.stars')}>
              <Star className="h-3 w-3" strokeWidth={1.6} aria-hidden="true" />
              {formatCount(skill.stats.stars)}
            </span>
          )}
        </div>
        {showInstallButton ? (
          // The footer is `pointer-events-none` for the stretched open button
          // underneath, so the install button opts back in and sits above it.
          <Button
            variant="primary"
            size="base"
            className="pointer-events-auto relative z-20 flex-shrink-0"
            loading={installing}
            data-market-skill-action-id={skill.id}
            icon={<Download className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />}
            onClick={() => onInstall?.(skill.id)}
          >
            {installing ? t('market.install.installing') : t('market.install.action')}
          </Button>
        ) : (
          <InstallStateBadge state={skill.installState} />
        )}
      </footer>
    </Card>
  )
}
