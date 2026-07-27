import { BadgeCheck, ShieldAlert, ShieldCheck, ShieldQuestion, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge, type Tone } from '@/components/ui/Badge'
import type { SecurityStatus } from '../../types/market'

/**
 * Only the status-to-tone map is left; the shell it used to carry was
 * character-identical to `InstallStateBadge`'s.
 *
 * `unknown` maps to `neutral`, whose fill is `--color-surface-container` with
 * `--color-text-secondary` on it — the pairing this file previously spelled out
 * by hand after finding tertiary lands at ~3.3-3.9:1 there, under AA for small
 * text. `verified`/`benign` now take their foreground from
 * `--color-on-success-container` rather than the success accent, which is the
 * pairing `contrast.test.ts` checks.
 */
const TONES: Record<SecurityStatus, Tone> = {
  verified: 'success',
  benign: 'success',
  unknown: 'neutral',
  flagged: 'danger',
}

const ICONS: Record<SecurityStatus, LucideIcon> = {
  verified: BadgeCheck,
  benign: ShieldCheck,
  unknown: ShieldQuestion,
  flagged: ShieldAlert,
}

export function SecurityBadge({ status, className = '' }: { status: SecurityStatus; className?: string }) {
  const t = useTranslation()
  const Icon = ICONS[status]
  return (
    <Badge
      data-testid={`security-badge-${status}`}
      title={t(`market.securityHint.${status}`)}
      tone={TONES[status]}
      size="md"
      pill={false}
      bordered
      className={className}
      icon={<Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
    >
      {t(`market.security.${status}`)}
    </Badge>
  )
}
