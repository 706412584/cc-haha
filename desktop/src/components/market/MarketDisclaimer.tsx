import { useState } from 'react'
import { ShieldAlert, X } from 'lucide-react'
import { useTranslation } from '../../i18n'

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
      className="flex items-start gap-3 rounded-lg border border-[var(--color-warning)]/20 border-l-2 bg-[var(--color-surface-container-low)] px-3.5 py-2.5"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--color-warning)]" strokeWidth={2} aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[11px] leading-[18px] text-[var(--color-text-secondary)] sm:text-xs sm:leading-5">
        <span className="font-semibold text-[var(--color-text-primary)]">{t('market.disclaimer.title')}</span>{' '}
        {t('market.disclaimer.body')}
      </p>
      <button
        type="button"
        aria-label={t('market.disclaimer.dismiss')}
        onClick={() => {
          setDismissed(true)
          try {
            localStorage.setItem(STORAGE_KEY, '1')
          } catch {
            // Persisting is best-effort; the banner stays dismissed for this session.
          }
        }}
        className="-mr-1 inline-flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:scale-[0.98]"
      >
        <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  )
}
