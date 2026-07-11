import { useTranslation } from '../../i18n'
import type { NormalizedSkill } from '../../types/market'
import { Modal } from '../shared/Modal'
import { SecurityBadge } from './SecurityBadge'

const RISK_KEYS = {
  verified: 'market.installConfirm.riskVerified',
  benign: 'market.installConfirm.riskBenign',
  unknown: 'market.installConfirm.riskUnknown',
  flagged: 'market.installConfirm.riskFlagged',
} as const

export function InstallConfirmDialog({
  skill,
  open,
  installing,
  onConfirm,
  onClose,
}: {
  skill: NormalizedSkill | null
  open: boolean
  installing: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const t = useTranslation()
  if (!skill) return null

  const risky = skill.securityStatus === 'flagged' || skill.securityStatus === 'unknown'

  return (
    <Modal open={open} onClose={installing ? () => {} : onClose} title={t('market.installConfirm.title')} width={480}>
      <div className="flex flex-col gap-4" data-testid="market-install-confirm">
        <p className="text-sm text-[var(--color-text-primary)]">
          {t('market.installConfirm.message', { name: skill.name, source: t(`market.source.${skill.source}`) })}
        </p>

        <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3.5 py-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--color-text-tertiary)]">{t('market.filter.source')}</span>
            <span className="font-medium text-[var(--color-text-primary)]">{t(`market.source.${skill.source}`)}</span>
          </div>
          {skill.version && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--color-text-tertiary)]">{t('market.detail.version')}</span>
              <span className="font-medium text-[var(--color-text-primary)]">v{skill.version}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--color-text-tertiary)]">{t('market.filter.security')}</span>
            <SecurityBadge status={skill.securityStatus} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--color-text-tertiary)]">{t('market.installConfirm.location')}</span>
            <span className="truncate font-mono text-[11px] text-[var(--color-text-secondary)]">
              ~/.claude/skills/{skill.slug}/
            </span>
          </div>
        </div>

        <div
          className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-xs leading-5 ${
            skill.securityStatus === 'flagged'
              ? 'border border-[var(--color-error)]/40 bg-[var(--color-error-container)]/40 text-[var(--color-text-primary)]'
              : risky
                ? 'border border-[var(--color-warning)]/40 bg-[var(--color-warning-container)]/40 text-[var(--color-text-primary)]'
                : 'border border-[var(--color-success)]/30 bg-[var(--color-success-container)]/40 text-[var(--color-text-primary)]'
          }`}
        >
          <span
            className={`material-symbols-outlined mt-0.5 text-[16px] ${
              skill.securityStatus === 'flagged'
                ? 'text-[var(--color-error)]'
                : risky
                  ? 'text-[var(--color-warning)]'
                  : 'text-[var(--color-success)]'
            }`}
            aria-hidden
          >
            {skill.securityStatus === 'flagged' ? 'gpp_maybe' : risky ? 'shield_question' : 'gpp_good'}
          </span>
          <span>{t(RISK_KEYS[skill.securityStatus])}</span>
        </div>

        <p className="text-[11px] leading-5 text-[var(--color-text-tertiary)]">{t('market.installConfirm.effectNote')}</p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={installing}
            onClick={onClose}
            className="inline-flex min-h-9 items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-50"
          >
            {t('market.installConfirm.cancel')}
          </button>
          <button
            type="button"
            data-testid="market-install-confirm-button"
            disabled={installing}
            onClick={onConfirm}
            className={`inline-flex min-h-9 items-center gap-1.5 rounded-xl px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${
              skill.securityStatus === 'flagged' ? 'bg-[var(--color-error)]' : 'bg-[var(--color-brand)]'
            }`}
          >
            {installing && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
            )}
            {installing ? t('market.install.installing') : t('market.installConfirm.confirm')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
