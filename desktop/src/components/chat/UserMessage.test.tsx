import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openPreviewLink = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../lib/openPreviewLink', () => ({ openPreviewLink }))

import { UserMessage } from './UserMessage'
import { useSettingsStore } from '../../stores/settingsStore'

function bubbleOf(container: HTMLElement): HTMLElement {
  const bubble = container.querySelector<HTMLElement>('[data-message-body="user"]')
  if (!bubble) throw new Error('user message bubble not found')
  return bubble
}

describe('UserMessage', () => {
  afterEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    openPreviewLink.mockClear().mockReturnValue(true)
  })

  it('keeps long URLs inside the message bubble', () => {
    const longUrl = `https://cn.bing.com/search?q=${'encoded'.repeat(60)}`

    const { container } = render(<UserMessage content={longUrl} />)

    const shell = container.querySelector('[data-message-shell="user"]')
    const bubble = bubbleOf(container)

    expect(shell?.className).toContain('min-w-0')
    expect(bubble.className).toContain('min-w-0')
    expect(bubble.className).toContain('max-w-full')
    expect(bubble.className).toContain('whitespace-pre-wrap')
    expect(bubble.style.overflowWrap).toBe('anywhere')
    expect(bubble.style.wordBreak).toBe('break-word')
    // The long text now lives in the anchor, so it has to wrap there too.
    expect(screen.getByRole('link', { name: longUrl }).className).toContain('[overflow-wrap:anywhere]')
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

// #1145. The prompt bubble rendered raw text, so a URL the user typed (or pasted
// back from an earlier reply) could never be clicked — the only clickable copy
// lived in the assistant's output card.
describe('UserMessage bare-URL linkify', () => {
  afterEach(() => {
    openPreviewLink.mockClear().mockReturnValue(true)
  })

  it('turns a bare URL into a link and leaves the prose as text', () => {
    const { container } = render(
      <UserMessage sessionId="s1" content={'把 http://localhost:3000 的样式改一下'} />,
    )

    const link = screen.getByRole('link', { name: 'http://localhost:3000' })
    expect(link.getAttribute('href')).toBe('http://localhost:3000')
    expect(bubbleOf(container).textContent).toBe('把 http://localhost:3000 的样式改一下')
  })

  it('stops the href at CJK punctuation', () => {
    render(<UserMessage sessionId="s1" content={'看看 http://localhost:5173，是不是白屏'} />)

    const link = screen.getByRole('link', { name: 'http://localhost:5173' })
    expect(link.getAttribute('href')).toBe('http://localhost:5173')
  })

  it('routes the click through the shared preview-link handler', () => {
    render(<UserMessage sessionId="s1" content={'打开 http://localhost:3000'} />)

    fireEvent.click(screen.getByRole('link', { name: 'http://localhost:3000' }))
    expect(openPreviewLink).toHaveBeenCalledWith('http://localhost:3000', 's1')
  })

  it('falls back to the anchor default when there is no session', () => {
    render(<UserMessage content={'打开 http://localhost:3000'} />)

    const link = screen.getByRole('link', { name: 'http://localhost:3000' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer noopener')

    fireEvent.click(link)
    expect(openPreviewLink).not.toHaveBeenCalled()
  })

  // Prompts are literal text: linkifying must not smuggle in markdown parsing.
  it('does not render markdown syntax in the prompt', () => {
    const content = '改一下 **bold** 和 `code`，还有 # 标题 与 [x](y)'
    const { container } = render(<UserMessage sessionId="s1" content={content} />)

    const bubble = bubbleOf(container)
    expect(bubble.textContent).toBe(content)
    expect(bubble.querySelector('strong')).toBeNull()
    expect(bubble.querySelector('code')).toBeNull()
    expect(bubble.querySelector('h1')).toBeNull()
    expect(bubble.querySelectorAll('a')).toHaveLength(0)
  })

  it('preserves line breaks around a linkified URL', () => {
    const content = '第一行\n打开 http://localhost:3000\n第三行'
    const { container } = render(<UserMessage sessionId="s1" content={content} />)

    expect(bubbleOf(container).textContent).toBe(content)
    expect(screen.getByRole('link', { name: 'http://localhost:3000' })).toBeTruthy()
  })

  it('renders no link when the prompt has no URL', () => {
    const { container } = render(<UserMessage sessionId="s1" content={'把样式改一下'} />)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })
})
