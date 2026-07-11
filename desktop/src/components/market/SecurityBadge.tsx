import { BadgeCheck, ShieldAlert, ShieldCheck, ShieldQuestion, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { SecurityStatus } from '../../types/market'

const STYLES: Record<SecurityStatus, { icon: LucideIcon; className: string }> = {
  verified: {
    icon: BadgeCheck,
    className: 'border-[var(--color-success)]/20 bg-[var(--color-success-container)] text-[var(--color-success)]',
  },
  benign: {
    icon: ShieldCheck,
    className: 'border-[var(--color-success)]/20 bg-[var(--color-success-container)] text-[var(--color-success)]',
  },
  unknown: {
    icon: ShieldQuestion,
    // text-secondary: tertiary lands at ~3.3-3.9:1 on this container across themes — below AA for 10px text.
    className: 'border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-text-secondary)]',
  },
  flagged: {
    icon: ShieldAlert,
    className: 'border-[var(--color-error)]/20 bg-[var(--color-error-container)] text-[var(--color-error)]',
  },
}

export function SecurityBadge({ status, className = '' }: { status: SecurityStatus; className?: string }) {
  const t = useTranslation()
  const style = STYLES[status]
  const Icon = style.icon
  return (
    <span
      data-testid={`security-badge-${status}`}
      title={t(`market.securityHint.${status}`)}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium ${style.className} ${className}`}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      {t(`market.security.${status}`)}
    </span>
  )
}
