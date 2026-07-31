import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TurnCompletionStamp } from './TurnCompletionStamp'
import { useSettingsStore } from '../../stores/settingsStore'
import { formatExactMessageTimestamp, formatMessageHoverTime } from '../../lib/formatMessageTimestamp'

const COMPLETED_AT = new Date('2026-07-30T07:20:41Z').getTime()

describe('TurnCompletionStamp', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('reads as an end time plus how long the turn took', () => {
    render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT, durationMs: 739_000 }} />)

    const stamp = screen.getByText(`Done ${formatMessageHoverTime(COMPLETED_AT, 'en')}`)
    expect(stamp).toBeTruthy()
    expect(screen.getByText('took 12m 19s')).toBeTruthy()
  })

  it('shows the end time alone when the duration is not trustworthy', () => {
    const { container } = render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT }} />)

    expect(screen.getByText(`Done ${formatMessageHoverTime(COMPLETED_AT, 'en')}`)).toBeTruthy()
    expect(container.querySelector('[data-turn-completion-duration]')).toBeNull()
  })

  it('carries the exact timestamp as a title for the rounded clock label', () => {
    render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT, durationMs: 1_000 }} />)

    expect(screen.getByText(`Done ${formatMessageHoverTime(COMPLETED_AT, 'en')}`).getAttribute('title')).toBe(
      formatExactMessageTimestamp(COMPLETED_AT, 'en'),
    )
  })

  it('follows the active locale', () => {
    useSettingsStore.setState({ locale: 'zh' })
    const { container } = render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT, durationMs: 739_000 }} />)

    expect(container.textContent).toContain('完成于')
    expect(container.textContent).toContain('耗时 12 分 19 秒')
  })

  it('renders nothing for an unusable timestamp', () => {
    const { container } = render(<TurnCompletionStamp completion={{ completedAt: Number.NaN }} />)

    expect(container.firstElementChild).toBeNull()
  })

  it('stays outside the hover-gated action bar styling', () => {
    // The whole point of the stamp is that it survives without a pointer.
    const { container } = render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT }} />)

    expect(container.firstElementChild?.className).not.toContain('opacity-0')
    expect(container.firstElementChild?.className).not.toContain('group-hover')
  })
})
