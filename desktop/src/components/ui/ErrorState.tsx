import type { ReactNode } from 'react'

import { cx } from '@/lib/cx'
import { Button } from './Button'
import type { StateSize } from './EmptyState'

export type ErrorStateProps = {
  title: string
  detail?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  size?: StateSize
  /**
   * `soft` for an inline notice inside otherwise working UI, `strong` when the
   * error is the only thing in the region. Two levels replace the 20 distinct
   * error backgrounds the app had accumulated (5 background alphas x 7 border
   * alphas x 8 container alphas).
   */
  tone?: 'soft' | 'strong'
  className?: string
}

const SIZE_CLASSES: Record<StateSize, string> = {
  sm: 'px-3 py-2 gap-1 text-xs',
  md: 'px-4 py-3 gap-1.5 text-sm',
  lg: 'px-5 py-6 gap-2 text-sm',
}

/**
 * The "this failed" panel.
 *
 * `role="alert"` is on the container so the failure is announced when it
 * appears — most of the replaced markup was a plain `<div>`, which a screen
 * reader user only discovers by chance.
 */
export function ErrorState({
  title,
  detail,
  onRetry,
  retryLabel,
  size = 'md',
  tone = 'soft',
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col rounded-[var(--radius-lg)] border',
        tone === 'soft'
          ? 'border-[var(--color-error-soft-hover)] bg-[var(--color-error-soft)]'
          : 'border-[var(--color-error)] bg-[var(--color-error-container)]',
        SIZE_CLASSES[size],
        className,
      )}
    >
      <span className="font-medium text-[var(--color-error)]">{title}</span>
      {detail && (
        <span className="text-xs leading-5 text-[var(--color-text-secondary)]">{detail}</span>
      )}
      {onRetry && retryLabel && (
        <Button size="sm" variant="danger-outline" onClick={onRetry} className="mt-1.5 self-start">
          {retryLabel}
        </Button>
      )}
    </div>
  )
}
