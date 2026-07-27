import { useState } from 'react'
import { ShieldAlert, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { IconButton } from '@/components/ui/IconButton'

const STORAGE_KEY = 'cc-haha-market-disclaimer-dismissed'

function readDismissed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Top-of-market disclaimer: skills come from third-party sources and are not
 * audited locally — users should review (ideally AI-scan) them before install.
 * Dismissal is persisted so it only shows until acknowledged.
 */
export function MarketDisclaimer() {
  const t = useTranslation()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (dismissed) return null

  return (
    <div
      role="note"
      data-testid="market-disclaimer"
      className="mt-6 flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)] px-[18px] py-3.5"
    >
      <ShieldAlert className="mt-0.5 h-[17px] w-[17px] flex-shrink-0 text-[var(--color-brand)]" strokeWidth={1.5} aria-hidden="true" />
      {/* Foreground is the darkened pair, never `--color-brand`: terracotta on
          its own soft fill measures 4.3:1 under the two ink themes. */}
      <p className="min-w-0 flex-1 text-[13px] leading-[1.7] text-[var(--color-on-brand-soft)] sm:text-sm">
        <span className="font-semibold">{t('market.disclaimer.title')}</span>{' '}
        {t('market.disclaimer.body')}
      </p>
      <IconButton
        icon={<X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
        label={t('market.disclaimer.dismiss')}
        tone="muted"
        className="-mr-1"
        onClick={() => {
          setDismissed(true)
          try {
            localStorage.setItem(STORAGE_KEY, '1')
          } catch {
            // Persisting is best-effort; the banner stays dismissed for this session.
          }
        }}
      />
    </div>
  )
}
