import type { ReactNode } from 'react'

export function PanelMessage({
  icon,
  message,
  tone = 'muted',
  compact = false,
  announce = true,
  action,
}: {
  icon: string
  message: string
  tone?: 'muted' | 'error'
  compact?: boolean
  announce?: boolean
  /**
   * A way out of the state the message describes — "open in the system app" on a
   * file that cannot be previewed. Rendered beside, not inside, the live region:
   * a screen reader announces the message, not the button as part of it.
   */
  action?: ReactNode
}) {
  const toneClass =
    tone === 'error'
      ? 'text-[var(--color-error)]'
      : 'text-[var(--color-text-tertiary)]'

  const messageRow = (
    <div
      className={`flex items-center gap-2 px-4 ${compact ? (action ? 'pt-2 pb-1 text-[11px]' : 'py-2 text-[11px]') : (action ? 'pt-8 pb-3 text-xs' : 'py-8 text-xs')} ${toneClass}`}
      role={announce ? tone === 'error' ? 'alert' : 'status' : undefined}
    >
      <span className={`material-symbols-outlined shrink-0 text-[16px] ${icon === 'progress_activity' ? 'animate-spin' : ''}`}>
        {icon}
      </span>
      <span className="min-w-0 leading-relaxed">{message}</span>
    </div>
  )

  if (!action) return messageRow

  return (
    <div>
      {messageRow}
      {/* Indented to the message text: 16px padding + 16px icon + 8px gap. */}
      <div className={`flex flex-wrap items-center gap-2 pl-10 pr-4 ${compact ? 'pb-2' : 'pb-8'}`}>{action}</div>
    </div>
  )
}
