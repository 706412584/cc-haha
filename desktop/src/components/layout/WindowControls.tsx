import { useState, useEffect } from 'react'
import { getDesktopHost } from '../../lib/desktopHost'
import type { DesktopHost } from '../../lib/desktopHost'
import { useTranslation } from '../../i18n'

const isWindows = typeof navigator !== 'undefined' && /Win/.test(navigator.platform)

/** Whether to render custom window controls (Windows + desktop host only) */
export const showWindowControls = isWindows && getDesktopHost().capabilities.windowControls

/**
 * These stay hand-rolled buttons rather than `IconButton`: they are OS chrome,
 * so they must stay square, full-bleed to the titlebar edge and free of the
 * radius/padding every in-app control carries. The focus ring is inset for the
 * same reason — an offset ring would be clipped by the window edge.
 */
const WINDOW_CONTROL_CLASS =
  'w-[46px] h-full flex items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]'

export function WindowControls() {
  const t = useTranslation()
  const [maximized, setMaximized] = useState(false)
  const [win, setWin] = useState<DesktopHost['window'] | null>(null)

  useEffect(() => {
    if (!showWindowControls) return
    let unlisten: (() => void) | undefined
    let cancelled = false

    const w = getDesktopHost().window
    setWin(w)
    void w.isMaximized()
      .then((nextMaximized) => {
        if (!cancelled) setMaximized(nextMaximized)
      })
      .catch(() => {})
    void w.onResized(() => {
      void w.isMaximized()
        .then((nextMaximized) => {
          if (!cancelled) setMaximized(nextMaximized)
        })
        .catch(() => {})
    })
      .then((fn) => { unlisten = fn })
      .catch(() => {})

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const runWindowAction = (action: () => Promise<void>) => {
    void action().catch((error) => {
      console.error('Window control action failed', error)
    })
  }

  if (!showWindowControls || !win) return null

  return (
    <div data-testid="window-controls" className="flex items-stretch flex-shrink-0 -my-px">
      {/* Minimize */}
      <button
        onClick={() => runWindowAction(() => win.minimize())}
        aria-label={t('windowControls.minimize')}
        className={WINDOW_CONTROL_CLASS}
      >
        <svg width="10" height="1" viewBox="0 0 10 1">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>

      {/* Maximize / Restore */}
      <button
        onClick={() => runWindowAction(() => win.toggleMaximize())}
        aria-label={t(maximized ? 'windowControls.restore' : 'windowControls.maximize')}
        className={WINDOW_CONTROL_CLASS}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0" y="3" width="7" height="7" />
            <polyline points="3,3 3,0 10,0 10,7 7,7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>

      {/* Close */}
      <button
        onClick={() => runWindowAction(() => win.close())}
        aria-label={t('windowControls.close')}
        className={`${WINDOW_CONTROL_CLASS} hover:bg-[var(--color-window-close-hover)] hover:text-[var(--color-on-error)]`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
          <line x1="0" y1="0" x2="10" y2="10" />
          <line x1="10" y1="0" x2="0" y2="10" />
        </svg>
      </button>
    </div>
  )
}
