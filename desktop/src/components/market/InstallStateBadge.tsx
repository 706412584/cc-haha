import { CheckCircle2, CircleSlash2, Download, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge, type Tone } from '@/components/ui/Badge'
import type { InstallState } from '../../types/market'

/**
 * Only the status-to-tone map is left; the shell it used to carry was
 * character-identical to `SecurityBadge`'s.
 *
 * `installable` maps to `brand` rather than a neutral fill. This file
 * previously spelled out brand text on `--color-surface-container-low` because
 * brand-on-`--color-primary-fixed` measures 1.3:1 in the dark theme; the
 * library's `brand` tone pairs brand text with `--color-brand-soft`, which
 * `contrast.test.ts` holds at AA in all three themes.
 */
const TONES: Record<InstallState, Tone> = {
  installed: 'success',
  installable: 'brand',
  'not-installable': 'danger',
}

const ICONS: Record<InstallState, LucideIcon> = {
  installed: CheckCircle2,
  installable: Download,
  'not-installable': CircleSlash2,
}

const LABEL_KEYS: Record<InstallState, 'market.install.state.installed' | 'market.install.state.installable' | 'market.install.state.notInstallable'> = {
  installed: 'market.install.state.installed',
  installable: 'market.install.state.installable',
  'not-installable': 'market.install.state.notInstallable',
}

export function InstallStateBadge({ state, className = '' }: { state: InstallState; className?: string }) {
  const t = useTranslation()
  const Icon = ICONS[state]
  return (
    <Badge
      data-testid={`install-badge-${state}`}
      tone={TONES[state]}
      size="md"
      pill={false}
      bordered
      className={className}
      icon={<Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
    >
      {t(LABEL_KEYS[state])}
    </Badge>
  )
}
