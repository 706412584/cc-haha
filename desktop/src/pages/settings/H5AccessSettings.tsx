import { PublicAccessSettings } from './PublicAccessSettings'
import { useState, useEffect, useMemo, useCallback } from 'react'
import QRCode from 'qrcode'
import { Copy, Eye, EyeOff, PowerOff, QrCode, RotateCw, Shuffle } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Switch } from '@/components/ui/Switch'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { useUIStore } from '../../stores/uiStore'
import { isBrowserSafePort } from '../../lib/browserSafePort'
import { copyTextToClipboard } from '@/lib/clipboard'
import { h5AccessApi, type H5TunnelStatusView } from '../../api/h5Access'
import type { H5TunnelProvider } from '../../types/settings'

/**
 * The H5 access panel — current monolith implementation including tunnel controls.
 */

function buildH5LaunchUrl(baseUrl: string | null, token: string | null): string | null {
  if (!baseUrl) return null

  try {
    const url = new URL(baseUrl)
    if (token) {
      url.searchParams.set('serverUrl', baseUrl)
      url.searchParams.set('h5Token', token)
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return token
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}serverUrl=${encodeURIComponent(baseUrl)}&h5Token=${encodeURIComponent(token)}`
      : baseUrl
  }
}

function isLanH5BaseUrl(url: URL): boolean {
  return url.protocol === 'http:' &&
    !!url.port &&
    (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.startsWith('10.') ||
      url.hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname) ||
      url.hostname.startsWith('169.254.')
    )
}

function extractH5AccessAddressDraft(baseUrl: string | null): string {
  if (!baseUrl) return ''

  try {
    const url = new URL(baseUrl)
    return isLanH5BaseUrl(url) ? url.hostname : baseUrl
  } catch {
    return baseUrl
  }
}

function extractHostnameFromUrl(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname || null
  } catch {
    return null
  }
}

function extractH5AccessPort(baseUrl: string | null): string | null {
  if (!baseUrl) return null

  try {
    const url = new URL(baseUrl)
    return url.port || null
  } catch {
    return null
  }
}

// Mirrors the server-side fixedPort range (h5AccessService MIN/MAX_FIXED_PORT).
function parseH5FixedPortDraft(draft: string): number | null | 'invalid' {
  const trimmed = draft.trim()
  if (!trimmed) return null
  if (!/^\d{1,5}$/.test(trimmed)) return 'invalid'
  const port = Number(trimmed)
  return port >= 1024 && port <= 65535 && isBrowserSafePort(port) ? port : 'invalid'
}

// Mirrors the server-side disconnect grace range (h5AccessService
// MIN/MAX_DISCONNECT_GRACE_SECONDS). Empty = use the built-in 30s default.
function parseH5GraceDraft(draft: string): number | null | 'invalid' {
  const trimmed = draft.trim()
  if (!trimmed) return null
  if (!/^\d{1,5}$/.test(trimmed)) return 'invalid'
  const seconds = Number(trimmed)
  return seconds >= 5 && seconds <= 86400 ? seconds : 'invalid'
}

function buildH5PublicBaseUrlFromHostDraft(draft: string, currentBaseUrl: string | null): string | null {
  const trimmed = draft.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed

  try {
    const current = currentBaseUrl ? new URL(currentBaseUrl) : null
    if (!current) return trimmed

    const port = current.port ? `:${current.port}` : ''
    const path = current.pathname === '/' ? '' : current.pathname.replace(/\/+$/, '')
    return `${current.protocol}//${trimmed}${port}${path}`
  } catch {
    return trimmed
  }
}

/** Which provider the live tunnel is using; `undefined` = not reported yet. */
function readTunnelProvider(state: H5TunnelStatusView | null | undefined): H5TunnelProvider | null {
  const provider = state?.provider
  return provider === 'cloudflare' || provider === 'pinggy' ? provider : null
}

/**
 * Integer percent for the cloudflared download bar, or null when the host has
 * not reported a total (indeterminate). Clamped so a stale/odd host value
 * cannot render "-3%" or "140%".
 */
function readDownloadPercent(state: H5TunnelStatusView | null | undefined): number | null {
  const download = state?.download
  if (!download || download.state !== 'downloading') return null
  const total = download.totalBytes
  const received = download.receivedBytes
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
  if (typeof received !== 'number' || !Number.isFinite(received)) return null
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)))
}

export function H5AccessSettings() {
  const {
    h5Access,
    h5AccessDiagnostics,
    h5AccessError,
    fetchH5Access,
    enableH5Access,
    disableH5Access,
    regenerateH5AccessToken,
    updateH5AccessSettings,
    startH5Tunnel,
    stopH5Tunnel,
  } = useSettingsStore()
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const [h5PublicBaseUrlDraft, setH5PublicBaseUrlDraft] = useState(extractH5AccessAddressDraft(h5Access.publicBaseUrl))
  const [h5FixedPortDraft, setH5FixedPortDraft] = useState(h5Access.fixedPort != null ? String(h5Access.fixedPort) : '')
  const [h5GraceDraft, setH5GraceDraft] = useState(h5Access.disconnectGraceSeconds != null ? String(h5Access.disconnectGraceSeconds) : '')
  const [h5TokenVisible, setH5TokenVisible] = useState(false)
  const [h5EnableConfirmOpen, setH5EnableConfirmOpen] = useState(false)
  const [h5QrDataUrl, setH5QrDataUrl] = useState<string | null>(null)
  const [h5ActionRunning, setH5ActionRunning] = useState(false)
  const [h5TunnelMode, setH5TunnelMode] = useState<'quick' | 'named'>('quick')
  const [h5TunnelTokenDraft, setH5TunnelTokenDraft] = useState('')
  const [h5TunnelTokenVisible, setH5TunnelTokenVisible] = useState(false)
  // Host-direct tunnel status. The server's diagnostics mirror the same state
  // but lag by one poll, so the host read gives the download progress and
  // provider without waiting for the next /api/h5-access refresh.
  const [h5HostTunnelStatus, setH5HostTunnelStatus] = useState<H5TunnelStatusView | null>(null)
  // One-click tunnelling spawns cloudflared in the desktop main process, so it
  // is only available inside the Electron shell, not a browser H5 session.
  const h5TunnelAvailable = h5AccessApi.tunnelAvailable()
  const h5TunnelState = h5AccessDiagnostics?.tunnel
  const h5TunnelRunning = h5TunnelState?.status === 'running'
  // A provider that exited unexpectedly is retried by the main process; the UI
  // keeps polling and shows the reconnect instead of a frozen dead URL.
  const h5TunnelReconnecting = h5TunnelState?.status === 'reconnecting'
  // "Occupied" covers every state where a tunnel process exists or is being
  // brought up, so the toggle offers Stop (cancelling a reconnect) and the mode
  // controls stay locked instead of silently spawning a second tunnel.
  const h5TunnelOccupied = h5TunnelRunning || h5TunnelReconnecting || h5TunnelState?.status === 'starting'
  // Provider: prefer the host-direct report, fall back to the server mirror.
  // A missing value on both is "unknown", never assumed to be Cloudflare.
  const h5TunnelProvider = readTunnelProvider(h5HostTunnelStatus) ?? readTunnelProvider(h5TunnelState)
  // Pinggy's free tier hard-caps a tunnel at 60 minutes. Warn whenever Pinggy is
  // the live route — including while it is reconnecting after that cap hit.
  const h5TunnelPinggyActive = h5TunnelProvider === 'pinggy' && (h5TunnelRunning || h5TunnelReconnecting)
  const h5TunnelDownload = h5HostTunnelStatus?.download ?? null
  const h5TunnelDownloading = h5TunnelDownload?.state === 'downloading'
  const h5TunnelDownloadFailed = h5TunnelDownload?.state === 'failed'
  const h5TunnelDownloadPercent = readDownloadPercent(h5HostTunnelStatus)
  // "Switch route" is offered while a tunnel is up on Cloudflare and has not
  // already fallen back to Pinggy. Quick mode only: the main process refuses
  // Pinggy for a named tunnel (the domain is bound in Cloudflare), so offering
  // the button there would guarantee a failure toast.
  const h5TunnelCanSwitchRoute = (h5TunnelRunning || h5TunnelReconnecting)
    && h5TunnelProvider === 'cloudflare'
    && h5TunnelState?.mode !== 'named'
  const h5AccessUrl = h5Access.publicBaseUrl
  // The token is persisted server-side, so the QR code and copy actions stay
  // available across desktop restarts (issue #767).
  const h5Token = h5Access.token
  const h5LaunchUrl = useMemo(
    () => buildH5LaunchUrl(h5AccessUrl, h5Token),
    [h5AccessUrl, h5Token],
  )
  const h5ActivePort = h5AccessDiagnostics?.activePort != null
    ? String(h5AccessDiagnostics.activePort)
    : extractH5AccessPort(h5AccessUrl)
  const h5NextPublicBaseUrl = buildH5PublicBaseUrlFromHostDraft(h5PublicBaseUrlDraft, h5Access.publicBaseUrl)
  const h5NextFixedPort = parseH5FixedPortDraft(h5FixedPortDraft)
  const h5FixedPortInvalid = h5NextFixedPort === 'invalid'
  const h5NextGrace = parseH5GraceDraft(h5GraceDraft)
  const h5GraceInvalid = h5NextGrace === 'invalid'
  const h5AccessDirty = h5NextPublicBaseUrl !== (h5Access.publicBaseUrl ?? null) ||
    (!h5FixedPortInvalid && h5NextFixedPort !== h5Access.fixedPort) ||
    (!h5GraceInvalid && h5NextGrace !== h5Access.disconnectGraceSeconds)
  const h5FixedPortPendingRestart = h5Access.fixedPort != null &&
    h5ActivePort != null &&
    String(h5Access.fixedPort) !== h5ActivePort

  const refreshH5HostTunnelStatus = useCallback(() => {
    const pending = h5AccessApi.getTunnelStatus()
    if (!pending) return
    void pending.then(setH5HostTunnelStatus).catch(() => {
      // The server diagnostics refresh below owns the user-visible error.
    })
  }, [])

  useEffect(() => {
    const status = h5TunnelState?.status
    if (!h5TunnelAvailable || (status !== 'starting' && status !== 'running' && status !== 'reconnecting')) return
    const interval = window.setInterval(() => {
      void fetchH5Access()
    }, 10_000)
    return () => window.clearInterval(interval)
  }, [fetchH5Access, h5TunnelAvailable, h5TunnelState?.status])

  // Host-direct poll. The server mirror refreshes every 10s above, but a
  // cloudflared download is short-lived and needs a faster cadence — and it can
  // start before the server knows anything is happening at all. `h5ActionRunning`
  // is the trigger that matters: the `start` IPC promise stays pending for the
  // whole download, so the host status is the only way to see its progress.
  //
  // The first read runs unconditionally: a mount that lands *after* the
  // download already failed (settings reopened, window reloaded) still needs
  // the terminal `failed` state, which the server's error string alone cannot
  // distinguish from any other tunnel failure.
  useEffect(() => {
    if (!h5TunnelAvailable) return
    refreshH5HostTunnelStatus()
    const active = h5ActionRunning ||
      h5TunnelDownloading ||
      h5TunnelState?.status === 'starting' ||
      h5TunnelState?.status === 'running' ||
      h5TunnelState?.status === 'reconnecting'
    if (!active) return
    const intervalMs = h5ActionRunning || h5TunnelDownloading ? 2_000 : 10_000
    const interval = window.setInterval(refreshH5HostTunnelStatus, intervalMs)
    return () => window.clearInterval(interval)
  }, [
    h5TunnelAvailable,
    h5ActionRunning,
    h5TunnelDownloading,
    h5TunnelState?.status,
    refreshH5HostTunnelStatus,
  ])

  useEffect(() => {
    setH5PublicBaseUrlDraft(extractH5AccessAddressDraft(h5Access.publicBaseUrl))
    setH5FixedPortDraft(h5Access.fixedPort != null ? String(h5Access.fixedPort) : '')
    setH5GraceDraft(h5Access.disconnectGraceSeconds != null ? String(h5Access.disconnectGraceSeconds) : '')
  }, [h5Access])

  useEffect(() => {
    let cancelled = false
    if (!h5Access.enabled || !h5LaunchUrl || !h5Token) {
      setH5QrDataUrl(null)
      return () => {
        cancelled = true
      }
    }

    QRCode.toDataURL(h5LaunchUrl, { margin: 1, width: 192 })
      .then((dataUrl) => {
        if (!cancelled) setH5QrDataUrl(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setH5QrDataUrl(null)
      })

    return () => {
      cancelled = true
    }
  }, [h5Access.enabled, h5LaunchUrl, h5Token])

  const runH5Action = async (action: () => Promise<void>) => {
    setH5ActionRunning(true)
    try {
      await action()
    } catch {
      // The store owns H5-specific error state.
    } finally {
      setH5ActionRunning(false)
    }
  }

  const handleH5SettingsSave = async () => {
    if (h5FixedPortInvalid || h5GraceInvalid) return
    await runH5Action(async () => {
      await updateH5AccessSettings({
        publicBaseUrl: h5NextPublicBaseUrl,
        fixedPort: h5NextFixedPort,
        disconnectGraceSeconds: h5NextGrace,
      })
    })
  }

  const handleH5SwitchToSuggestedHost = async () => {
    const suggested = h5AccessDiagnostics?.suggestedHost
    if (!suggested) return
    await runH5Action(async () => {
      // Build URL using current port if available, otherwise let backend pick.
      const port = extractH5AccessPort(h5Access.publicBaseUrl)
      const nextUrl = port ? `http://${suggested}:${port}` : `http://${suggested}`
      await updateH5AccessSettings({ publicBaseUrl: nextUrl })
    })
  }

  const handleH5UrlCopy = async () => {
    if (!h5AccessUrl) return
    const copied = await copyTextToClipboard(h5AccessUrl)
    addToast({
      type: copied ? 'success' : 'error',
      message: copied ? t('settings.general.h5AccessUrlCopied') : t('common.copyFailed'),
    })
  }

  const handleH5TunnelToggle = async () => {
    await runH5Action(async () => {
      if (h5TunnelOccupied) {
        await stopH5Tunnel()
        return
      }
      if (h5TunnelMode === 'named') {
        const token = h5TunnelTokenDraft.trim()
        if (token) {
          // Persist the token so the named tunnel survives restarts.
          await updateH5AccessSettings({ tunnelToken: token, tunnelMode: 'named' })
        }
        await startH5Tunnel({
          mode: 'named',
          token: token || undefined,
          namedUrl: h5NextPublicBaseUrl || h5Access.publicBaseUrl || undefined,
        })
      } else {
        await startH5Tunnel({ mode: 'quick' })
      }
    })
  }

  // Manual downgrade: pin the tunnel to Pinggy. The desktop main process
  // replaces the running tunnel on start, so no explicit stop is needed.
  //
  // Quick only — the button is hidden for a named tunnel, and the main process
  // would reject Pinggy there anyway (the domain is bound in Cloudflare).
  const handleH5SwitchTunnelRoute = async () => {
    await runH5Action(async () => {
      try {
        await h5AccessApi.switchTunnelProvider('pinggy', { mode: 'quick' })
      } catch {
        addToast({ type: 'error', message: t('settings.general.h5AccessTunnelError') })
      } finally {
        // Pick up the new URL / provider from the server mirror, then the host.
        await fetchH5Access()
        refreshH5HostTunnelStatus()
      }
    })
  }

  const handleH5LaunchUrlCopy = async () => {
    if (!h5LaunchUrl) return
    const copied = await copyTextToClipboard(h5LaunchUrl)
    addToast({
      type: copied ? 'success' : 'error',
      message: copied ? t('settings.general.h5AccessLaunchUrlCopied') : t('common.copyFailed'),
    })
  }

  const handleH5EnableConfirm = async () => {
    await runH5Action(async () => {
      await enableH5Access()
      setH5TokenVisible(false)
      setH5EnableConfirmOpen(false)
    })
  }

  const handleH5Disable = async () => {
    await runH5Action(async () => {
      await disableH5Access()
      setH5TokenVisible(false)
    })
  }

  const handleH5Regenerate = async () => {
    await runH5Action(async () => {
      await regenerateH5AccessToken()
      setH5TokenVisible(false)
    })
  }

  return (
    <div className="w-full min-w-0">
      <section aria-labelledby="h5-access-title" role="region">
        <SettingsPageHeader
          titleId="h5-access-title"
          title={t('settings.tab.h5Access')}
          description={t('settings.general.h5AccessDescription')}
        />

        <SettingsGroup className="mt-7">
          <SettingsRow
            layout="inline"
            title={t('settings.general.h5AccessEnabled')}
            description={t('settings.general.h5AccessEnabledHint')}
          >
            <Badge tone={h5Access.enabled ? 'success' : 'neutral'} size="sm">
              {h5Access.enabled ? t('settings.general.h5AccessStatusEnabled') : t('settings.general.h5AccessDisabledValue')}
            </Badge>
            <Switch
              label={t('settings.general.h5AccessEnabled')}
              labelHidden
              checked={h5Access.enabled}
              disabled={h5ActionRunning}
              onChange={(checked) => {
                if (checked) {
                  setH5EnableConfirmOpen(true)
                } else {
                  void handleH5Disable()
                }
              }}
            />
          </SettingsRow>

          {h5AccessDiagnostics?.storedHostStaleness === 'unreachable' && h5AccessDiagnostics.storedPublicBaseUrl ? (
            <SettingsBlock>
              <div
                data-testid="h5-access-stale-host-banner"
                className="rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-3 text-xs leading-[1.5] text-[var(--color-on-warning-container)]"
              >
                <div className="font-semibold">
                  {t('settings.general.h5AccessStaleHostTitle')}
                </div>
                <div className="mt-1">
                  {h5AccessDiagnostics.suggestedHost
                    ? t('settings.general.h5AccessStaleHostBody', {
                        storedHost: extractHostnameFromUrl(h5AccessDiagnostics.storedPublicBaseUrl) ?? h5AccessDiagnostics.storedPublicBaseUrl,
                      })
                    : t('settings.general.h5AccessStaleHostNoSuggestion', {
                        storedHost: extractHostnameFromUrl(h5AccessDiagnostics.storedPublicBaseUrl) ?? h5AccessDiagnostics.storedPublicBaseUrl,
                      })}
                </div>
                {h5AccessDiagnostics.suggestedHost && (
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="primary"
                      loading={h5ActionRunning}
                      onClick={() => void handleH5SwitchToSuggestedHost()}
                      data-testid="h5-access-stale-host-apply"
                    >
                      {t('settings.general.h5AccessStaleHostApply', {
                        suggestedHost: h5AccessDiagnostics.suggestedHost,
                      })}
                    </Button>
                  </div>
                )}
              </div>
            </SettingsBlock>
          ) : null}

          {h5AccessDiagnostics?.storedHostStaleness === 'proxy' ? (
            <SettingsBlock>
              <p
                data-testid="h5-access-proxy-note"
                className="text-xs leading-[1.5] text-[var(--color-text-tertiary)]"
              >
                {t('settings.general.h5AccessProxyNote')}
              </p>
            </SettingsBlock>
          ) : null}
        </SettingsGroup>

        <SettingsSection title={t('settings.general.h5AccessUrl')} description={t('settings.general.h5AccessOpenHint')}>
          <SettingsGroup>
            <SettingsRow title={t('settings.general.h5AccessPublicHost')} htmlFor="h5-access-public-url">
              <Input
                id="h5-access-public-url"
                size="md"
                containerClassName="w-full sm:w-[260px]"
                className="font-mono text-xs"
                value={h5PublicBaseUrlDraft}
                placeholder={t('settings.general.h5AccessPublicHostPlaceholder')}
                onChange={(event) => setH5PublicBaseUrlDraft(event.target.value)}
              />
            </SettingsRow>
            <SettingsRow
              title={t('settings.general.h5AccessFixedPort')}
              htmlFor="h5-access-fixed-port"
              description={t('settings.general.h5AccessFixedPortHint')}
            >
              <Input
                id="h5-access-fixed-port"
                size="md"
                containerClassName="w-full sm:w-[140px]"
                className="font-mono text-xs tabular-nums"
                value={h5FixedPortDraft}
                placeholder={t('settings.general.h5AccessFixedPortPlaceholder')}
                inputMode="numeric"
                error={h5FixedPortInvalid ? t('settings.general.h5AccessFixedPortInvalid') : undefined}
                onChange={(event) => setH5FixedPortDraft(event.target.value)}
              />
            </SettingsRow>
            <SettingsRow title={t('settings.general.h5AccessCurrentPort')} htmlFor="h5-access-current-port">
              <Input
                id="h5-access-current-port"
                size="md"
                containerClassName="w-full sm:w-[140px]"
                value={h5ActivePort ?? t('settings.general.h5AccessCurrentPortUnknown')}
                readOnly
                className="font-mono text-xs tabular-nums text-[var(--color-text-tertiary)]"
              />
            </SettingsRow>
            <SettingsRow
              title={t('settings.general.h5AccessDisconnectGrace')}
              htmlFor="h5-access-disconnect-grace"
              description={t('settings.general.h5AccessDisconnectGraceHint')}
            >
              <Input
                id="h5-access-disconnect-grace"
                size="md"
                containerClassName="w-full sm:w-[140px]"
                className="font-mono text-xs tabular-nums"
                value={h5GraceDraft}
                placeholder={t('settings.general.h5AccessDisconnectGracePlaceholder')}
                inputMode="numeric"
                error={h5GraceInvalid ? t('settings.general.h5AccessDisconnectGraceInvalid') : undefined}
                onChange={(event) => setH5GraceDraft(event.target.value)}
              />
            </SettingsRow>
            {h5AccessUrl && (
              <SettingsBlock>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1 break-all rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs leading-5 text-[var(--color-text-primary)]">
                    {h5AccessUrl}
                  </div>
                  <Button
                    size="base"
                    variant="secondary"
                    className="shrink-0"
                    icon={<Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
                    aria-label={t('settings.general.h5AccessCopyUrl')}
                    onClick={() => void handleH5UrlCopy()}
                  >
                    {t('settings.general.h5AccessCopy')}
                  </Button>
                </div>
              </SettingsBlock>
            )}
            <SettingsBlock className="flex justify-end">
              <Button
                size="base"
                variant="secondary"
                className="whitespace-nowrap"
                onClick={() => void handleH5SettingsSave()}
                disabled={!h5AccessDirty || h5FixedPortInvalid || h5GraceInvalid || h5ActionRunning}
                aria-label={t('settings.general.h5AccessSave')}
              >
                {t('settings.general.h5AccessSave')}
              </Button>
            </SettingsBlock>
            {h5FixedPortPendingRestart && (
              <div
                data-testid="h5-access-fixed-port-restart-note"
                className="rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-warning-container)]"
              >
                {t('settings.general.h5AccessFixedPortRestartNote', {
                  fixedPort: String(h5Access.fixedPort),
                  activePort: h5ActivePort ?? '',
                })}
              </div>
            )}
            {h5TunnelAvailable && (
              <div
                data-testid="h5-access-tunnel"
                className="mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">
                    {t('settings.general.h5AccessTunnelTitle')}
                  </span>
                  {(h5TunnelRunning || h5TunnelReconnecting) && (
                    <Badge tone="neutral" size="sm" bordered data-testid="h5-access-tunnel-provider">
                      {t('settings.general.h5AccessTunnelProvider')}
                      {': '}
                      {h5TunnelProvider === 'cloudflare'
                        ? t('settings.general.h5AccessTunnelProviderCloudflare')
                        : h5TunnelProvider === 'pinggy'
                          ? t('settings.general.h5AccessTunnelProviderPinggy')
                          : t('settings.general.h5AccessTunnelProviderUnknown')}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
                  {t('settings.general.h5AccessTunnelHint')}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select
                    aria-label={t('settings.general.h5AccessTunnelMode')}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]"
                    value={h5TunnelMode}
                    disabled={h5TunnelOccupied || h5ActionRunning}
                    onChange={(event) => setH5TunnelMode(event.target.value === 'named' ? 'named' : 'quick')}
                  >
                    <option value="quick">{t('settings.general.h5AccessTunnelModeQuick')}</option>
                    <option value="named">{t('settings.general.h5AccessTunnelModeNamed')}</option>
                  </select>
                  <Button
                    size="sm"
                    variant={h5TunnelOccupied ? 'secondary' : 'primary'}
                    loading={h5ActionRunning}
                    onClick={() => void handleH5TunnelToggle()}
                    data-testid="h5-access-tunnel-toggle"
                  >
                    {h5TunnelOccupied
                      ? t('settings.general.h5AccessTunnelStop')
                      : t('settings.general.h5AccessTunnelStart')}
                  </Button>
                </div>
                {h5TunnelPinggyActive && (
                  <p
                    data-testid="h5-access-tunnel-pinggy-expiry"
                    role="status"
                    className="mt-2 text-xs leading-5 text-[var(--color-warning)]"
                  >
                    {t('settings.general.h5AccessTunnelPinggyExpiry')}
                  </p>
                )}
                {h5TunnelCanSwitchRoute && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Shuffle className="h-3.5 w-3.5" aria-hidden="true" />}
                      disabled={h5ActionRunning}
                      onClick={() => void handleH5SwitchTunnelRoute()}
                      data-testid="h5-access-tunnel-switch-route"
                    >
                      {t('settings.general.h5AccessTunnelSwitchRoute')}
                    </Button>
                    <span className="text-xs leading-5 text-[var(--color-text-tertiary)]">
                      {t('settings.general.h5AccessTunnelSwitchRouteHint')}
                    </span>
                  </div>
                )}
                {h5TunnelMode === 'named' && !h5TunnelOccupied && (
                  <div className="mt-3">
                    <Input
                      id="h5-access-tunnel-token"
                      label={t('settings.general.h5AccessTunnelToken')}
                      type={h5TunnelTokenVisible ? 'text' : 'password'}
                      value={h5TunnelTokenDraft}
                      placeholder={h5TunnelState?.hasToken
                        ? t('settings.general.h5AccessTunnelTokenStored')
                        : t('settings.general.h5AccessTunnelTokenPlaceholder')}
                      onChange={(event) => setH5TunnelTokenDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      className="mt-1 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
                      onClick={() => setH5TunnelTokenVisible((v) => !v)}
                    >
                      {h5TunnelTokenVisible
                        ? t('settings.general.h5AccessHideToken')
                        : t('settings.general.h5AccessShowToken')}
                    </button>
                  </div>
                )}
                {h5TunnelDownloading && (
                  <div
                    data-testid="h5-access-tunnel-download"
                    data-state="downloading"
                    role="status"
                    className="mt-3 text-xs leading-5 text-[var(--color-text-secondary)]"
                  >
                    {h5TunnelDownloadPercent === null
                      ? t('settings.general.h5AccessTunnelDownloading')
                      : t('settings.general.h5AccessTunnelDownloadingProgress', {
                          percent: String(h5TunnelDownloadPercent),
                        })}
                    {h5TunnelDownloadPercent !== null && (
                      <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={h5TunnelDownloadPercent}
                        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-container)]"
                      >
                        <div
                          className="h-full rounded-full bg-[var(--color-brand)] transition-[width] duration-300"
                          style={{ width: `${h5TunnelDownloadPercent}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
                {h5TunnelDownloadFailed && (
                  <div
                    data-testid="h5-access-tunnel-download-error"
                    data-state="failed"
                    role="alert"
                    className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-error-container)]"
                  >
                    <div className="font-semibold">
                      {t('settings.general.h5AccessTunnelDownloadFailed')}
                    </div>
                    <div className="mt-1">
                      {t('settings.general.h5AccessTunnelDownloadFailedHint')}
                    </div>
                  </div>
                )}
                {h5TunnelState && h5TunnelState.status !== 'idle' && (
                  <div
                    data-testid="h5-access-tunnel-status"
                    className="mt-3 text-xs leading-5 text-[var(--color-text-secondary)]"
                  >
                    {h5TunnelState.status === 'starting' && t('settings.general.h5AccessTunnelStarting')}
                    {h5TunnelState.status === 'reconnecting' && (
                      <span className="text-[var(--color-warning)]">
                        {t('settings.general.h5AccessTunnelReconnecting')}
                      </span>
                    )}
                    {h5TunnelState.status === 'running' && h5TunnelState.url && (
                      <span className="break-all">
                        {t('settings.general.h5AccessTunnelRunning')} {h5TunnelState.url}
                      </span>
                    )}
                    {h5TunnelState.status === 'error' && (
                      <span className="text-[var(--color-error)]">
                        {h5TunnelState.error ?? t('settings.general.h5AccessTunnelError')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </SettingsGroup>
        </SettingsSection>

        {h5Access.enabled && (
          <SettingsSection title={t('settings.general.h5AccessQrTitle')}>
            <SettingsGroup>
              {h5AccessUrl && (
                <SettingsBlock className="flex flex-col gap-4 py-4 sm:flex-row">
                  {/* A white box on purpose, in every theme: scanners need the
                      contrast, so its placeholder text uses stock neutrals that
                      stay dark under `data-theme="dark"` too. */}
                  <div className="flex h-44 w-44 shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-3">
                    {h5QrDataUrl ? (
                      <img
                        src={h5QrDataUrl}
                        alt={t('settings.general.h5AccessQrAlt')}
                        className="h-full w-full"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-3 px-4 text-center">
                        <QrCode size={40} strokeWidth={1.5} className="text-neutral-400" aria-hidden="true" />
                        <p className="text-xs leading-5 text-neutral-500">
                          {t('settings.general.h5AccessQrEmptyHint')}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
                      {h5Token
                        ? t('settings.general.h5AccessQrHint')
                        : t('settings.general.h5AccessQrRefreshHint')}
                    </p>
                    {h5LaunchUrl && (
                      <div className="mt-3 break-all rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs leading-5 text-[var(--color-text-primary)]">
                        {h5LaunchUrl}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="base"
                        variant="secondary"
                        icon={<Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
                        disabled={!h5LaunchUrl || !h5Token}
                        onClick={() => void handleH5LaunchUrlCopy()}
                      >
                        {t('settings.general.h5AccessCopyLaunchUrl')}
                      </Button>
                      <Button
                        size="base"
                        variant={h5Token ? 'secondary' : 'primary'}
                        icon={<RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />}
                        loading={h5ActionRunning}
                        onClick={() => void handleH5Regenerate()}
                      >
                        {h5Token ? t('settings.general.h5AccessRegenerate') : t('settings.general.h5AccessGenerateToken')}
                      </Button>
                    </div>
                  </div>
                </SettingsBlock>
              )}

              <SettingsRow
                title={t('settings.general.h5AccessTokenPreview')}
                description={(
                  <span className="break-all font-mono text-xs text-[var(--color-text-primary)]">
                    {h5TokenVisible && h5Token
                      ? h5Token
                      : h5Access.tokenPreview || t('settings.general.h5AccessTokenNotAvailable')}
                  </span>
                )}
              >
                <Button
                  size="base"
                  variant="secondary"
                  icon={h5TokenVisible
                    ? <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" />
                    : <Eye size={14} strokeWidth={1.75} aria-hidden="true" />}
                  disabled={!h5Token}
                  onClick={() => setH5TokenVisible((visible) => !visible)}
                >
                  {h5TokenVisible ? t('settings.general.h5AccessHideToken') : t('settings.general.h5AccessShowToken')}
                </Button>
                <Button
                  size="base"
                  variant="danger-ghost"
                  icon={<PowerOff size={14} strokeWidth={1.75} aria-hidden="true" />}
                  loading={h5ActionRunning}
                  onClick={() => void handleH5Disable()}
                >
                  {t('settings.general.h5AccessDisable')}
                </Button>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
        )}

        <p className="mt-3 px-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
          {t('settings.general.h5AccessSafetyNote')}
        </p>
        {h5AccessError && (
          <p className="mt-2 px-0.5 text-xs text-[var(--color-error)]">
            {h5AccessError}
          </p>
        )}
      </section>

      <PublicAccessSettings />

      <ConfirmDialog
        open={h5EnableConfirmOpen}
        onClose={() => {
          if (!h5ActionRunning) setH5EnableConfirmOpen(false)
        }}
        onConfirm={handleH5EnableConfirm}
        title={t('settings.general.h5AccessConfirmTitle')}
        body={t('settings.general.h5AccessConfirmBody')}
        confirmLabel={t('settings.general.h5AccessConfirmEnable')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={h5ActionRunning}
      />
    </div>
  )
}
