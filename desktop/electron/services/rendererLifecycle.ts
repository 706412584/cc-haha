import type { BrowserWindow } from 'electron'

export const DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS = 10_000

export type RendererLifecycleOptions = {
  window: BrowserWindow
  isQuitting: () => boolean
  recordDiagnostic: (detail: string) => string
  writeSnapshot: (reason: string) => void
  onRendererProcessGone?: (detail: string) => void
  onRecoveryExhausted: (detail: string) => void
  unresponsiveRecoveryDelayMs?: number
}

export function installRendererLifecycle({
  window,
  isQuitting,
  recordDiagnostic,
  writeSnapshot,
  onRendererProcessGone,
  onRecoveryExhausted,
  unresponsiveRecoveryDelayMs = DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS,
}: RendererLifecycleOptions): void {
  let recoveryAttempted = false
  let failureReported = false
  let unresponsiveRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  let rendererReloadTimer: ReturnType<typeof setTimeout> | null = null

  const clearUnresponsiveRecovery = () => {
    if (!unresponsiveRecoveryTimer) return
    clearTimeout(unresponsiveRecoveryTimer)
    unresponsiveRecoveryTimer = null
  }
  const clearRendererReload = () => {
    if (!rendererReloadTimer) return
    clearTimeout(rendererReloadTimer)
    rendererReloadTimer = null
  }
  const reportRecoveryFailure = (detail: string) => {
    if (failureReported || isQuitting()) return
    failureReported = true
    onRecoveryExhausted(recordDiagnostic(`[recovery-exhausted] ${detail}`))
  }
  const recoverRenderer = (trigger: string) => {
    clearUnresponsiveRecovery()
    if (isQuitting() || window.isDestroyed() || window.webContents.isDestroyed()) {
      recordDiagnostic(`[recovery-skipped] trigger=${trigger} quitting=${isQuitting()}`)
      return
    }
    if (rendererReloadTimer) {
      recordDiagnostic(`[recovery-already-scheduled] trigger=${trigger}`)
      return
    }
    if (recoveryAttempted) {
      reportRecoveryFailure(`trigger=${trigger}`)
      return
    }

    recoveryAttempted = true
    recordDiagnostic(`[recovery-started] trigger=${trigger}`)
    rendererReloadTimer = setTimeout(() => {
      rendererReloadTimer = null
      if (isQuitting() || window.isDestroyed() || window.webContents.isDestroyed()) {
        recordDiagnostic(`[recovery-skipped] trigger=${trigger} quitting=${isQuitting()}`)
        return
      }
      try {
        window.webContents.reload()
      } catch (error) {
        reportRecoveryFailure(
          `trigger=${trigger} reloadError=${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }, 0)
  }

  window.webContents.on('did-finish-load', () => {
    clearUnresponsiveRecovery()
    if (recoveryAttempted) recordDiagnostic('[recovery-loaded]')
    writeSnapshot('did-finish-load')
  })
  window.webContents.on('did-fail-load', (
    _event,
    errorCode,
    errorDescription,
    validatedURL,
    isMainFrame,
  ) => {
    writeSnapshot(`did-fail-load:${errorCode}:${errorDescription}:${validatedURL}`)
    if (recoveryAttempted && isMainFrame && errorCode !== -3) {
      reportRecoveryFailure(`loadError=${errorCode}:${errorDescription}`)
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    clearUnresponsiveRecovery()
    const detail = recordDiagnostic(
      `[process-gone] reason=${details.reason} exitCode=${details.exitCode}`,
    )
    onRendererProcessGone?.(detail)
    writeSnapshot(`render-process-gone:${details.reason}:${details.exitCode}`)
    recoverRenderer(`process-gone:${details.reason}`)
  })
  window.webContents.on('unresponsive', () => {
    recordDiagnostic('[unresponsive]')
    writeSnapshot('unresponsive')
    if (unresponsiveRecoveryTimer) return
    unresponsiveRecoveryTimer = setTimeout(() => {
      unresponsiveRecoveryTimer = null
      recoverRenderer('unresponsive-timeout')
    }, unresponsiveRecoveryDelayMs)
  })
  window.webContents.on('responsive', () => {
    clearUnresponsiveRecovery()
    recordDiagnostic('[responsive]')
    writeSnapshot('responsive')
  })
  window.on('closed', () => {
    clearUnresponsiveRecovery()
    clearRendererReload()
  })
}
