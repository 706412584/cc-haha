import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { formatExactMessageTimestamp, formatMessageHoverTime } from '../../lib/formatMessageTimestamp'
import { formatDurationMs } from '../../lib/backgroundTasks'
import type { TurnCompletion } from '../../lib/turnCompletion'

type Props = {
  completion: TurnCompletion
}

/**
 * Closes out a finished turn under its last reply: when it ended and how long it
 * took. Unlike the hover-revealed per-message timestamp this one is always
 * visible — "how long did that take" is the question people ask after a long
 * turn, and a hover chip cannot answer it on a touch screen at all (#1151).
 */
export function TurnCompletionStamp({ completion }: Props) {
  const locale = useSettingsStore((state) => state.locale)
  const t = useTranslation()

  const clockLabel = formatMessageHoverTime(completion.completedAt, locale)
  if (!clockLabel) return null

  const duration = formatDurationMs(completion.durationMs, t)

  return (
    <div
      data-turn-completion
      className="mt-2 flex items-center gap-1.5 text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]"
    >
      <span title={formatExactMessageTimestamp(completion.completedAt, locale) || clockLabel}>
        {t('chat.turnCompletedAt', { time: clockLabel })}
      </span>
      {duration ? (
        <>
          <span aria-hidden="true">·</span>
          <span data-turn-completion-duration>{t('chat.turnDuration', { duration })}</span>
        </>
      ) : null}
    </div>
  )
}
