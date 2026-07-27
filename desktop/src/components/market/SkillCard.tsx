import { Download, Star } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type { NormalizedSkill } from '../../types/market'
import { InstallStateBadge } from './InstallStateBadge'
import { SecurityBadge } from './SecurityBadge'
import { SkillAvatar } from './SkillAvatar'

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

const MAX_VISIBLE_TAGS = 3

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
  const extraTags = Math.max(0, skill.tags.length - MAX_VISIBLE_TAGS)
  const showInstallButton = Boolean(onInstall) && skill.installState === 'installable'

  return (
    <Card
      as="article"
      radius="xl"
      surface="base"
      padding="lg"
      interactive
      lift
      className="group relative isolate flex min-h-[232px] min-w-0 flex-col gap-3"
    >
      <button
        type="button"
        aria-label={skill.name}
        data-market-skill-open-id={skill.id}
        onClick={() => onOpen(skill.id)}
        className="absolute inset-0 z-0 rounded-[var(--radius-xl)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      />

      <div className="pointer-events-none relative z-10 flex items-center gap-3.5">
        <SkillAvatar skill={skill} size={46} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2.5">
            <h3 className="min-w-0 flex-1 truncate text-[15.5px] font-bold leading-6 tracking-[-0.01em] text-[var(--color-text-primary)]">
              {skill.name}
            </h3>
            {skill.version && (
              <span className="flex-shrink-0 font-mono text-xs text-[var(--color-text-tertiary)]">
                v{skill.version}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            <span className="flex-shrink-0">{t(`market.source.${skill.source}`)}</span>
            {skill.author.handle && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate font-normal normal-case tracking-normal">
                  {t('market.card.by', { author: skill.author.displayName || skill.author.handle })}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <p className="pointer-events-none relative z-10 line-clamp-2 min-h-[44px] break-words text-[13.5px] leading-[1.65] text-[var(--color-text-secondary)]">
        {skill.summary || t('market.detail.noDescription')}
      </p>

      {skill.tags.length > 0 && (
        <div className="pointer-events-none relative z-10 flex min-h-5 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-[var(--color-text-tertiary)]">
          {skill.tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
          {extraTags > 0 && <span>{t('market.card.moreTags', { count: String(extraTags) })}</span>}
        </div>
      )}

      <footer className="pointer-events-none relative z-10 mt-auto flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-[var(--color-border)] pt-3.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <SecurityBadge status={skill.securityStatus} />
          {/* The quick-install button already communicates "installable" — skip the badge when the button renders. */}
          {!(skill.installState === 'installable' && showInstallButton) && (
            <InstallStateBadge state={skill.installState} />
          )}
        </div>
        <div className="ml-auto flex flex-shrink-0 items-center gap-2.5 text-[12.5px] tabular-nums text-[var(--color-text-secondary)]">
          <span className="inline-flex items-center gap-1.5" title={t('market.detail.downloads')}>
            <Download className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
            {formatCount(skill.stats.downloads)}
          </span>
          {typeof skill.stats.stars === 'number' && skill.stats.stars > 0 && (
            <span className="inline-flex items-center gap-1.5" title={t('market.detail.stars')}>
              <Star className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
              {formatCount(skill.stats.stars)}
            </span>
          )}
          {showInstallButton && (
            // The card's overlay link sets `pointer-events-none` on this
            // footer, so the button has to opt back in and sit above it.
            // `tonal` is the soft terracotta fill; the border is the handoff's
            // terracotta hairline around it.
            <Button
              variant="tonal"
              size="base"
              className="pointer-events-auto relative z-20 border border-[var(--color-primary-fixed-dim)]"
              loading={installing}
              data-market-skill-action-id={skill.id}
              icon={<Download className="h-3 w-3" strokeWidth={1.6} aria-hidden="true" />}
              onClick={() => onInstall?.(skill.id)}
            >
              {installing ? t('market.install.installing') : t('market.install.action')}
            </Button>
          )}
        </div>
      </footer>
    </Card>
  )
}
