import { cx } from '@/lib/cx'

export type SpinnerProps = {
  /** Diameter in pixels. Defaults to 16, which lines up with `text-sm`. */
  size?: number
  /** `current` inherits the surrounding text color; `brand` uses the accent. */
  tone?: 'current' | 'brand'
  /**
   * Accessible name. Omit for spinners that sit next to their own visible
   * label (a loading button, a row that already says "Loading…") — announcing
   * both is noise. Pass one when the spinner is the only thing on screen.
   */
  label?: string
  className?: string
}

/**
 * The single loading indicator.
 *
 * Replaces two dialects that coexisted across ~17 sites: a `rounded-full
 * border-2 border-t-transparent` ring and this SVG. The SVG wins because it
 * stays circular at any size and does not depend on border rendering.
 *
 * Reduced motion is handled in `globals.css` (the animation slows rather than
 * stops) — a stopped spinner reads as a frozen UI, which is worse than the
 * motion it avoids. Callers do not get a prop for it.
 */
export function Spinner({ size = 16, tone = 'current', label, className }: SpinnerProps) {
  return (
    <svg
      className={cx('animate-spin shrink-0', tone === 'brand' && 'text-[var(--color-brand)]', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}
