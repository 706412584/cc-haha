import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { UserMessage } from './UserMessage'
import { useSettingsStore } from '../../stores/settingsStore'

describe('UserMessage', () => {
  afterEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('keeps long URLs inside the message bubble', () => {
    const longUrl = `https://cn.bing.com/search?q=${'encoded'.repeat(60)}`

    const { container } = render(<UserMessage content={longUrl} />)

    const shell = container.querySelector('[data-message-shell="user"]')
    const bubble = screen.getByText(longUrl)

    expect(shell?.className).toContain('min-w-0')
    expect(bubble.className).toContain('min-w-0')
    expect(bubble.className).toContain('max-w-full')
    expect(bubble.className).toContain('whitespace-pre-wrap')
    expect(bubble.style.overflowWrap).toBe('anywhere')
    expect(bubble.style.wordBreak).toBe('break-word')
  })

  // The copy label was a hardcoded "Copy prompt" literal, so it stayed English
  // under every locale. English is also what `chat.copyPrompt` resolves to, so
  // only a non-English locale can tell the wiring from the old literal.
  it('translates the copy action label instead of hardcoding English', () => {
    useSettingsStore.setState({ locale: 'zh' })

    render(<UserMessage content="把这条复制走" />)

    expect(screen.getByRole('button', { name: '复制提示词' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull()
  })
})
