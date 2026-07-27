import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { sessionsApiMock, runtimeMocks } = vi.hoisted(() => ({
  sessionsApiMock: {
    getInspection: vi.fn(),
  },
  runtimeMocks: {
    isMobileViewport: false,
    isDesktopRuntime: false,
  },
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => runtimeMocks.isMobileViewport,
}))

vi.mock('../../lib/desktopRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/desktopRuntime')>()
  return { ...actual, isDesktopRuntime: () => runtimeMocks.isDesktopRuntime }
})

vi.mock('../../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getInspection: sessionsApiMock.getInspection,
    },
  }
})

import { ContextUsageIndicator } from './ContextUsageIndicator'
import { useSettingsStore } from '../../stores/settingsStore'

const baseInspection = {
  active: true,
  status: {
    sessionId: 'session-1',
    workDir: '/workspace/project',
    cwd: '/workspace/project',
    permissionMode: 'bypassPermissions' as const,
    model: 'kimi-k2.6',
  },
  context: {
    categories: [{ name: 'Messages', tokens: 42_000, color: '#2D628F' }],
    totalTokens: 42_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 21,
    gridRows: [],
    model: 'kimi-k2.6',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ContextUsageIndicator request behavior', () => {
  const originalVisibility = document.visibilityState

  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibility,
    })
  })

  it('does not auto-fetch context while the document is hidden', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })

    render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledWith('session-1', {
      includeContext: true,
      contextOnly: true,
      timeout: 30_000,
    })
  })

  it('reuses the in-flight auto inspection during session-load rerenders', async () => {
    sessionsApiMock.getInspection.mockImplementation(() => new Promise(() => {}))

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)
  })

  it('starts a new auto inspection when the runtime identity changes', async () => {
    sessionsApiMock.getInspection.mockImplementation(() => new Promise(() => {}))

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
        runtimeSelectionKey="deepseek:deepseek-chat"
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale inspection response after the runtime identity changes', async () => {
    const first = deferred<typeof baseInspection>()
    sessionsApiMock.getInspection
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        ...baseInspection,
        context: { ...baseInspection.context, percentage: 21 },
      })

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
        runtimeSelectionKey="deepseek:deepseek-chat"
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByText('21%').length).toBeGreaterThan(0)
    })

    await act(async () => {
      first.resolve({
        ...baseInspection,
        context: { ...baseInspection.context, percentage: 90 },
      })
      await first.promise
    })

    expect(screen.getAllByText('21%').length).toBeGreaterThan(0)
    expect(screen.queryByText('90%')).not.toBeInTheDocument()
  })

  it('ignores a stale inspection response when identity changes while hidden', async () => {
    const first = deferred<typeof baseInspection>()
    sessionsApiMock.getInspection.mockReturnValueOnce(first.promise)

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
        runtimeSelectionKey="deepseek:deepseek-chat"
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={0}
        runtimeSelectionKey="deepseek:deepseek-reasoner"
      />,
    )

    await act(async () => {
      first.resolve({
        ...baseInspection,
        context: { ...baseInspection.context, percentage: 90 },
      })
      await first.promise
    })

    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('90%')).not.toBeInTheDocument()
  })

  it('forces a fresh inspection when refreshNonce bumps after a compaction (#743)', async () => {
    // First request hangs — simulates an auto refresh that started just
    // before the compact boundary and would resolve with pre-compact data.
    const first = deferred<typeof baseInspection>()
    sessionsApiMock.getInspection
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        ...baseInspection,
        context: { ...baseInspection.context, totalTokens: 9_000, percentage: 5 },
      })

    const { rerender } = render(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        refreshNonce={0}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

    rerender(
      <ContextUsageIndicator
        sessionId="session-1"
        chatState="idle"
        messageCount={1}
        refreshNonce={1}
      />,
    )

    // The forced refresh bypasses both the auto-refresh throttle and the
    // in-flight request reuse.
    await waitFor(() => {
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('5%')
    })
  })

  it('retries the forced refresh through a bounded retry window when compaction finishes into a busy CLI', async () => {
    vi.useFakeTimers()
    try {
      sessionsApiMock.getInspection
        .mockResolvedValueOnce(baseInspection)
        .mockRejectedValueOnce(new Error('Request timed out after 30s'))
        .mockRejectedValueOnce(new Error('Request timed out after 30s'))
        .mockResolvedValueOnce({
          ...baseInspection,
          context: { ...baseInspection.context, totalTokens: 9_000, percentage: 5 },
        })

      const { rerender } = render(
        <ContextUsageIndicator
          sessionId="session-1"
          chatState="idle"
          messageCount={1}
          refreshNonce={0}
        />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

      rerender(
        <ContextUsageIndicator
          sessionId="session-1"
          chatState="idle"
          messageCount={1}
          refreshNonce={1}
        />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(3)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
        await Promise.resolve()
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(4)
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('5%')
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces one recovery refresh after chat state returns to idle', async () => {
    vi.useFakeTimers()
    try {
      sessionsApiMock.getInspection
        .mockResolvedValueOnce(baseInspection)
        .mockResolvedValueOnce({
          ...baseInspection,
          context: { ...baseInspection.context, totalTokens: 9_000, percentage: 5 },
        })

      const { rerender } = render(
        <ContextUsageIndicator
          sessionId="session-1"
          chatState="compacting"
          messageCount={1}
          refreshNonce={0}
        />,
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(1)

      rerender(
        <ContextUsageIndicator
          sessionId="session-1"
          chatState="idle"
          messageCount={1}
          refreshNonce={0}
        />,
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000)
        await Promise.resolve()
      })
      expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('context-usage-indicator')).toHaveTextContent('5%')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ContextUsageIndicator touch target', () => {
  afterEach(() => {
    cleanup()
    runtimeMocks.isMobileViewport = false
    runtimeMocks.isDesktopRuntime = false
  })

  // `compact` is also true on the desktop composer, which narrows for the right
  // panel rather than for touch — so it cannot be the signal that grows this
  // trigger. On the phone shell it sits between two 44px buttons.
  it('keeps the desktop trigger at 32px even when the composer is compact', () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)

    render(<ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} compact />)

    const trigger = screen.getByTestId('context-usage-indicator')
    expect(trigger).toHaveClass('h-8')
    expect(trigger).not.toHaveClass('h-11')
  })

  it('grows the trigger to the 44px touch target on the browser H5 shell', () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)
    runtimeMocks.isMobileViewport = true

    render(<ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} compact />)

    const trigger = screen.getByTestId('context-usage-indicator')
    expect(trigger).toHaveClass('h-11')
    expect(trigger).not.toHaveClass('h-8')
  })

  it('leaves the desktop shell alone on a narrow Electron window', () => {
    sessionsApiMock.getInspection.mockResolvedValue(baseInspection)
    runtimeMocks.isMobileViewport = true
    runtimeMocks.isDesktopRuntime = true

    render(<ContextUsageIndicator sessionId="session-1" chatState="idle" messageCount={1} compact />)

    expect(screen.getByTestId('context-usage-indicator')).toHaveClass('h-8')
  })
})
