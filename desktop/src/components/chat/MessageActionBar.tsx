import { Check, Copy, GitFork } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { formatExactMessageTimestamp, formatMessageHoverTime } from '../../lib/formatMessageTimestamp'
import { CopyButton } from '@/components/ui/CopyButton'
import { IconButton } from '@/components/ui/IconButton'

export type MessageBranchAction = {
  label: string
  loading?: boolean
  onBranch: () => void
}

/**
 * The copy chip and the branch chip sit side by side and must look identical.
 * The branch one is an `IconButton size="sm" tone="muted" shape="circle"`;
 * `CopyButton` is styled by className, so its shell is mirrored here.
 */
const ACTION_CHIP_CLASS = [
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
  'text-[var(--color-text-tertiary)] transition-colors duration-150 cursor-pointer',
  'hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
].join(' ')

type Props = {
  copyText?: string
  copyLabel: string
  branchAction?: MessageBranchAction
  align?: 'start' | 'end'
  timestamp?: number
}

export function MessageActionBar({
  copyText,
  copyLabel,
  branchAction,
  align = 'start',
  timestamp,
}: Props) {
  const locale = useSettingsStore((state) => state.locale)
  const hasCopy = Boolean(copyText?.trim())
  const hoverTimeLabel = typeof timestamp === 'number'
    ? formatMessageHoverTime(timestamp, locale)
    : ''
  const exactTimeLabel = typeof timestamp === 'number'
    ? formatExactMessageTimestamp(timestamp, locale)
    : ''

  if (!hasCopy && !branchAction) return null

  return (
    <div
      data-message-actions
      data-align={align}
      className={`pointer-events-none mt-2 flex h-7 w-full opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 ${
        align === 'end' ? 'justify-end' : 'justify-start'
      }`}
    >
      <div className="flex min-h-7 items-center gap-1.5">
        {hasCopy ? (
          <CopyButton
            text={copyText!}
            label={copyLabel}
            displayLabel={<Copy size={13} strokeWidth={2.2} aria-hidden="true" />}
            displayCopiedLabel={<Check size={13} strokeWidth={2.4} aria-hidden="true" />}
            onPointerUp={(event) => event.currentTarget.blur()}
            className={ACTION_CHIP_CLASS}
          />
        ) : null}
        {branchAction ? (
          <IconButton
            icon={<GitFork size={13} strokeWidth={2.2} aria-hidden="true" />}
            label={branchAction.label}
            size="sm"
            tone="muted"
            shape="circle"
            disabled={branchAction.loading}
            onClick={branchAction.onBranch}
            onPointerUp={(event) => event.currentTarget.blur()}
          />
        ) : null}
        {hoverTimeLabel ? (
          <span
            className="ml-1 inline-flex items-center text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]"
            title={exactTimeLabel || hoverTimeLabel}
          >
            {hoverTimeLabel}
          </span>
        ) : null}
      </div>
    </div>
  )
}
