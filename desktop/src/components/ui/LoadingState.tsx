import { cx } from '@/lib/cx'
import { Spinner } from './Spinner'
import type { StateSize } from './EmptyState'

export type LoadingStateProps = {
  /**
   * Required. Announced through `aria-live`, so it should say what is loading
   * ("Loading MCP servers"), not just "Loading".
   */
  label: string
  /** Hides the label visually while keeping it for screen readers. */
  labelHidden?: boolean
  size?: StateSize
  /**
   * `inline` sits in a row of text, `block` centers in the available space,
   * `dashed` adds the placeholder box so a loading panel occupies the same
   * footprint the loaded content will.
   */
  variant?: 'inline' | 'block' | 'dashed'
  className?: string
}

const SPINNER_PX: Record<StateSize, number> = { sm: 16, md: 20, lg: 28 }

const BLOCK_PADDING: Record<StateSize, string> = {
  sm: 'py-6 gap-2',
  md: 'py-12 gap-3',
  lg: 'min-h-[220px] gap-3',
}

/**
 * The "still loading" placeholder.
 *
 * Replaces 19 hand-rolled spinners-with-a-label, including two local components
 * both named `LoadingState` whose spinners differed in size (20px vs 28px) and
 * in whether they announced themselves at all.
 */
export function LoadingState({
  label,
  labelHidden = false,
  size = 'md',
  variant = 'block',
  className,
}: LoadingStateProps) {
  if (variant === 'inline') {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cx('inline-flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]', className)}
      >
        <Spinner size={SPINNER_PX[size]} tone="brand" />
        <span className={cx(labelHidden && 'sr-only')}>{label}</span>
      </span>
    )
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'flex flex-col items-center justify-center text-center',
        variant === 'dashed' && 'rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)]',
        BLOCK_PADDING[size],
        className,
      )}
    >
      <Spinner size={SPINNER_PX[size]} tone="brand" />
      <span className={cx('text-sm font-medium text-[var(--color-text-secondary)]', labelHidden && 'sr-only')}>
        {label}
      </span>
    </div>
  )
}
