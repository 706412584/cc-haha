import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { Camera, Minus, MousePointer2, Plus, RotateCcw } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import { useTranslation } from '../../i18n'
import { BrowserAddressBar } from './BrowserAddressBar'
import { computeWebviewBounds } from './computeWebviewBounds'
import { getServerBaseUrl, isLoopbackHostname } from '../../lib/desktopRuntime'
import { classifyPreviewLink } from '../../lib/previewLinkRouter'
import { isAbsoluteLocalPath, localFileUrl, previewFsUrl } from '../../lib/handlePreviewLink'
import { previewBridge } from '../../lib/previewBridge'
import { subscribePreviewEvents } from '../../lib/previewEvents'
import {
  BROWSER_ZOOM_STEP,
  DEFAULT_BROWSER_ZOOM,
  MAX_BROWSER_ZOOM,
  MIN_BROWSER_ZOOM,
  normalizeBrowserZoom,
  useBrowserPanelStore,
} from '../../stores/browserPanelStore'
import { useOverlayStore } from '../../stores/overlayStore'
import { useSettingsStore } from '../../stores/settingsStore'

const LOCAL_PREVIEW_PATH_PREFIXES = ['/preview-fs/', '/local-file/']
const LOCAL_PREVIEW_READY_TIMEOUT_MS = 2500

function shouldWaitForLocalPreview(url: string): boolean {
  try {
    const parsed = new URL(url)
    return isLoopbackHostname(parsed.hostname) &&
      LOCAL_PREVIEW_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))
  } catch {
    return false
  }
}

async function waitForLocalPreview(url: string): Promise<void> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), LOCAL_PREVIEW_READY_TIMEOUT_MS)
  try {
    await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch {
    // Best-effort warmup only. The native webview still navigates so users can
    // see the server's own error page or use Reload if the first probe raced.
  } finally {
    window.clearTimeout(timeout)
  }
}

function resolveBrowserNavigationUrl(input: string, sessionId: string): string {
  const value = input.trim()
  if (!value) return ''

  const classified = classifyPreviewLink(value)
  if (classified.kind === 'browser-file' && classified.path) {
    const serverBaseUrl = getServerBaseUrl()
    return isAbsoluteLocalPath(classified.path)
      ? localFileUrl(serverBaseUrl, classified.path)
      : previewFsUrl(serverBaseUrl, sessionId, classified.path)
  }

  return value
}

export function BrowserSurface({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const loadSeqRef = useRef(0)
  const requestedUrlRef = useRef<string | null>(null)
  const hasNativePreviewRef = useRef(false)
  const session = useBrowserPanelStore((s) => s.bySession[sessionId])
  const appZoom = useSettingsStore((s) => s.uiZoom)
  const store = useBrowserPanelStore.getState()
  const overlayCount = useOverlayStore((s) => s.count)
  const previewZoom = session?.zoom ?? DEFAULT_BROWSER_ZOOM
  const zoomPercent = Math.round(previewZoom * 100)
  const canZoomOut = previewZoom > MIN_BROWSER_ZOOM
  const canZoomIn = previewZoom < MAX_BROWSER_ZOOM

  const reportBounds = useCallback(() => {
    const el = hostRef.current
    if (!el) return
    previewBridge.setBounds(computeWebviewBounds(el.getBoundingClientRect(), appZoom))
  }, [appZoom])

  const loadNativePreview = (
    url: string,
    action: () => Promise<void>,
  ) => {
    const seq = loadSeqRef.current + 1
    loadSeqRef.current = seq
    void (async () => {
      if (shouldWaitForLocalPreview(url)) {
        await waitForLocalPreview(url)
      }
      if (loadSeqRef.current !== seq) return
      await action()
    })().catch(() => {
      if (loadSeqRef.current === seq) {
        if (requestedUrlRef.current === url) {
          requestedUrlRef.current = null
        }
        useBrowserPanelStore.getState().setLoading(sessionId, false)
      }
    })
  }

  const requestNativePreview = (url: string, options?: { force?: boolean }) => {
    if (!url) return
    if (!options?.force && requestedUrlRef.current === url) return

    requestedUrlRef.current = url
    loadNativePreview(url, async () => {
      await previewBridge.setZoom(previewZoom)
      if (hasNativePreviewRef.current) {
        await previewBridge.navigate(url)
        return
      }

      const el = hostRef.current
      hasNativePreviewRef.current = true
      if (el) {
        await previewBridge.open(url, computeWebviewBounds(el.getBoundingClientRect(), appZoom))
      } else {
        await previewBridge.navigate(url)
      }
    })
  }

  useLayoutEffect(() => {
    if (session?.url) {
      requestNativePreview(session.url)
    }
    return () => {
      loadSeqRef.current += 1
      requestedUrlRef.current = null
      hasNativePreviewRef.current = false
      previewBridge.close()
    }
    // The visibility-sync effect below owns setVisible() — including the
    // initial reveal — so it always factors in overlayCount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (!session?.url || !session.loading) return
    requestNativePreview(session.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.url, session?.loading, sessionId])

  // Visibility-sync: a fullscreen DOM overlay (e.g. ImageGalleryModal) would
  // otherwise be partially covered by the native child webview, which always
  // renders above the DOM. While overlayCount > 0 we hide the webview; when
  // it returns to 0 (and we're still mounted in browser mode) we re-show it.
  // The layout-effect teardown above still closes the webview on unmount.
  useEffect(() => {
    if (!session) return
    previewBridge.setVisible(overlayCount === 0)
  }, [overlayCount, session])

  useEffect(() => {
    if (!session) return
    void previewBridge.setZoom(previewZoom)
  }, [previewZoom, session])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => reportBounds())
    ro.observe(el)
    window.addEventListener('resize', reportBounds)
    return () => { ro.disconnect(); window.removeEventListener('resize', reportBounds) }
  }, [reportBounds, sessionId])

  useLayoutEffect(() => {
    reportBounds()
  }, [reportBounds, sessionId])

  useEffect(() => {
    let unsub: (() => void) | undefined
    void subscribePreviewEvents(sessionId).then((u) => { unsub = u })
    return () => { unsub?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 兜底：navigated/ready 依赖注入脚本，若外站 CSP 拦截则永不回灌。loading 变 true 后 ~15s 强制收尾。
  const isLoading = session?.loading ?? false
  const currentUrl = session?.url
  useEffect(() => {
    if (!isLoading) return
    const timer = window.setTimeout(() => {
      useBrowserPanelStore.getState().setLoading(sessionId, false)
    }, 15000)
    return () => window.clearTimeout(timer)
  }, [isLoading, currentUrl, sessionId])

  if (!session) return null

  const openOrNavigate = (inputUrl: string) => {
    const url = resolveBrowserNavigationUrl(inputUrl, sessionId)
    if (!url) return
    store.navigate(sessionId, url)
    requestNativePreview(url)
  }

  const setPreviewZoom = (nextZoom: number) => {
    store.setZoom(sessionId, normalizeBrowserZoom(nextZoom))
  }

  const zoomControls = (
    <div
      data-testid="browser-zoom-controls"
      role="group"
      aria-label={t('browser.zoomControls')}
      className="inline-flex h-10 shrink-0 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 shadow-[var(--shadow-overlay)]"
    >
      <IconButton
        icon={<Minus size={14} />}
        label={t('browser.zoomOut')}
        size="md"
        shape="circle"
        tone="muted"
        disabled={!canZoomOut}
        onClick={() => setPreviewZoom(previewZoom - BROWSER_ZOOM_STEP)}
      />
      <span className="min-w-11 select-none text-center font-mono text-xs font-medium tabular-nums text-[var(--color-text-secondary)]">
        {zoomPercent}%
      </span>
      <IconButton
        icon={<Plus size={14} />}
        label={t('browser.zoomIn')}
        size="md"
        shape="circle"
        tone="muted"
        disabled={!canZoomIn}
        onClick={() => setPreviewZoom(previewZoom + BROWSER_ZOOM_STEP)}
      />
      <IconButton
        icon={<RotateCcw size={14} />}
        label={t('browser.zoomReset')}
        size="md"
        shape="circle"
        tone="muted"
        disabled={previewZoom === DEFAULT_BROWSER_ZOOM}
        onClick={() => setPreviewZoom(DEFAULT_BROWSER_ZOOM)}
      />
    </div>
  )

  const previewActions = (
    <>
      <IconButton
        icon={<Camera size={16} />}
        label={t('browser.capture')}
        size="md"
        shape="circle"
        tone="muted"
        onClick={() => previewBridge.message({ v: 1, type: 'capture', kind: 'full' })}
      />
      <IconButton
        icon={<MousePointer2 size={16} />}
        label={t('browser.pickElement')}
        size="md"
        shape="circle"
        tone={session.pickerActive ? 'brand' : 'muted'}
        filled={Boolean(session.pickerActive)}
        aria-pressed={Boolean(session.pickerActive)}        onClick={() => {
          const cur = useBrowserPanelStore.getState().bySession[sessionId]
          const next = !cur?.pickerActive
          store.setPicker(sessionId, next)
          previewBridge.message({ v: 1, type: next ? 'enter-picker' : 'exit-picker' })
        }}
      />
    </>
  )

  return (
    <div className="flex h-full flex-col">
      <BrowserAddressBar
        url={session.url}
        canGoBack={session.canGoBack}
        canGoForward={session.canGoForward}
        loading={session.loading}
        onNavigate={openOrNavigate}
        onBack={() => {
          store.goBack(sessionId)
          store.setLoading(sessionId, true)
          const url = useBrowserPanelStore.getState().bySession[sessionId]!.url
          requestNativePreview(url)
        }}
        onForward={() => {
          store.goForward(sessionId)
          store.setLoading(sessionId, true)
          const url = useBrowserPanelStore.getState().bySession[sessionId]!.url
          requestNativePreview(url)
        }}
        onReload={() => {
          if (!session.url) return
          store.setLoading(sessionId, true)
          requestNativePreview(session.url, { force: true })
        }}
        rightActions={previewActions}
      />
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
        <div className="relative min-h-0 flex-1 overflow-hidden" data-testid="browser-preview-stage">
          {/* WebContentsView renders above DOM, so keep the floating controls outside its bounds. */}
          <div ref={hostRef} className="absolute inset-x-0 top-0 bottom-12 overflow-hidden" data-testid="preview-host">
            {session.loading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--color-surface)] text-[var(--color-text-tertiary)]">
                <Spinner size={18} label={t('browser.loading')} />
              </div>
            )}
          </div>
          <div
            data-testid="browser-preview-floating-controls"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[var(--z-raised)] flex h-12 items-end justify-end px-3 pb-2"
          >
            <div className="pointer-events-auto">
              {zoomControls}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
