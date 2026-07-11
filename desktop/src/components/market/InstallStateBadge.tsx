import { CheckCircle2, CircleSlash2, Download, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { InstallState } from '../../types/market'

const STYLES: Record<InstallState, { icon: LucideIcon; className: string }> = {
  installed: {
    icon: CheckCircle2,
    className: 'border-[var(--color-success)]/20 bg-[var(--color-success-container)] text-[var(--color-success)]',
  },
  installable: {
    icon: Download,
    // brand-on-neutral keeps AA contrast in all three themes (brand-on-primary-fixed is 1.3:1 in dark).
    className: 'border-[var(--color-brand)]/20 bg-[var(--color-surface-container-low)] text-[var(--color-brand)]',
  },
  'not-installable': {
    icon: CircleSlash2,
    className: 'border-[var(--color-error)]/20 bg-[var(--color-error-container)] text-[var(--color-error)]',
  },
}

const LABEL_KEYS: Record<InstallState, 'market.install.state.installed' | 'market.install.state.installable' | 'market.install.state.notInstallable'> = {
  installed: 'market.install.state.installed',
  installable: 'market.install.state.installable',
  'not-installable': 'market.install.state.notInstallable',
}

export function InstallStateBadge({ state, className = '' }: { state: InstallState; className?: string }) {
  const t = useTranslation()
  const style = STYLES[state]
  const Icon = style.icon
  return (
    <span
      data-testid={`install-badge-${state}`}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium ${style.className} ${className}`}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      {t(LABEL_KEYS[state])}
    </span>
  )
}
