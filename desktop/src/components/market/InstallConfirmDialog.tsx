import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { NormalizedSkill } from '../../types/market'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
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
  const RiskIcon =
    skill.securityStatus === 'flagged' ? ShieldAlert : risky ? ShieldQuestion : ShieldCheck

  return (
    <Modal open={open} onClose={installing ? () => {} : onClose} title={t('market.installConfirm.title')} width={480}>
      <div className="flex flex-col gap-4" data-testid="market-install-confirm">
        <p className="text-sm text-[var(--color-text-primary)]">
          {t('market.installConfirm.message', { name: skill.name, source: t(`market.source.${skill.source}`) })}
        </p>

        <div className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3.5 py-3 text-xs">
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
              …/skills/{skill.slug.toLowerCase()}/
            </span>
          </div>
        </div>

        {/* Tone pairs, not alpha: `--color-<tone>-container` with its own
            `--color-on-<tone>-container` foreground. The `/40` modifiers this
            carried compile to a color function Safari 15 WebViews drop. */}
        <div
          className={`flex items-start gap-2 rounded-[var(--radius-lg)] px-3.5 py-2.5 text-xs leading-5 ${
            skill.securityStatus === 'flagged'
              ? 'border border-[var(--color-error)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
              : risky
                ? 'border border-[var(--color-warning)] bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'
                : 'border border-[var(--color-success)] bg-[var(--color-success-container)] text-[var(--color-on-success-container)]'
          }`}
        >
          <RiskIcon className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.6} aria-hidden="true" />
          <span>{t(RISK_KEYS[skill.securityStatus])}</span>
        </div>

        <p className="text-[11px] leading-5 text-[var(--color-text-tertiary)]">{t('market.installConfirm.effectNote')}</p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" disabled={installing} onClick={onClose}>
            {t('market.installConfirm.cancel')}
          </Button>
          {/* `primary` is the app's brand CTA (a brand gradient rather than the
              flat brand fill this used); the flagged path keeps its solid red
              through `danger`, which is exactly what the old class produced. */}
          <Button
            variant={skill.securityStatus === 'flagged' ? 'danger' : 'primary'}
            data-testid="market-install-confirm-button"
            loading={installing}
            onClick={onConfirm}
          >
            {installing ? t('market.install.installing') : t('market.installConfirm.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
