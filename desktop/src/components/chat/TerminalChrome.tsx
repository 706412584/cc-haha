import type { ReactNode } from 'react'

type Props = {
  title?: string
  children: ReactNode
  className?: string
}

/**
 * macOS-style terminal window decoration with traffic light buttons.
 * Reusable wrapper for Bash commands, tool results, and code viewers.
 */
export function TerminalChrome({ title, children, className = '' }: Props) {
  return (
    <div className={`overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-terminal-border)] bg-[var(--color-terminal-bg)] ${className}`}>
      {/* Title bar with traffic lights */}
      <div className="flex items-center gap-2.5 border-b border-[var(--color-terminal-border)] bg-[var(--color-terminal-header)] px-4 py-[11px]">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-[var(--radius-full)] bg-[var(--color-terminal-danger)]" />
          <div className="h-2.5 w-2.5 rounded-[var(--radius-full)] bg-[var(--color-terminal-warning)]" />
          <div className="h-2.5 w-2.5 rounded-[var(--radius-full)] bg-[var(--color-terminal-accent)]" />
        </div>
        {title && (
          <span className="ml-1.5 truncate font-mono text-[12.5px] font-medium text-[var(--color-terminal-muted)]">
            {title}
          </span>
        )}
      </div>
      {/* Content */}
      <div className="bg-[var(--color-terminal-bg)] text-[var(--color-terminal-fg)]">
        {children}
      </div>
    </div>
  )
}
