import { api } from './client'
import { getDesktopHost } from '../lib/desktopHost'
import type {
  DesktopTunnelDownloadStatus,
  DesktopTunnelStartOptions,
  DesktopTunnelStatus,
} from '../lib/desktopHost/types'
import type {
  H5AccessDiagnostics,
  H5AccessSettings,
  H5TunnelMode,
  H5TunnelProvider,
} from '../types/settings'

export type { H5AccessDiagnostics, H5AccessSettings, H5TunnelProvider } from '../types/settings'

/**
 * The host's tunnel status already carries `provider` and `download`, so these
 * are plain aliases rather than a widened view — no cast is needed at the call
 * sites below.
 */
export type H5TunnelDownloadStatus = DesktopTunnelDownloadStatus
export type H5TunnelStatusView = DesktopTunnelStatus

export type H5TunnelStartOptions = DesktopTunnelStartOptions & {
  /**
   * Preferred provider. Omitted lets the main process pick (Cloudflare first,
   * with automatic Pinggy fallback). Only the manual "switch route" action
   * sends an explicit value.
   */
  provider?: H5TunnelProvider
}

export type H5AccessStatus = {
  settings: H5AccessSettings
  diagnostics?: H5AccessDiagnostics
}

export type H5AccessTokenResult = {
  settings: H5AccessSettings
  token: string
}

export const h5AccessApi = {
  get() {
    return api.get<H5AccessStatus>('/api/h5-access')
  },

  enable() {
    return api.post<H5AccessTokenResult>('/api/h5-access/enable')
  },

  disable() {
    return api.post<H5AccessStatus>('/api/h5-access/disable')
  },

  regenerate() {
    return api.post<H5AccessTokenResult>('/api/h5-access/regenerate')
  },

  update(input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
    fixedPort?: number | null
    disconnectGraceSeconds?: number | null
    tunnelToken?: string | null
    tunnelMode?: H5TunnelMode | null
  }) {
    return api.put<H5AccessStatus>('/api/h5-access', input)
  },

  /**
   * Tunnel control runs in the desktop main process (it spawns cloudflared),
   * so these go through the desktop host bridge rather than the HTTP API.
   * Returns null when not running inside the desktop shell (e.g. a browser H5
   * session), where one-click tunnelling is unavailable.
   */
  tunnelAvailable(): boolean {
    return !!getDesktopHost().tunnel
  },

  startTunnel(options: H5TunnelStartOptions): Promise<H5TunnelStatusView> {
    const host = getDesktopHost()
    if (!host.tunnel) {
      throw new Error('One-click tunnelling is only available in the desktop app.')
    }
    return host.tunnel.start(options)
  },

  stopTunnel(): Promise<H5TunnelStatusView> {
    const host = getDesktopHost()
    if (!host.tunnel) {
      throw new Error('One-click tunnelling is only available in the desktop app.')
    }
    return host.tunnel.stop()
  },

  /**
   * Manual downgrade: restart the tunnel pinned to `provider` instead of the
   * main process's default preference order. Used by the "switch route" action
   * when a Cloudflare URL loads on the desktop but not on the user's phone.
   *
   * Reuses the same `desktop:tunnel:start` IPC — the main process already
   * replaces a running tunnel on start, so no explicit stop is needed and the
   * host bridge does not need a new channel.
   */
  switchTunnelProvider(
    provider: H5TunnelProvider,
    options: Omit<H5TunnelStartOptions, 'provider'>,
  ): Promise<H5TunnelStatusView> {
    return h5AccessApi.startTunnel({ ...options, provider })
  },

  getTunnelStatus(): Promise<H5TunnelStatusView> | null {
    const host = getDesktopHost()
    return host.tunnel ? host.tunnel.getStatus() : null
  },
}
