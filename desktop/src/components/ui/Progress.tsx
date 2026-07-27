import type { HTMLAttributes } from 'react'

import { cx } from '@/lib/cx'
import type { Tone } from './Badge'

export type ProgressProps = Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'children'> & {
  /** 0–100. Ignored when `indeterminate`. */
  value?: number
  /** For work with no known total. Uses the sliding-segment animation. */
  indeterminate?: boolean
  size?: 'xs' | 'sm' | 'md'
  /** `auto` turns green at 100%. */
  tone?: Tone | 'auto'
  /**
   * Required. Announced with the percentage, e.g. "Uploading attachments".
   * Only one of the existing progress bars had `role="progressbar"` at all.
   */
  label: string
  className?: string
}

const TRACK_HEIGHT = { xs: 'h-1', sm: 'h-1.5', md: 'h-2' } as const

const FILL_TONE: Record<Tone, string> = {
  neutral: 'bg-[var(--color-text-tertiary)]',
  brand: 'bg-[var(--color-brand)]',
  success: 'bg-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)]',
  danger: 'bg-[var(--color-error)]',
  info: 'bg-[var(--color-info)]',
}

/**
 * A determinate or indeterminate progress bar.
 *
 * The indeterminate variant uses `.progress-indeterminate-track` from
 * `globals.css`, which has existed — with a proper sliding segment and a
 * reduced-motion fallback — and had no callers; the one indeterminate bar in
 * the app faked it with `animate-pulse` instead.
 */
export function Progress({
  value = 0,
  indeterminate = false,
  size = 'sm',
  tone = 'brand',
  label,
  className,
  // Passed through so a caller can attach `data-testid` or an id. Without it a
  // test that selects the bar by test id forces the caller back to hand-rolled
  // markup — the same gap that blocked `Badge` adoption before it got this.
  ...props
}: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value))
  const resolvedTone: Tone = tone === 'auto' ? (clamped >= 100 ? 'success' : 'brand') : tone

  return (
    <div
      role="progressbar"
      aria-label={label}
      {...props}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      className={cx(
        'w-full overflow-hidden rounded-full bg-[var(--color-surface-container-high)]',
        TRACK_HEIGHT[size],
        indeterminate && 'progress-indeterminate-track',
        className,
      )}
    >
      {!indeterminate && (
        <div
          className={cx('h-full rounded-full transition-[width] duration-300', FILL_TONE[resolvedTone])}
          style={{ width: `${clamped}%` }}
        />
      )}
    </div>
  )
}
