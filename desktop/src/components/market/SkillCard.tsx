import { ArrowUpRight, Download, Star } from 'lucide-react'
import { useTranslation } from '../../i18n'
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
    <article
      data-testid={`market-skill-card-${skill.id}`}
      className="group relative isolate flex min-h-[212px] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border)]/70 bg-[var(--color-surface-container-low)] p-4 transition-[background-color,border-color,box-shadow] duration-200 hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface)] hover:shadow-[var(--shadow-dropdown)]"
      style={{ contentVisibility: 'auto', containIntrinsicSize: '212px' }}
    >
      <button
        type="button"
        aria-label={skill.name}
        onClick={() => onOpen(skill.id)}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      />

      <div className="pointer-events-none absolute inset-x-5 top-0 z-10 h-px bg-gradient-to-r from-transparent via-[var(--color-brand)]/55 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

      <div className="pointer-events-none relative z-10 flex items-start gap-3.5">
        <SkillAvatar skill={skill} size={46} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-[var(--color-text-primary)]">
              {skill.name}
            </h3>
            {skill.version && (
              <span className="flex-shrink-0 font-mono text-[10px] leading-5 text-[var(--color-text-tertiary)]">
                v{skill.version}
              </span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)]">
            <span className="flex-shrink-0 font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
              {t(`market.source.${skill.source}`)}
            </span>
            {skill.author.handle && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{t('market.card.by', { author: skill.author.displayName || skill.author.handle })}</span>
              </>
            )}
          </div>
        </div>
        <ArrowUpRight
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--color-text-tertiary)] opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </div>

      <p className="pointer-events-none relative z-10 mt-3 line-clamp-2 min-h-[2.75rem] text-[12px] leading-[1.375rem] text-[var(--color-text-secondary)] break-words">
        {skill.summary || t('market.detail.noDescription')}
      </p>

      {skill.tags.length > 0 && (
        <div className="pointer-events-none relative z-10 mt-2.5 flex min-h-4 flex-wrap items-center gap-x-2.5 gap-y-1">
          {skill.tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
            <span
              key={tag}
              className="text-[10px] text-[var(--color-text-tertiary)]"
            >
              #{tag}
            </span>
          ))}
          {extraTags > 0 && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]">
              {t('market.card.moreTags', { count: String(extraTags) })}
            </span>
          )}
        </div>
      )}

      <footer className="pointer-events-none relative z-10 mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-[var(--color-border)]/60 pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <SecurityBadge status={skill.securityStatus} />
          {/* The quick-install button already communicates "installable" — skip the badge when the button renders. */}
          {!(skill.installState === 'installable' && showInstallButton) && (
            <InstallStateBadge state={skill.installState} />
          )}
        </div>
        <div className="ml-auto flex flex-shrink-0 items-center gap-2.5 text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          <span className="inline-flex items-center gap-1" title={t('market.detail.downloads')}>
            <Download className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
            {formatCount(skill.stats.downloads)}
          </span>
          {typeof skill.stats.stars === 'number' && skill.stats.stars > 0 && (
            <span className="inline-flex items-center gap-1" title={t('market.detail.stars')}>
              <Star className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
              {formatCount(skill.stats.stars)}
            </span>
          )}
          {showInstallButton && (
            <button
              type="button"
              disabled={installing}
              onClick={() => onInstall?.(skill.id)}
              className="pointer-events-auto relative z-20 inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-brand)]/25 bg-[var(--color-surface)] px-2.5 text-[11px] font-semibold text-[var(--color-brand)] transition-colors hover:border-[var(--color-brand)]/45 hover:bg-[var(--color-primary-fixed)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:scale-[0.98] disabled:opacity-50"
            >
              {installing ? (
                <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
              ) : (
                <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              )}
              {installing ? t('market.install.installing') : t('market.install.action')}
            </button>
          )}
        </div>
      </footer>
    </article>
  )
}
