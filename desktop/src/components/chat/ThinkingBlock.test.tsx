import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ThinkingBlock, thinkingPreview } from './ThinkingBlock'
import { useSettingsStore } from '../../stores/settingsStore'

// Counting renders is the only honest way to assert a `memo` bailout without
// reaching into React internals, and the component's one observable per-render
// call is `useTranslation()`. Delegating to the real implementation keeps every
// other assertion in this file reading real translations.
const renderProbe = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n')>()
  return {
    ...actual,
    useTranslation: () => {
      renderProbe.count += 1
      return actual.useTranslation()
    },
  }
})

describe('thinkingPreview', () => {
  it('follows the tail while streaming so the row says what it is thinking now', () => {
    const content = 'Diagnosis complete:\nlint is clean\nnow checking the retry path'
    expect(thinkingPreview(content, { streaming: true })).toBe('now checking the retry path')
  })

  it('settles back onto the opening line once the block is done', () => {
    const content = 'The user ran the lifecycle suite and hit real failures.\nSo I will reset #7.'
    expect(thinkingPreview(content)).toBe('The user ran the lifecycle suite and hit real failures.')
  })

  it('skips an opening that is only a heading for what follows', () => {
    // `Diagnosis complete:` is the one line in the block that carries nothing.
    expect(thinkingPreview('Diagnosis complete:\nlint is clean, 2 files left')).toBe('lint is clean, 2 files left')
  })

  it('keeps a long opening that merely happens to end in a colon', () => {
    const content = 'The user wants me to handle GitHub issue #498 about the new KS signature, specifically:\n1. read the issue'
    expect(thinkingPreview(content)).toBe(
      'The user wants me to handle GitHub issue #498 about the new KS signature, specifically:',
    )
  })

  it('keeps a bare heading when it is all there is', () => {
    expect(thinkingPreview('Diagnosis complete:')).toBe('Diagnosis complete:')
  })
})

describe('ThinkingBlock', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'zh', thinkingAutoCollapse: true })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState({ locale: 'zh', thinkingAutoCollapse: true })
  })

  it('shows the in-progress label while thinking is active', () => {
    render(<ThinkingBlock content="reasoning..." isActive />)
    expect(screen.getByRole('button')).toHaveTextContent('思考中')
    expect(screen.getByRole('button')).not.toHaveTextContent('已思考')
  })

  it('shows the done label once thinking has completed', () => {
    render(<ThinkingBlock content="reasoning..." isActive={false} />)
    expect(screen.getByRole('button')).toHaveTextContent('已思考')
    expect(screen.getByRole('button')).not.toHaveTextContent('思考中')
  })

  it('defaults to the done label when isActive is omitted', () => {
    render(<ThinkingBlock content="reasoning..." />)
    expect(screen.getByRole('button')).toHaveTextContent('已思考')
  })

  it('localizes both labels in English', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { rerender } = render(<ThinkingBlock content="reasoning..." isActive />)
    expect(screen.getByRole('button')).toHaveTextContent('Thinking')
    rerender(<ThinkingBlock content="reasoning..." isActive={false} />)
    expect(screen.getByRole('button')).toHaveTextContent('Thought')
  })

  it('does not parse markdown on every delta while streaming', () => {
    // A full `marked.parse` of the whole accumulated text per delta is the cost
    // this branch exists to remove, so the markdown constructs must stay literal
    // in the DOM until the stream ends.
    const content = '# Heading\n\n**bold** and `code`\n\n- item one'
    const { container } = render(<ThinkingBlock content={content} isActive />)

    expect(container.querySelector('[data-thinking-content="expanded"]')).not.toBeNull()
    expect(container.querySelector('h1')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('li')).toBeNull()
    // The raw text is still on screen — plain, not parsed.
    expect(container.textContent).toContain('**bold** and `code`')
    // The streaming cursor rides along in the plain-text branch.
    expect(container.querySelector('.thinking-cursor')).not.toBeNull()
  })

  it('swaps to real markdown once the stream ends', () => {
    // Auto-collapse off, so the settled block stays open and the swap to the
    // Markdown branch is observable without a click.
    useSettingsStore.setState({ thinkingAutoCollapse: false })
    const content = '# Heading\n\n**bold** and `code`\n\n- item one'
    const { container, rerender } = render(<ThinkingBlock content={content} isActive />)
    expect(container.querySelector('strong')).toBeNull()

    rerender(<ThinkingBlock content={content} isActive={false} />)

    expect(container.querySelector('h1')?.textContent).toBe('Heading')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('li')?.textContent).toBe('item one')
    expect(container.querySelector('.thinking-cursor')).toBeNull()
    expect(container.querySelector('.thinking-stream')).toBeNull()
  })

  it('coalesces the scroll-to-bottom into one animation frame per delta burst', () => {
    // `scrollHeight` forces a synchronous layout, so the effect must not touch
    // the DOM during render/commit. Deferring it also collapses a burst of
    // deltas into a single scroll instead of one per delta.
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const { container, rerender } = render(<ThinkingBlock content="first" isActive />)
    const body = container.querySelector<HTMLElement>('[data-thinking-content="expanded"]')!
    const scrollTop = vi.fn()
    Object.defineProperty(body, 'scrollTop', { set: scrollTop, configurable: true })
    Object.defineProperty(body, 'scrollHeight', { get: () => 4000, configurable: true })

    for (const content of ['first and second', 'first and second and third']) {
      rerender(<ThinkingBlock content={content} isActive />)
    }

    // Three renders, three scheduled frames, and not one synchronous write.
    expect(raf).toHaveBeenCalledTimes(3)
    expect(scrollTop).not.toHaveBeenCalled()

    act(() => {
      for (const frame of frames) frame(0)
    })

    expect(scrollTop).toHaveBeenCalledTimes(3)
    expect(scrollTop).toHaveBeenLastCalledWith(4000)

    raf.mockRestore()
    cancel.mockRestore()
  })

  it('scrolls to the final delta when the stream ends', () => {
    // Ending the stream re-runs the scroll effect, and its cleanup cancels the
    // frame the last delta scheduled. If nothing replaces it the block settles
    // one delta short of the bottom — the frame that would have shown the final
    // text never lands. Cancelling has to actually drop the frame here: a no-op
    // stub would let the test run a frame the browser would have discarded.
    //
    // Auto-collapse would unmount the body at the settle transition, leaving
    // nothing to scroll; the case that matters is a block that stays open.
    useSettingsStore.setState({ locale: 'zh', thinkingAutoCollapse: false })
    const live = new Map<number, FrameRequestCallback>()
    let nextFrameId = 0
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrameId += 1
      live.set(nextFrameId, callback)
      return nextFrameId
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      live.delete(id)
    })

    const { container, rerender } = render(<ThinkingBlock content="streaming" isActive />)
    const body = container.querySelector<HTMLElement>('[data-thinking-content="expanded"]')!
    const scrollTop = vi.fn()
    Object.defineProperty(body, 'scrollTop', { set: scrollTop, configurable: true })
    Object.defineProperty(body, 'scrollHeight', { get: () => 4000, configurable: true })

    rerender(<ThinkingBlock content="streaming done" isActive={false} />)

    // Only frames the browser would still run are left.
    expect(cancel).toHaveBeenCalled()
    expect(live.size).toBe(1)
    act(() => {
      for (const frame of [...live.values()]) frame(0)
    })
    expect(scrollTop).toHaveBeenCalledWith(4000)

    raf.mockRestore()
    cancel.mockRestore()
  })

  it('leaves a finished block alone when it is expanded later', () => {
    // The settle frame must not turn into "scroll on every render of a settled
    // block": expanding an old block by hand should show its beginning, not
    // jump to the end.
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })

    // Auto-collapse would hide the body entirely, so keep the block open to
    // give the effect a chance to scroll it.
    useSettingsStore.setState({ locale: 'zh', thinkingAutoCollapse: false })
    const { container, rerender } = render(<ThinkingBlock content="settled" isActive={false} />)
    const body = container.querySelector<HTMLElement>('[data-thinking-content="expanded"]')!
    const scrollTop = vi.fn()
    Object.defineProperty(body, 'scrollTop', { set: scrollTop, configurable: true })
    Object.defineProperty(body, 'scrollHeight', { get: () => 4000, configurable: true })
    const framesBefore = frames.length

    // Re-rendering a block that was already inactive schedules nothing.
    rerender(<ThinkingBlock content="settled" isActive={false} />)
    expect(frames.length).toBe(framesBefore)
    expect(scrollTop).not.toHaveBeenCalled()

    raf.mockRestore()
  })

  it('does not re-render the block when its props are unchanged', () => {
    // The chat tree re-renders on every streamed delta; without `memo` this
    // block re-parsed nothing but still ran its render path each time.
    renderProbe.count = 0
    const { rerender } = render(<ThinkingBlock content="stable reasoning" isActive />)
    const afterMount = renderProbe.count

    rerender(<ThinkingBlock content="stable reasoning" isActive />)
    rerender(<ThinkingBlock content="stable reasoning" isActive />)

    expect(afterMount).toBeGreaterThan(0)
    expect(renderProbe.count).toBe(afterMount)
  })

  it('still re-renders when the streamed content changes', () => {
    // Guards the memo test above: a memo that never updates would pass it.
    renderProbe.count = 0
    const { rerender } = render(<ThinkingBlock content="first" isActive />)
    const afterMount = renderProbe.count

    rerender(<ThinkingBlock content="first and second" isActive />)

    expect(renderProbe.count).toBeGreaterThan(afterMount)
  })
})
