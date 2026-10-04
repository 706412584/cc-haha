import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { H5Settings } from './H5Settings'
import { H5AccessSettings } from './H5AccessSettings'
import { Settings } from '../Settings'
import { ProviderSettings } from './ProviderSettings'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useProviderStore } from '@/stores/providerStore'
import { providersApi } from '@/api/providers'
import { settingsApi } from '@/api/settings'
import { modelsApi } from '@/api/models'
import { h5AccessApi } from '@/api/h5Access'
import { translate } from '@/i18n'
import type { SavedProvider } from '@/types/provider'

const saved: SavedProvider = {
  id: 'fixture-provider', name: 'Fixture provider', presetId: 'custom', baseUrl: 'https://fixture.example', apiKey: '', apiFormat: 'anthropic',
  models: { main: 'fixture-model', haiku: 'fixture-model', sonnet: 'fixture-model', opus: 'fixture-model' },
}
beforeEach(() => {
  useSettingsStore.setState({ locale: 'en', outputStyle: 'default', responseLanguage: '', effortLevel: 'high', currentModel: { id: 'fixture-model', name: 'Fixture model', context: '', description: '', supportedReasoningEfforts: ['low', 'high'] } })
  useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
  useProviderStore.setState({ providers: [saved], activeId: null, hasLoadedProviders: true })
  vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [saved], activeId: null })
  vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
  vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
  vi.spyOn(providersApi, 'updateSettings').mockResolvedValue({ ok: true })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('limits browser navigation to providers and general, with local appearance and shared agent preferences', async () => {
  useUIStore.setState({ activeSettingsTab: 'terminal' })
  render(<H5Settings />)
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  expect(nav.getAllByRole('button')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument()
  fireEvent.click(nav.getByRole('button', { name: 'General' }))
  expect(screen.getByText('Appearance and interface language apply only to this browser.')).toBeInTheDocument()
  const update = vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
  fireEvent.change(screen.getByLabelText('Output Style'), { target: { value: 'Learning' } })
  await waitFor(() => expect(update).toHaveBeenCalledWith({ outputStyle: 'Learning' }))
  await waitFor(() => expect(screen.getByLabelText('Reasoning effort')).not.toBeDisabled())
  const effort = vi.spyOn(modelsApi, 'setEffort').mockResolvedValue({ ok: true, level: 'low' })
  fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'low' } })
  await waitFor(() => expect(effort).toHaveBeenCalledWith('low'))
  expect(screen.queryByLabelText(/ngrok Authtoken/)).not.toBeInTheDocument()
})
it('edits saved providers without reading or overwriting stored keys or global settings', async () => {
  const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider: saved })
  render(<ProviderSettings browserMode />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.queryByRole('textbox', { name: 'Settings JSON' })).not.toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: 'Test Connection' })).not.toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: /Fetch Models/ })).not.toBeInTheDocument()
  expect(dialog.getByLabelText('API Key')).toHaveValue('')
  expect(providersApi.getSettings).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(update).toHaveBeenCalled())
  expect(update.mock.calls[0]![0]).toBe('fixture-provider')
  expect(update.mock.calls[0]![1]).not.toHaveProperty('apiKey')
  expect(providersApi.updateSettings).not.toHaveBeenCalled()
})
it('creates a provider using the existing form and reports save errors without leaking details', async () => {
  const create = vi.spyOn(providersApi, 'create').mockRejectedValue(new Error('secret upstream credential'))
  render(<ProviderSettings browserMode />)
  fireEvent.click(screen.getByRole('button', { name: /Add Model/ }))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.change(dialog.getByPlaceholderText('sk-...'), { target: { value: 'fake-test-key' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(await dialog.findByRole('alert')).toHaveTextContent('The action failed. Please retry.')
  expect(screen.queryByText('secret upstream credential')).not.toBeInTheDocument()
})
it('activates and deletes providers through the existing API without connection probes', async () => {
  const activate = vi.spyOn(providersApi, 'activate').mockResolvedValue({ ok: true })
  const remove = vi.spyOn(providersApi, 'delete').mockResolvedValue({ ok: true })
  const probe = vi.spyOn(providersApi, 'test')
  render(<ProviderSettings browserMode />)
  const row = within(await screen.findByTestId('provider-fixture-provider'))
  fireEvent.click(row.getByRole('button', { name: 'Set default' }))
  await waitFor(() => expect(activate).toHaveBeenCalledWith('fixture-provider'))
  fireEvent.click(row.getByRole('button', { name: 'Delete' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith('fixture-provider'))
  expect(probe).not.toHaveBeenCalled()
})
it('changes browser appearance without writing connected computer settings', async () => {
  useUIStore.setState({ activeSettingsTab: 'general', followSystemTheme: true })
  const update = vi.spyOn(settingsApi, 'updateUser')
  render(<H5Settings />)
  fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'ink-blue' } })
  expect(useUIStore.getState().theme).toBe('ink-blue')
  expect(useUIStore.getState().followSystemTheme).toBe(false)
  expect(update).not.toHaveBeenCalled()
})

it('routes the actual Settings page to the browser-safe panels', async () => {
  render(<Settings />)
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  expect(nav.getAllByRole('button')).toHaveLength(2)
  expect(screen.queryByTestId('settings-navigation')).not.toBeInTheDocument()
  expect(await screen.findByTestId('provider-fixture-provider')).toBeInTheDocument()
})

it.each([true, false])('shows beta details on focus without overflowing narrow forms (browserMode=%s)', async (browserMode) => {
  render(<ProviderSettings browserMode={browserMode} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  expect(screen.queryByText(/CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1/)).not.toBeInTheDocument()
  fireEvent.focus(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable experimental beta headers' }))
  const description = await screen.findByRole('tooltip')
  expect(description).toHaveTextContent('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1')
  expect(description.classList.contains('[overflow-wrap:anywhere]')).toBe(true)
})

// ---------------------------------------------------------------------------
// One-click tunnel: provider presentation, cloudflared auto-download progress,
// and the manual "switch route" downgrade entry point.
// ---------------------------------------------------------------------------

type TunnelDiagnostics = {
  status: 'idle' | 'starting' | 'running' | 'reconnecting' | 'error'
  url: string | null
  mode: 'quick' | 'named' | null
  error: string | null
  hasToken: boolean
  provider?: 'cloudflare' | 'pinggy' | null
}

function seedH5Tunnel(options: {
  tunnel: TunnelDiagnostics
  hostStatus?: Record<string, unknown> | null
}) {
  vi.spyOn(h5AccessApi, 'tunnelAvailable').mockReturnValue(true)
  if (options.hostStatus !== undefined) {
    vi.spyOn(h5AccessApi, 'getTunnelStatus').mockReturnValue(
      options.hostStatus === null
        ? null
        : Promise.resolve(options.hostStatus as never),
    )
  }
  useSettingsStore.setState({
    locale: 'en',
    h5Access: {
      enabled: true,
      token: 'h5_tunnel_token',
      tokenPreview: 'h5_tunn...oken',
      allowedOrigins: [],
      publicBaseUrl: options.tunnel.url,
      fixedPort: null,
      disconnectGraceSeconds: null,
    },
    h5AccessDiagnostics: {
      storedHostStaleness: 'proxy',
      storedPublicBaseUrl: null,
      effectivePublicBaseUrl: options.tunnel.url,
      suggestedHost: null,
      localInterfaceHosts: [],
      activePort: 3456,
      tunnel: options.tunnel,
    },
  })
}

const runningCloudflare: TunnelDiagnostics = {
  status: 'running',
  url: 'https://abcd.trycloudflare.com',
  mode: 'quick',
  error: null,
  hasToken: false,
  provider: 'cloudflare',
}

function tunnelSection() {
  return within(screen.getByTestId('h5-access-tunnel'))
}

describe('H5AccessSettings tunnel provider + cloudflared download', () => {
  it('shows the current provider reported by the server diagnostics', () => {
    seedH5Tunnel({ tunnel: { ...runningCloudflare, provider: 'pinggy' }, hostStatus: null })
    render(<H5AccessSettings />)
    const provider = tunnelSection().getByTestId('h5-access-tunnel-provider')
    expect(provider).toHaveTextContent('Pinggy')
    // Pinggy is already the backup route, so there is nothing left to switch to.
    expect(tunnelSection().queryByTestId('h5-access-tunnel-switch-route')).toBeNull()
  })

  it('prefers the host-direct provider report and offers the switch-route entry point on Cloudflare', async () => {
    seedH5Tunnel({
      // The server mirror lags behind and still says nothing; the host knows.
      tunnel: { ...runningCloudflare, provider: null },
      hostStatus: { status: 'running', url: 'https://abcd.trycloudflare.com', mode: 'quick', error: null, provider: 'cloudflare' },
    })
    render(<H5AccessSettings />)
    await waitFor(() =>
      expect(tunnelSection().getByTestId('h5-access-tunnel-provider')).toHaveTextContent('Cloudflare'),
    )
    expect(tunnelSection().getByTestId('h5-access-tunnel-switch-route')).toBeInTheDocument()
  })

  it('treats a missing provider as unknown instead of assuming Cloudflare', () => {
    seedH5Tunnel({ tunnel: { ...runningCloudflare, provider: undefined }, hostStatus: null })
    render(<H5AccessSettings />)
    expect(tunnelSection().getByTestId('h5-access-tunnel-provider')).toHaveTextContent('Unknown')
    // Unknown must not offer a downgrade that would be a no-op or a wrong guess.
    expect(tunnelSection().queryByTestId('h5-access-tunnel-switch-route')).toBeNull()
  })

  it('warns that the free Pinggy route expires after 60 minutes', () => {
    seedH5Tunnel({ tunnel: { ...runningCloudflare, provider: 'pinggy' }, hostStatus: null })
    render(<H5AccessSettings />)
    expect(tunnelSection().getByTestId('h5-access-tunnel-pinggy-expiry')).toHaveTextContent('60 minutes')
  })

  it('does not show the Pinggy expiry warning on a Cloudflare tunnel', () => {
    seedH5Tunnel({ tunnel: runningCloudflare, hostStatus: null })
    render(<H5AccessSettings />)
    expect(tunnelSection().queryByTestId('h5-access-tunnel-pinggy-expiry')).toBeNull()
  })

  it('surfaces a reconnecting tunnel with its provider instead of a dead URL', () => {
    seedH5Tunnel({
      tunnel: {
        status: 'reconnecting',
        url: null,
        mode: 'quick',
        error: 'pinggy exited unexpectedly (code=1, signal=null)',
        hasToken: false,
        provider: 'pinggy',
      },
      hostStatus: null,
    })
    render(<H5AccessSettings />)
    // The provider badge survives the degraded state so the user can tell which
    // route died (and that it was the 60-minute-capped one).
    expect(tunnelSection().getByTestId('h5-access-tunnel-provider')).toHaveTextContent('Pinggy')
    expect(tunnelSection().getByTestId('h5-access-tunnel-status')).toHaveTextContent('reconnecting')
    expect(tunnelSection().getByTestId('h5-access-tunnel-pinggy-expiry')).toBeInTheDocument()
  })

  it('stops (does not restart) a tunnel that is reconnecting', async () => {
    seedH5Tunnel({
      tunnel: {
        status: 'reconnecting',
        url: null,
        mode: 'quick',
        error: 'cloudflare exited unexpectedly (code=1, signal=null)',
        hasToken: false,
        provider: 'cloudflare',
      },
      hostStatus: null,
    })
    const stop = vi.spyOn(useSettingsStore.getState(), 'stopH5Tunnel').mockResolvedValue()
    const start = vi.spyOn(useSettingsStore.getState(), 'startH5Tunnel').mockResolvedValue()
    render(<H5AccessSettings />)

    // While reconnecting the toggle must offer Stop — otherwise the only control
    // for a dead tunnel would silently spawn a second one.
    fireEvent.click(tunnelSection().getByTestId('h5-access-tunnel-toggle'))
    await waitFor(() => expect(stop).toHaveBeenCalled())
    expect(start).not.toHaveBeenCalled()
    // Mode is locked so a reconnect cannot be desynced from a mid-flight change.
    expect(tunnelSection().getByLabelText('Tunnel mode')).toBeDisabled()
  })

  it('shows a determinate download progress bar while cloudflared is downloading', async () => {
    seedH5Tunnel({
      tunnel: { status: 'starting', url: null, mode: 'quick', error: null, hasToken: false, provider: 'cloudflare' },
      hostStatus: {
        status: 'starting', url: null, mode: 'quick', error: null, provider: 'cloudflare',
        download: { state: 'downloading', receivedBytes: 1_500, totalBytes: 2_000 },
      },
    })
    render(<H5AccessSettings />)
    const download = await tunnelSection().findByTestId('h5-access-tunnel-download')
    expect(download).toHaveTextContent('75%')
    expect(within(download).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75')
  })

  it('shows an indeterminate download status when the host reports no total size', async () => {
    seedH5Tunnel({
      tunnel: { status: 'starting', url: null, mode: 'quick', error: null, hasToken: false, provider: 'cloudflare' },
      hostStatus: {
        status: 'starting', url: null, mode: 'quick', error: null, provider: 'cloudflare',
        download: { state: 'downloading', receivedBytes: 4_096, totalBytes: null },
      },
    })
    render(<H5AccessSettings />)
    const download = await tunnelSection().findByTestId('h5-access-tunnel-download')
    expect(download).toHaveTextContent('Downloading cloudflared...')
    expect(download).not.toHaveTextContent('%')
    expect(within(download).queryByRole('progressbar')).toBeNull()
  })

  it('shows an actionable hint when the cloudflared download fails', async () => {
    seedH5Tunnel({
      tunnel: { status: 'error', url: null, mode: 'quick', error: 'cloudflared download failed.', hasToken: false, provider: 'cloudflare' },
      hostStatus: {
        status: 'error', url: null, mode: 'quick', error: 'cloudflared download failed.', provider: 'cloudflare',
        download: { state: 'failed', error: 'HTTP 403' },
      },
    })
    render(<H5AccessSettings />)
    const failure = await tunnelSection().findByTestId('h5-access-tunnel-download-error')
    expect(failure).toHaveTextContent('cloudflared download failed.')
    expect(failure).toHaveTextContent('Install cloudflared manually')
  })

  it('hides the switch-route entry point for a named tunnel Pinggy cannot serve', () => {
    seedH5Tunnel({
      tunnel: {
        ...runningCloudflare,
        mode: 'named',
        url: 'https://h5.example.com',
        provider: 'cloudflare',
      },
      hostStatus: null,
    })
    render(<H5AccessSettings />)
    // Named tunnels are Cloudflare-only in the main process, so the downgrade
    // button would only ever produce a failure toast.
    expect(tunnelSection().queryByTestId('h5-access-tunnel-switch-route')).toBeNull()
  })

  it('switches to Pinggy through the api when the phone cannot open the Cloudflare URL', async () => {
    seedH5Tunnel({ tunnel: runningCloudflare, hostStatus: null })
    const switchProvider = vi
      .spyOn(h5AccessApi, 'switchTunnelProvider')
      .mockResolvedValue({ status: 'running', url: 'https://abcd.a.pinggy.link', mode: 'quick', error: null } as never)
    render(<H5AccessSettings />)
    fireEvent.click(tunnelSection().getByTestId('h5-access-tunnel-switch-route'))
    await waitFor(() => expect(switchProvider).toHaveBeenCalledWith('pinggy', { mode: 'quick' }))
  })
})

// TranslationKey already gates compile-time completeness, but a locale can
// import a key and ship an empty or English-copied string, which tsc cannot see.
describe('H5 tunnel i18n contract', () => {
  const LOCALES = ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const
  const KEYS = [
    'settings.general.h5AccessTunnelProvider',
    'settings.general.h5AccessTunnelProviderCloudflare',
    'settings.general.h5AccessTunnelProviderPinggy',
    'settings.general.h5AccessTunnelProviderUnknown',
    'settings.general.h5AccessTunnelSwitchRoute',
    'settings.general.h5AccessTunnelSwitchRouteHint',
    'settings.general.h5AccessTunnelDownloading',
    'settings.general.h5AccessTunnelDownloadFailed',
    'settings.general.h5AccessTunnelDownloadFailedHint',
  ] as const

  it.each(LOCALES)('defines every new tunnel key in %s', (locale) => {
    for (const key of KEYS) {
      const value = translate(locale, key)
      expect(value, `${locale} / ${key}`).not.toBe(key)
      expect(value.trim().length, `${locale} / ${key}`).toBeGreaterThan(0)
    }
  })

  it('interpolates the download percent in every locale', () => {
    for (const locale of LOCALES) {
      const value = translate(locale, 'settings.general.h5AccessTunnelDownloadingProgress', { percent: '42' })
      expect(value, `${locale} dropped the {percent} placeholder`).toContain('42')
    }
  })

  it('leaves no English hardcoding in the provider/route labels', () => {
    // Product names stay literal everywhere; the surrounding copy must not.
    expect(translate('zh', 'settings.general.h5AccessTunnelSwitchRoute')).not.toBe(
      translate('en', 'settings.general.h5AccessTunnelSwitchRoute'),
    )
    expect(translate('jp', 'settings.general.h5AccessTunnelDownloadFailed')).not.toBe(
      translate('en', 'settings.general.h5AccessTunnelDownloadFailed'),
    )
    expect(translate('kr', 'settings.general.h5AccessTunnelDownloadFailedHint')).not.toBe(
      translate('en', 'settings.general.h5AccessTunnelDownloadFailedHint'),
    )
  })
})
