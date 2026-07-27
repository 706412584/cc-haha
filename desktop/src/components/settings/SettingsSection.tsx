import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cx } from '@/lib/cx'

export type SettingsPageHeaderProps = {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned slot, normally the section's primary ink button. */
  action?: ReactNode
  className?: string
}

/**
 * The page-level header of a settings pane: serif title, secondary line, and an
 * optional primary action pinned right.
 *
 * Kept here rather than in `ui/` because the serif size and the 24px gap under
 * it are settings-suite decisions, not a generic heading primitive — the market
 * and schedule pages use a larger 26–28px title with different chrome.
 */
export function SettingsPageHeader({ title, description, action, className }: SettingsPageHeaderProps) {
  return (
    <div className={cx('mb-6 flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2
          className="text-[24px] font-semibold leading-tight text-[var(--color-text-primary)]"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          {title}
        </h2>
        {description ? (
          <p className="mt-1.5 text-[13.5px] leading-6 text-[var(--color-text-secondary)]">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  )
}

export type SettingsSectionProps = {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
  children?: ReactNode
}

/**
 * One labelled block inside a settings pane.
 *
 * Replaces the `<h2 class="text-base font-semibold"> + <p class="text-sm"> +
 * bare div` triple that was copy-pasted 19 times in `Settings.tsx` alone, each
 * copy free to drift in its own margin and text size.
 */
export function SettingsSection({ title, description, action, className, children }: SettingsSectionProps) {
  return (
    <section className={cx('mb-8', className)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            className="text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)]"
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-[13px] leading-5 text-[var(--color-text-tertiary)]">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

export type SettingsPillProps = {
  selected: boolean
  /**
   * Which selected look to wear.
   *
   * `ink` is the solid ink fill the handoff specifies for the theme and
   * language rows — a choice that takes effect immediately and applies to the
   * whole app. `terracotta` is the softer accent outline used where the pill
   * only pre-fills a form (provider presets), so it does not compete with the
   * modal's real primary button.
   */
  tone?: 'ink' | 'terracotta'
  onClick: () => void
  className?: string
  children: ReactNode
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'disabled'>

const PILL_SELECTED = {
  ink: 'bg-[var(--color-btn-primary-bg)] text-[var(--color-btn-primary-fg)] border-transparent shadow-[var(--shadow-button-primary)]',
  terracotta:
    'bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)] border-[var(--color-primary-fixed-dim)]',
} as const

/** A `rounded-full` single-choice chip. */
export function SettingsPill({
  selected,
  tone = 'ink',
  onClick,
  className,
  children,
  ...props
}: SettingsPillProps) {
  return (
    <button
      type="button"
      {...props}
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12.5px] font-medium',
        'transition-[background-color,color,border-color,box-shadow,transform] duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
        'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]',
        selected
          ? PILL_SELECTED[tone]
          : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)]',
        className,
      )}
    >
      {children}
    </button>
  )
}

export type SettingsStatProps = {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  className?: string
}

/** A stat tile: serif number over a small tertiary label. */
export function SettingsStat({ label, value, hint, className }: SettingsStatProps) {
  return (
    <div className={cx('min-w-0', className)}>
      <div
        className="text-[25px] font-semibold leading-none text-[var(--color-text-primary)]"
        style={{ fontFamily: 'var(--font-headline)' }}
      >
        {value}
      </div>
      <div className="mt-2 truncate text-[12px] text-[var(--color-text-tertiary)]">{label}</div>
      {hint ? <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-tertiary)]">{hint}</div> : null}
    </div>
  )
}
