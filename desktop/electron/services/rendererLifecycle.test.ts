import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS,
  installRendererLifecycle,
} from './rendererLifecycle'

class FakeWebContents extends EventEmitter {
  destroyed = false
  reload = vi.fn()

  isDestroyed() {
    return this.destroyed
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  webContents = new FakeWebContents()

  isDestroyed() {
    return this.destroyed
  }
}

function createHarness(options: { quitting?: boolean } = {}) {
  const window = new FakeWindow()
  let quitting = options.quitting ?? false
  const recordDiagnostic = vi.fn((detail: string) => `sanitized:${detail}`)
  const writeSnapshot = vi.fn()
  const onRendererProcessGone = vi.fn()
  const onRecoveryExhausted = vi.fn()

  installRendererLifecycle({
    window: window as never,
    isQuitting: () => quitting,
    recordDiagnostic,
    writeSnapshot,
    onRendererProcessGone,
    onRecoveryExhausted,
  })

  return {
    window,
    recordDiagnostic,
    writeSnapshot,
    onRendererProcessGone,
    onRecoveryExhausted,
    setQuitting(value: boolean) {
      quitting = value
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Electron renderer lifecycle recovery', () => {
  it('reloads after the first renderer exit and reports repeated failure only once', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const details = { reason: 'crashed', exitCode: 139 }

    harness.window.webContents.emit('render-process-gone', {}, details)

    expect(harness.window.webContents.reload).not.toHaveBeenCalled()
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      '[process-gone] reason=crashed exitCode=139',
    )
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      '[recovery-started] trigger=process-gone:crashed',
    )
    expect(harness.writeSnapshot).toHaveBeenCalledWith('render-process-gone:crashed:139')
    expect(harness.onRendererProcessGone).toHaveBeenCalledWith(
      'sanitized:[process-gone] reason=crashed exitCode=139',
    )

    harness.window.webContents.emit('render-process-gone', {}, details)
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      '[recovery-already-scheduled] trigger=process-gone:crashed',
    )
    expect(harness.onRecoveryExhausted).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    vi.runOnlyPendingTimers()
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)

    harness.window.webContents.emit('render-process-gone', {}, details)
    harness.window.webContents.emit('render-process-gone', {}, details)

    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledWith(
      'sanitized:[recovery-exhausted] trigger=process-gone:crashed',
    )
  })

  it('reloads only after unresponsiveness persists for the full delay', () => {
    vi.useFakeTimers()
    const harness = createHarness()

    harness.window.webContents.emit('unresponsive')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS / 2)
    harness.window.webContents.emit('unresponsive')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS / 2 - 1)
    expect(harness.window.webContents.reload).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(harness.window.webContents.reload).not.toHaveBeenCalled()
    vi.runOnlyPendingTimers()
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      '[recovery-started] trigger=unresponsive-timeout',
    )
  })

  it('cancels pending recovery when the renderer becomes responsive or the window closes', () => {
    vi.useFakeTimers()
    const harness = createHarness()

    harness.window.webContents.emit('unresponsive')
    harness.window.webContents.emit('responsive')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS)
    expect(harness.window.webContents.reload).not.toHaveBeenCalled()
    expect(harness.writeSnapshot).toHaveBeenCalledWith('responsive')

    harness.window.webContents.emit('unresponsive')
    harness.window.emit('closed')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS)
    expect(harness.window.webContents.reload).not.toHaveBeenCalled()
  })

  it('does not reload a destroyed window or web contents, or while the app is quitting', () => {
    vi.useFakeTimers()
    const destroyedWindowHarness = createHarness()
    destroyedWindowHarness.window.destroyed = true
    destroyedWindowHarness.window.webContents.emit('unresponsive')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS)
    expect(destroyedWindowHarness.window.webContents.reload).not.toHaveBeenCalled()

    const destroyedContentsHarness = createHarness()
    destroyedContentsHarness.window.webContents.destroyed = true
    destroyedContentsHarness.window.webContents.emit('render-process-gone', {}, {
      reason: 'crashed',
      exitCode: 1,
    })
    expect(destroyedContentsHarness.window.webContents.reload).not.toHaveBeenCalled()

    const quittingHarness = createHarness({ quitting: true })
    quittingHarness.window.webContents.emit('render-process-gone', {}, {
      reason: 'clean-exit',
      exitCode: 0,
    })
    expect(quittingHarness.window.webContents.reload).not.toHaveBeenCalled()
    expect(quittingHarness.onRecoveryExhausted).not.toHaveBeenCalled()
  })

  it('rechecks destruction and quitting before a deferred reload and cancels it on close', () => {
    vi.useFakeTimers()
    const details = { reason: 'crashed', exitCode: 1 }

    const destroyedWindowHarness = createHarness()
    destroyedWindowHarness.window.webContents.emit('render-process-gone', {}, details)
    destroyedWindowHarness.window.destroyed = true
    vi.runOnlyPendingTimers()
    expect(destroyedWindowHarness.window.webContents.reload).not.toHaveBeenCalled()
    expect(destroyedWindowHarness.recordDiagnostic).toHaveBeenCalledWith(
      '[recovery-skipped] trigger=process-gone:crashed quitting=false',
    )

    const destroyedContentsHarness = createHarness()
    destroyedContentsHarness.window.webContents.emit('render-process-gone', {}, details)
    destroyedContentsHarness.window.webContents.destroyed = true
    vi.runOnlyPendingTimers()
    expect(destroyedContentsHarness.window.webContents.reload).not.toHaveBeenCalled()

    const quittingHarness = createHarness()
    quittingHarness.window.webContents.emit('render-process-gone', {}, details)
    quittingHarness.setQuitting(true)
    vi.runOnlyPendingTimers()
    expect(quittingHarness.window.webContents.reload).not.toHaveBeenCalled()

    const closedHarness = createHarness()
    closedHarness.window.webContents.emit('render-process-gone', {}, details)
    expect(vi.getTimerCount()).toBe(1)
    closedHarness.window.emit('closed')
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(closedHarness.window.webContents.reload).not.toHaveBeenCalled()
  })

  it('reports reload and recovered main-frame load failures once while ignoring aborts', () => {
    vi.useFakeTimers()
    const reloadErrorHarness = createHarness()
    reloadErrorHarness.window.webContents.reload.mockImplementation(() => {
      throw new Error('reload failed')
    })
    reloadErrorHarness.window.webContents.emit('render-process-gone', {}, {
      reason: 'crashed',
      exitCode: 1,
    })
    vi.runOnlyPendingTimers()
    expect(reloadErrorHarness.onRecoveryExhausted).toHaveBeenCalledWith(
      'sanitized:[recovery-exhausted] trigger=process-gone:crashed reloadError=reload failed',
    )

    const loadFailureHarness = createHarness()
    loadFailureHarness.window.webContents.emit('render-process-gone', {}, {
      reason: 'crashed',
      exitCode: 1,
    })
    vi.runOnlyPendingTimers()
    loadFailureHarness.window.webContents.emit(
      'did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///app/index.html', true,
    )
    expect(loadFailureHarness.onRecoveryExhausted).not.toHaveBeenCalled()

    loadFailureHarness.window.webContents.emit(
      'did-fail-load', {}, -2, 'ERR_FAILED', 'file:///app/index.html', false,
    )
    expect(loadFailureHarness.onRecoveryExhausted).not.toHaveBeenCalled()

    loadFailureHarness.window.webContents.emit(
      'did-fail-load', {}, -2, 'ERR_FAILED', 'file:///app/index.html', true,
    )
    loadFailureHarness.window.webContents.emit(
      'did-fail-load', {}, -2, 'ERR_FAILED', 'file:///app/index.html', true,
    )
    expect(loadFailureHarness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
  })
})
