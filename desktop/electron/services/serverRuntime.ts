import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { countExternalMigrationProcesses } from '../../../src/server/migrationInventory'
import {
  appendHostDiagnostic,
  claudeConfigDir,
  clearProxyEnv,
  createAdapterPlan,
  createServerPlan,
  ELECTRON_DIAGNOSTICS_FILE_ENV,
  formatStartupError,
  killSidecar,
  POWERSHELL_PATH_OVERRIDE_ENV,
  preferredServerPorts,
  pushStartupLog,
  reserveServerPort,
  sanitizeHostDiagnostic,
  SERVER_BIND_HOST,
  SERVER_CONTROL_HOST,
  SERVER_STARTUP_TIMEOUT_MS,
  spawnSidecar,
  waitForServer,
  withAdapterProxyBridgeEnv,
  withSystemProxyBridgeEnv,
  withSystemProxyErrorEnv,
  windowsPowerShellOverride,
  writeLastServerPort,
  type H5TunnelMode,
  type SidecarChild,
} from './sidecarManager'
import { ensureCloudflaredBinary } from './cloudflaredBinary'
import {
  createCloudflareTunnel,
  createPinggyTunnel,
  type H5TunnelProvider,
  type TunnelProviderInstance,
} from './tunnelProvider'
import { readDesktopTerminalConfig, resolveDesktopTerminalShell } from './terminal'
import {
  SystemProxyBridge,
  type SystemProxyBridgeLike,
} from './systemProxyBridge'

export type TunnelStartOptions = {
  mode: H5TunnelMode
  token?: string | null
  /** Public base URL to report for a named tunnel (the user's bound domain). */
  namedUrl?: string | null
  /**
   * Preferred provider. Omitted keeps the default Cloudflare→Pinggy fallback
   * order; an explicit value pins the tunnel to that provider (used by the
   * manual "switch route" action).
   */
  provider?: H5TunnelProvider
}

/**
 * Progress of the cloudflared auto-download, surfaced to the settings page so a
 * first-run user sees why "start tunnel" is taking a while. Null unless a
 * download is (or just was) in flight.
 */
export type TunnelDownloadStatus = {
  state: 'downloading' | 'failed'
  receivedBytes: number
  /** Null when the mirror/server sends no Content-Length (indeterminate bar). */
  totalBytes: number | null
  error: string | null
}

export type TunnelStatus = {
  status: 'idle' | 'starting' | 'running' | 'reconnecting' | 'error'
  url: string | null
  mode: H5TunnelMode | null
  error: string | null
  provider: H5TunnelProvider | null
  /**
   * Read host-direct by the settings page (it polls getTunnelStatus), never
   * mirrored to the server: the server's tunnel state has no download concept.
   */
  download: TunnelDownloadStatus | null
}

/** How long a single provider may take to produce a public URL. */
const TUNNEL_URL_TIMEOUT_MS = 30_000

const TUNNEL_HEALTH_INITIAL_DELAY_MS = 15_000
const TUNNEL_HEALTH_INTERVAL_MS = 30_000
const TUNNEL_HEALTH_TIMEOUT_MS = 10_000
const TUNNEL_HEALTH_FAILURE_THRESHOLD = 3

/**
 * Reconnect budget for a provider that exits unexpectedly (e.g. the Pinggy free
 * tier's hard 60-minute cap). Backoff is short because the tunnel is a live
 * feature the user is actively looking at; a provider that lived longer than
 * `TUNNEL_RECONNECT_STABLE_MS` earns a fresh budget on its next start.
 */
const TUNNEL_RECONNECT_LIMIT = 3
const TUNNEL_RECONNECT_STABLE_MS = 60_000
const TUNNEL_RECONNECT_BACKOFF_MS = [1_000, 3_000, 8_000] as const

type ServerRuntimeOptions = {
  onServerUnavailable?: () => void
  onServerReady?: () => void
  desktopRoot: string
  appRoot?: string
  h5DistDir?: string
  appVersion?: string
  diagnosticsFile?: string
  env?: NodeJS.ProcessEnv
  deps?: Partial<ServerRuntimeDeps>
  resolveSystemProxy?: (url: string) => Promise<string>
  fetchFn?: typeof fetch
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

type ServerRuntimeDeps = {
  fetch: typeof fetch
  killSidecar: typeof killSidecar
  appendHostDiagnostic: typeof appendHostDiagnostic
  now: () => number
  preferredServerPorts: typeof preferredServerPorts
  reserveServerPort: typeof reserveServerPort
  sleep: (delayMs: number) => Promise<void>
  spawnSidecar: typeof spawnSidecar
  waitForServer: typeof waitForServer
  writeLastServerPort: typeof writeLastServerPort
  createSystemProxyBridge: (resolveSystemProxy: (url: string) => Promise<string>) => SystemProxyBridgeLike
  /**
   * Build an undici dispatcher that routes a request through the userspace proxy
   * bridge, for the *public* tunnel health probe. Returns null when no proxy
   * dispatcher is available, in which case the probe falls back to plain fetch.
   */
  createProxyDispatcher: (proxyUrl: string) => Promise<unknown | null>
  ensureCloudflaredBinary: typeof ensureCloudflaredBinary
  createCloudflareTunnel: typeof createCloudflareTunnel
  createPinggyTunnel: typeof createPinggyTunnel
}

const DEFAULT_SERVER_RUNTIME_DEPS: ServerRuntimeDeps = {
  fetch: (...args) => fetch(...args),
  killSidecar,
  appendHostDiagnostic,
  now: Date.now,
  preferredServerPorts,
  reserveServerPort,
  sleep: delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
  spawnSidecar,
  waitForServer,
  writeLastServerPort,
  createSystemProxyBridge: resolveSystemProxy => new SystemProxyBridge(resolveSystemProxy),
  createProxyDispatcher: createUndiciProxyDispatcher,
  ensureCloudflaredBinary,
  createCloudflareTunnel,
  createPinggyTunnel,
}

type UndiciModule = { ProxyAgent?: new (url: string) => unknown }

// undici is present in the desktop dependency tree but is not a declared direct
// dependency. Load it through a widened specifier so a future install that drops
// it degrades to a direct connection instead of breaking the type-check or
// module load — same policy as the https-proxy-agent import in
// cloudflaredBinary.ts.
let undiciModulePromise: Promise<UndiciModule | null> | null = null
function loadUndiciModule(): Promise<UndiciModule | null> {
  if (!undiciModulePromise) {
    const specifier: string = 'undici'
    undiciModulePromise = import(specifier)
      .then(module => module as unknown as UndiciModule)
      .catch(() => null)
  }
  return undiciModulePromise
}

async function createUndiciProxyDispatcher(proxyUrl: string): Promise<unknown | null> {
  const undici = await loadUndiciModule()
  if (!undici?.ProxyAgent) return null
  try {
    return new undici.ProxyAgent(proxyUrl)
  } catch {
    return null
  }
}

const AUTOMATIC_RESTART_LIMIT = 3
const AUTOMATIC_RESTART_STABLE_MS = 60_000
const AUTOMATIC_RESTART_COOLDOWN_MS = 60_000
const AUTOMATIC_RESTART_BACKOFF_MS = [0, 250, 1_000] as const
const SERVER_SHUTDOWN_TIMEOUT_MS = 15_000
const SERVER_FORCE_EXIT_TIMEOUT_MS = 500

type ServerStartState = {
  child: SidecarChild
  adapterChildren: SidecarChild[]
  childStopped: boolean
  readonly failure: Error | null
  failurePromise: Promise<never>
  fail: (error: Error) => void
}

type ActiveServer = {
  url: string
  child: SidecarChild
  adapterChildren: SidecarChild[]
  startedAt: number
}

function parseWechatAdapterStatus(line: string): {
  platform: 'wechat'
  state: 'rebind_required'
  code: 'session_expired'
} | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>
    if (
      event.type === 'adapter_status' &&
      event.adapter === 'wechat' &&
      event.status === 'session_timeout' &&
      event.code === -14
    ) {
      return {
        platform: 'wechat',
        state: 'rebind_required',
        code: 'session_expired',
      }
    }
  } catch {
    // Normal adapter logs are not structured status events.
  }
  return null
}

function createServerStartState(child: SidecarChild): ServerStartState {
  let failure: Error | null = null
  let rejectFailure!: (error: Error) => void
  const failurePromise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject
  })
  return {
    child,
    adapterChildren: [],
    childStopped: false,
    get failure() {
      return failure
    },
    failurePromise,
    fail(error) {
      if (failure) return
      failure = error
      rejectFailure(error)
    },
  }
}

export class ElectronServerRuntime {
  private readonly onServerUnavailable?: () => void
  private readonly onServerReady?: () => void
  private readonly desktopRoot: string
  private readonly appRoot: string
  private readonly h5DistDir: string
  private readonly appVersion?: string
  private readonly diagnosticsFile?: string
  private readonly baseEnv: NodeJS.ProcessEnv
  private readonly deps: ServerRuntimeDeps
  private readonly resolveSystemProxy?: (url: string) => Promise<string>
  private readonly fetchFn: typeof fetch
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly localAccessToken = randomBytes(32).toString('base64url')
  private readonly petAccessToken = randomBytes(32).toString('base64url')
  private sidecarEnvPromise: Promise<NodeJS.ProcessEnv> | null = null
  private systemProxyBridge: SystemProxyBridgeLike | null = null
  /** Bridge URL cached for the public health probe; cleared with the bridge. */
  private systemProxyBridgeUrl: string | null = null
  private server: ActiveServer | null = null
  private adapters: SidecarChild[] = []
  private tunnel: { instance: TunnelProviderInstance, mode: H5TunnelMode } | null = null
  private tunnelState: TunnelStatus = { status: 'idle', url: null, mode: null, error: null, provider: null, download: null }
  private tunnelGeneration = 0
  private tunnelHealthTimer: ReturnType<typeof setTimeout> | null = null
  private tunnelHealthFailures = 0
  /** Last successful start options, reused to reconnect an exited provider. */
  private tunnelLastOptions: TunnelStartOptions | null = null
  private tunnelReconnectAttempts = 0
  private tunnelReconnectTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Bumped on any user-initiated start/stop. An in-flight reconnect sequence
   * captures this and aborts if it changes, so a pending retry can never
   * resurrect a tunnel the user just stopped. Distinct from `tunnelGeneration`,
   * which the reconnect's own restart bumps on purpose.
   */
  private tunnelReconnectEpoch = 0
  /** When the current provider instance started, for the stable-window reset. */
  private tunnelStartedAt = 0
  /** Cached proxy dispatcher for the public health probe; null until resolved. */
  private tunnelProxyDispatcher: Promise<unknown | null> | null = null
  /**
   * Set once a public health probe succeeds, cleared when a new tunnel starts.
   * A later failure is then known to be a regression of a URL that *was* live,
   * not a probe that never worked — which is what gates recovery below.
   */
  private tunnelExternallyVerified = false
  private startupError: string | null = null
  private restartAfterExit = false
  private automaticRestartAttempts = 0
  private restartBlockedUntil = 0
  private restartNotBefore = 0
  private startPromise: Promise<string> | null = null
  private lifecycleGeneration = 0
  private startingServer: ServerStartState | null = null
  private adapterRestartPromise: Promise<void> | null = null
  private migrationActive = false
  private migrationQuiescence: Promise<void> | null = null
  private migrationQuiesced = false
  private migrationSourceDir: string | null = null
  private readonly inactiveAdapters = new WeakSet<SidecarChild>()
  private adapterGeneration = 0

  constructor(options: ServerRuntimeOptions) {
    this.onServerUnavailable = options.onServerUnavailable
    this.onServerReady = options.onServerReady
    this.desktopRoot = options.desktopRoot
    this.appRoot = options.appRoot ?? options.desktopRoot
    this.h5DistDir = options.h5DistDir ?? path.join(options.desktopRoot, 'dist')
    this.appVersion = options.appVersion
    this.diagnosticsFile = options.diagnosticsFile
    this.baseEnv = options.env ?? process.env
    this.deps = { ...DEFAULT_SERVER_RUNTIME_DEPS, ...options.deps }
    this.resolveSystemProxy = options.resolveSystemProxy
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init))
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  }

  async startServer(): Promise<string> {
    if (this.migrationActive) throw new Error('Data migration is in progress')
    if (this.server) return this.server.url
    if (this.startPromise) return this.startPromise
    this.assertRestartCircuitAllowsStart()

    this.restartAfterExit = false
    const generation = this.lifecycleGeneration
    const restartDelayMs = Math.max(0, this.restartNotBefore - this.deps.now())
    this.startPromise = this.startServerAfterDelay(generation, restartDelayMs)
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async getServerUrl(): Promise<string> {
    if (this.migrationActive) throw new Error('Data migration is in progress')
    if (this.server) return this.server.url
    if (this.startPromise) return await this.startServer()
    this.assertRestartCircuitAllowsStart()
    if (this.startupError && !this.restartAfterExit) throw new Error(this.startupError)
    return await this.startServer()
  }

  getLocalAccessToken(): string {
    return this.localAccessToken
  }

  getPetAccessToken(): string {
    return this.petAccessToken
  }

  getActiveServerUrl(): string | null {
    return this.server?.url ?? null
  }

  getOwnedProcessIds(): number[] {
    return [this.server?.child, this.startingServer?.child, ...this.adapters]
      .map(child => child?.pid).filter((pid): pid is number => typeof pid === 'number' && pid > 0)
  }

  async getMigrationPreview(): Promise<{ activeTasks: number; externalProcesses: number }> {
    if (this.migrationQuiesced) {
      return { activeTasks: 0, externalProcesses: await countExternalMigrationProcesses([], this.migrationSourceDir!) }
    }
    return await this.requestMigrationControl('preview', 'GET') as { activeTasks: number; externalProcesses: number }
  }

  async validateMigrationStartup(): Promise<void> {
    const result = await this.requestMigrationControl('validate', 'GET')
    if (result.valid !== true) throw new Error('Migrated data failed runtime validation')
  }

  async activateAfterMigrationValidation(): Promise<void> {
    const result = await this.requestMigrationControl('activate', 'POST')
    if (result.activated !== true) throw new Error('Migration runtime activation failed')
    delete this.baseEnv.CC_HAHA_MIGRATION_VALIDATION
    this.sidecarEnvPromise = null
    if (this.server) await this.startAdaptersSidecars(this.server.url, undefined, this.server)
  }

  quiesceForMigration(): Promise<void> {
    if (this.migrationQuiescence) return this.migrationQuiescence
    if (!this.server || this.startingServer || this.startPromise) return Promise.reject(new Error('Server startup must finish before migration'))
    this.migrationActive = true
    this.migrationSourceDir = (this.baseEnv.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')).normalize('NFC')
    this.migrationQuiescence = this.quiesceForMigrationOnce()
    return this.migrationQuiescence
  }

  private async quiesceForMigrationOnce(): Promise<void> {
    const server = this.server!
    const result = await this.requestMigrationControl('quiesce', 'POST', server.url)
    if (result.quiesced !== true) throw new Error('Server did not confirm safe migration shutdown')
    await Promise.all([...server.adapterChildren].map(child => quiesceAdapterForMigration(child, this.localAccessToken, () => this.inactiveAdapters.has(child))))
    const exited = waitForSidecarExit(server.child, SERVER_SHUTDOWN_TIMEOUT_MS)
    // Clear ownership before termination so exit listeners cannot restart the server.
    this.onServerUnavailable?.()
    ++this.lifecycleGeneration
    this.server = null
    this.adapters = []
    server.adapterChildren.splice(0)
    this.deps.killSidecar(server.child, process.platform === 'win32')
    if (!await exited) throw new Error('Server process did not exit after migration shutdown')
    this.migrationQuiesced = true
    this.stopSystemProxyBridge()
  }

  async resumeAfterMigration(): Promise<void> {
    if (this.migrationActive && this.server) {
      const result = await this.requestMigrationControl('recover', 'POST')
      if (result.quiesced !== true) throw new Error('Source runtime did not confirm safe recovery shutdown')
      await Promise.all([...this.server.adapterChildren].map(child => quiesceAdapterForMigration(child, this.localAccessToken, () => this.inactiveAdapters.has(child))))
    }
    if (this.server || this.startingServer || this.adapters.length > 0) await this.stopAllAndWait()
    this.migrationActive = false
    this.migrationQuiescence = null
    this.migrationQuiesced = false
    this.migrationSourceDir = null
    this.sidecarEnvPromise = null
    this.startupError = null
    this.restartBlockedUntil = 0
    this.restartAfterExit = false
    await this.startServer()
  }

  private async requestMigrationControl(path: string, method: 'GET' | 'POST', url = this.server?.url): Promise<Record<string, unknown>> {
    if (!url) throw new Error('Server is unavailable')
    const response = await this.deps.fetch(`${url}/api/runtime/migration/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.localAccessToken}` },
      signal: AbortSignal.timeout(60_000),
    })
    const result = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Migration runtime control failed')
    return result
  }

  restartAdaptersSidecars(): Promise<void> {
    if (this.migrationActive || this.baseEnv.CC_HAHA_MIGRATION_VALIDATION === '1') return Promise.reject(new Error('Data migration is in progress'))
    if (this.adapterRestartPromise) return this.adapterRestartPromise
    const operation = this.restartAdaptersSidecarsOnce()
    const tracked = operation.finally(() => {
      if (this.adapterRestartPromise === tracked) this.adapterRestartPromise = null
    })
    this.adapterRestartPromise = tracked
    return tracked
  }

  private async restartAdaptersSidecarsOnce(): Promise<void> {
    const serverUrl = await this.getServerUrl()
    const server = this.server
    if (!server || server.url !== serverUrl) return
    this.stopAdapterChildren(server.adapterChildren)
    await this.startAdaptersSidecars(serverUrl, undefined, server)
  }

  stopAll(sync = false) {
    this.tunnelReconnectEpoch += 1
    this.tunnelLastOptions = null
    this.stopTunnelProcess(sync)
    this.onServerUnavailable?.()
    ++this.lifecycleGeneration
    this.restartNotBefore = 0
    const starting = this.startingServer
    if (starting) {
      this.startingServer = null
      this.stopAdaptersForStart(starting, sync)
      if (this.server?.child === starting.child) this.server = null
      starting.fail(new Error('server startup stopped'))
      if (!starting.childStopped) {
        starting.childStopped = true
        this.deps.killSidecar(starting.child, sync)
      }
    }
    this.stopAdaptersSidecars(sync)
    if (this.server) {
      this.deps.killSidecar(this.server.child, sync)
      this.server = null
    }
    this.stopSystemProxyBridge()
  }

  getTunnelStatus(): TunnelStatus {
    return { ...this.tunnelState }
  }

  /**
   * Start a public tunnel and report the resulting URL to the running H5 server
   * so it becomes the effective publicBaseUrl.
   *
   * Cloudflare (cloudflared) is tried first; any failure — binary unavailable,
   * download failure, spawn failure, no URL within 30s, or an early exit —
   * transparently falls back to Pinggy over the system ssh client. Both
   * providers failing raises an aggregated `Cloudflare: …; Pinggy: …` error and
   * leaves the tunnel in the error state.
   *
   * Quick mode scrapes the public URL from the provider's output; named mode is
   * Cloudflare-only and uses the user's configured domain (namedUrl).
   */
  async startTunnel(options: TunnelStartOptions): Promise<TunnelStatus> {
    // A user-initiated start supersedes any pending reconnect and earns a fresh
    // reconnect budget. Remember the options so an unexpected exit can replay it.
    this.tunnelReconnectEpoch += 1
    this.clearTunnelReconnectTimer()
    this.tunnelReconnectAttempts = 0
    this.tunnelLastOptions = options
    return this.runTunnelStart(options)
  }

  private async runTunnelStart(options: TunnelStartOptions): Promise<TunnelStatus> {
    const epoch = this.tunnelReconnectEpoch
    const serverUrl = await this.getServerUrl()
    // `getServerUrl` can suspend while the server is (re)starting. A pending
    // reconnect's own start does not bump the epoch, so without this re-check a
    // user-initiated stop landing in that window would be overwritten and the
    // tunnel resurrected. (The generation guard below only covers the window
    // after `stopTunnelProcess` has run.)
    if (epoch !== this.tunnelReconnectEpoch) return this.getTunnelStatus()
    const port = Number(new URL(serverUrl).port) || 0

    // Replace any existing tunnel so a mode switch / restart is clean.
    this.stopTunnelProcess()
    const generation = this.tunnelGeneration
    // A fresh tunnel's URL has not served anything yet; re-verify before any
    // failure is allowed to degrade it.
    this.tunnelExternallyVerified = false
    // Reset the stable-window clock: it is only set once the provider is up, so
    // a start that never reaches `running` cannot look like a long-lived one.
    this.tunnelStartedAt = 0
    this.tunnelState = { status: 'starting', url: null, mode: options.mode, error: null, provider: null, download: null }

    const env = await this.resolveSidecarBaseEnv()
    if (generation !== this.tunnelGeneration) return this.getTunnelStatus()

    // The fallback helper owns the running/error state transitions; it publishes
    // the server report before returning, so reading our own state is enough.
    await this.startTunnelWithFallback({ options, generation, port, serverUrl, env })
    return this.getTunnelStatus()
  }

  /**
   * Try the preferred provider, then the fallback. Returns the started instance
   * on success, or null when the attempt was superseded by a newer generation.
   * Throws the aggregated error when every provider fails.
   */
  private async startTunnelWithFallback(context: {
    options: TunnelStartOptions
    generation: number
    port: number
    serverUrl: string
    env: NodeJS.ProcessEnv
  }): Promise<TunnelProviderInstance | null> {
    const { options, generation, port, serverUrl, env } = context
    const providers: H5TunnelProvider[] = options.provider
      ? [options.provider]
      : ['cloudflare', 'pinggy']
    const failures: string[] = []
    // Carried out of the loop so a failed Cloudflare download stays visible in
    // the terminal error state instead of being swallowed by the fallback.
    const downloadRef: { value: TunnelDownloadStatus | null } = { value: null }

    for (const provider of providers) {
      if (generation !== this.tunnelGeneration) return null
      try {
        const instance = await this.startTunnelForProvider(provider, {
          options,
          generation,
          port,
          serverUrl,
          env,
          downloadRef,
        })
        if (generation !== this.tunnelGeneration) {
          await instance.stop().catch(() => {})
          return null
        }
        this.tunnel = { instance, mode: options.mode }
        this.tunnelStartedAt = this.deps.now()
        this.tunnelState = {
          status: 'running',
          url: instance.url,
          mode: options.mode,
          error: null,
          provider: instance.provider,
          download: null,
        }
        await this.reportTunnel(serverUrl)
        if (options.mode === 'quick') {
          this.scheduleTunnelHealthCheck({
            generation,
            child: instance.child,
            serverUrl,
            tunnelUrl: instance.url,
          })
        }
        return instance
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${provider === 'cloudflare' ? 'Cloudflare' : 'Pinggy'}: ${message}`)
      }
    }

    if (generation !== this.tunnelGeneration) return null
    this.stopTunnelProcess()
    this.tunnelState = {
      status: 'error',
      url: null,
      mode: options.mode,
      error: failures.join('; '),
      provider: null,
      // Keep the download failure (if that is what Cloudflare hit) so the
      // settings page can show the actionable "install manually / use a mirror"
      // hint instead of a bare aggregated error.
      download: downloadRef.value,
    }
    await this.reportTunnel(serverUrl)
    return null
  }

  /**
   * Start a single provider's tunnel. Named mode is Cloudflare-only: the domain
   * is bound in Cloudflare, so Pinggy has nothing to report for it.
   */
  private async startTunnelForProvider(provider: H5TunnelProvider, context: {
    options: TunnelStartOptions
    generation: number
    port: number
    serverUrl: string
    env: NodeJS.ProcessEnv
    downloadRef: { value: TunnelDownloadStatus | null }
  }): Promise<TunnelProviderInstance> {
    const { options, generation, port, env } = context
    if (options.mode === 'named' && provider === 'pinggy') {
      throw new Error('Named tunnels require Cloudflare; Pinggy only supports quick tunnels.')
    }

    // Attach log capture at spawn time (the factory consumes the URL line before
    // returning, so a later attach would miss it).
    const onChild = (child: SidecarChild) => this.captureLogs(child, `${provider}:${options.mode}`)

    let instance: TunnelProviderInstance
    if (provider === 'pinggy') {
      instance = await this.deps.createPinggyTunnel({
        port,
        directory: this.pinggyDirectory(),
        env,
        timeoutMs: TUNNEL_URL_TIMEOUT_MS,
        onChild,
      })
    } else {
      const recordDownload = (status: TunnelDownloadStatus | null) => {
        context.downloadRef.value = status
        if (generation === this.tunnelGeneration) {
          this.tunnelState = { ...this.tunnelState, download: status }
        }
      }
      // Only the first-run download is slow enough to be worth a progress bar;
      // a cached binary resolves without ever touching `onProgress`.
      const onProgress = (progress: { receivedBytes: number, totalBytes: number | null }) => {
        if (generation !== this.tunnelGeneration) return
        recordDownload({
          state: 'downloading',
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          error: null,
        })
      }
      // Scope the failure flag to the download itself: a later spawn failure must
      // not be mislabelled as "cloudflared download failed" in the settings UI.
      const resolveBinary = async () => {
        try {
          return await this.deps.ensureCloudflaredBinary({
            cacheDir: claudeConfigDir(this.baseEnv),
            env: this.baseEnv,
            onProgress,
          })
        } catch (error) {
          recordDownload({
            state: 'failed',
            receivedBytes: context.downloadRef.value?.receivedBytes ?? 0,
            totalBytes: context.downloadRef.value?.totalBytes ?? null,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      }
      instance = await this.deps.createCloudflareTunnel({
        port,
        mode: options.mode,
        token: options.token,
        namedUrl: options.namedUrl,
        env,
        timeoutMs: TUNNEL_URL_TIMEOUT_MS,
        onChild,
        resolveBinary,
      })
    }
    // A provider that dies after we publish it must not be reported as running:
    // the exit handler clears the server URL and flips to the error state.
    this.watchProviderExit(instance, { generation, mode: options.mode, serverUrl: context.serverUrl })
    return instance
  }

  /**
   * Attach the unexpected-exit handler to a running provider process. Guarded by
   * generation + instance identity so a stale exit cannot clobber a newer tunnel
   * — and so a user-initiated stop (which bumps the generation first) never
   * triggers a reconnect.
   */
  private watchProviderExit(instance: TunnelProviderInstance, context: {
    generation: number
    mode: H5TunnelMode
    serverUrl: string
  }) {
    instance.child.on('exit', (code, signal) => {
      if (context.generation !== this.tunnelGeneration || this.tunnel?.instance !== instance) return
      this.clearTunnelHealthTimer()
      this.tunnel = null
      const reason = `${instance.provider} exited unexpectedly (code=${code}, signal=${signal})`
      // A provider that had been *healthy* past the stable window (e.g. Pinggy's
      // free 60-minute cap) earns a fresh reconnect budget; a fast crash-loop
      // does not. Require `running`: a tunnel already degraded to `error` by the
      // health probe must not keep resetting its budget and retry forever.
      if (this.tunnelState.status === 'running'
        && this.deps.now() - this.tunnelStartedAt >= TUNNEL_RECONNECT_STABLE_MS) {
        this.tunnelReconnectAttempts = 0
      }
      this.scheduleTunnelReconnect({
        mode: context.mode,
        serverUrl: context.serverUrl,
        provider: instance.provider,
        reason,
      })
    })
  }

  /**
   * Reconnect an unexpectedly-exited tunnel with a short backoff. Keeps
   * `provider` populated so the settings page can explain *which* route died
   * (notably Pinggy's 60-minute cap). Gives up after
   * `TUNNEL_RECONNECT_LIMIT` attempts and settles into the terminal error state.
   */
  private scheduleTunnelReconnect(context: {
    mode: H5TunnelMode
    serverUrl: string
    provider: H5TunnelProvider
    reason: string
  }) {
    const options = this.tunnelLastOptions
    const attempt = this.tunnelReconnectAttempts
    if (!options || attempt >= TUNNEL_RECONNECT_LIMIT) {
      this.tunnelState = {
        status: 'error',
        url: null,
        mode: context.mode,
        error: context.reason,
        provider: context.provider,
        download: null,
      }
      void this.clearTunnelOnServer(context.serverUrl).then(() => this.reportTunnel(context.serverUrl))
      return
    }

    this.tunnelReconnectAttempts = attempt + 1
    const delayMs = TUNNEL_RECONNECT_BACKOFF_MS[Math.min(attempt, TUNNEL_RECONNECT_BACKOFF_MS.length - 1)]!
    this.tunnelState = {
      status: 'reconnecting',
      url: null,
      mode: context.mode,
      error: context.reason,
      provider: context.provider,
      download: null,
    }
    // Report the degraded state now; the successful reconnect re-reports running.
    void this.clearTunnelOnServer(context.serverUrl).then(() => this.reportTunnel(context.serverUrl))

    const epoch = this.tunnelReconnectEpoch
    this.clearTunnelReconnectTimer()
    this.tunnelReconnectTimer = this.setTimeoutFn(() => {
      this.tunnelReconnectTimer = null
      if (epoch !== this.tunnelReconnectEpoch) return
      // Reuse the original options (provider pin included) so a manual route
      // switch is honoured on reconnect.
      void this.runTunnelStart(options).then(status => {
        if (epoch !== this.tunnelReconnectEpoch) return
        if (status.status === 'running') return
        // The provider could not come back (start failed, or it crashed again);
        // keep retrying until the budget is spent.
        this.scheduleTunnelReconnect(context)
      }).catch(() => {
        if (epoch !== this.tunnelReconnectEpoch) return
        this.scheduleTunnelReconnect(context)
      })
    }, delayMs)
    this.tunnelReconnectTimer.unref?.()
  }

  private clearTunnelReconnectTimer() {
    if (this.tunnelReconnectTimer !== null) {
      this.clearTimeoutFn(this.tunnelReconnectTimer)
      this.tunnelReconnectTimer = null
    }
  }

  /** Directory holding the Pinggy identity key + known-hosts, beside the cloudflared cache. */
  private pinggyDirectory(): string {
    return path.join(claudeConfigDir(this.baseEnv), 'pinggy')
  }

  async stopTunnel(): Promise<TunnelStatus> {
    // User-initiated stop: cancel any in-flight reconnect for good.
    this.tunnelReconnectEpoch += 1
    this.tunnelReconnectAttempts = 0
    this.tunnelLastOptions = null
    this.stopTunnelProcess()
    this.tunnelState = { status: 'idle', url: null, mode: null, error: null, provider: null, download: null }
    if (this.server) {
      // Use /tunnel/clear, NOT /tunnel/report — the report handler treats a
      // missing/null url as "don't touch" (so a status-only heartbeat can't
      // accidentally wipe a live URL). To truly clear the server-side runtime
      // override after the user stops the tunnel, we have to call the explicit
      // clear endpoint. Reporting idle without clearing leaves the old URL as
      // the effective publicBaseUrl, so phones bookmark a dead address (CF 1033).
      await this.clearTunnelOnServer(this.server.url)
    }
    return this.getTunnelStatus()
  }

  private stopTunnelProcess(sync = false) {
    this.tunnelGeneration += 1
    // Cancel any pending reconnect. The epoch is bumped only by user-initiated
    // actions (see startTunnel/stopTunnel/stopAll); an internal restart during a
    // reconnect must NOT bump it, or the retry chain would cancel itself.
    this.clearTunnelReconnectTimer()
    this.clearTunnelHealthTimer()
    this.tunnelExternallyVerified = false
    this.tunnelStartedAt = 0
    if (this.tunnel) {
      const instance = this.tunnel.instance
      this.tunnel = null
      if (sync) killSidecar(instance.child, true)
      else void instance.stop().catch(() => {})
    }
  }

  private clearTunnelHealthTimer() {
    if (this.tunnelHealthTimer !== null) {
      this.clearTimeoutFn(this.tunnelHealthTimer)
      this.tunnelHealthTimer = null
    }
    this.tunnelHealthFailures = 0
  }

  /**
   * Probe the *public* tunnel URL. Node's global fetch does not honor
   * HTTP(S)_PROXY, so on a machine behind a system proxy the plain probe can
   * never reach the public host — the health check would be permanently
   * inconclusive. When the userspace bridge is up, route the probe through it
   * with an undici dispatcher; otherwise fall back to the injected fetch.
   *
   * Only ever used for the public URL — the loopback report/clear calls must
   * stay direct.
   */
  private async probePublicTunnelUrl(input: URL, init: RequestInit): Promise<Response> {
    const proxyUrl = this.systemProxyBridgeUrl
    if (!proxyUrl) return this.fetchFn(input, init)
    if (!this.tunnelProxyDispatcher) {
      this.tunnelProxyDispatcher = this.deps.createProxyDispatcher(proxyUrl)
    }
    let dispatcher: unknown | null = null
    try {
      dispatcher = await this.tunnelProxyDispatcher
    } catch {
      dispatcher = null
    }
    if (!dispatcher) return this.fetchFn(input, init)
    // `dispatcher` is an undici extension absent from the DOM RequestInit type.
    return this.fetchFn(input, { ...init, dispatcher } as RequestInit)
  }

  private scheduleTunnelHealthCheck(context: {
    generation: number
    child: SidecarChild
    serverUrl: string
    tunnelUrl: string
  }, delayMs = TUNNEL_HEALTH_INITIAL_DELAY_MS) {
    this.tunnelHealthTimer = this.setTimeoutFn(
      () => this.checkTunnelHealth(context),
      delayMs,
    )
    this.tunnelHealthTimer.unref?.()
  }

  private async checkTunnelHealth(context: {
    generation: number
    child: SidecarChild
    serverUrl: string
    tunnelUrl: string
  }): Promise<void> {
    if (context.generation !== this.tunnelGeneration || this.tunnel?.instance.child !== context.child) return

    let failureReason: string | null = null
    try {
      const response = await this.probePublicTunnelUrl(new URL('/health', context.tunnelUrl), {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TUNNEL_HEALTH_TIMEOUT_MS),
      })
      // A proxy that cannot reach the tunnel edge answers with a gateway error
      // rather than throwing. That is a proxy condition, not evidence the tunnel
      // is down, so treat it like the transport-error path below and stay
      // inconclusive — otherwise a proxy outage would tear down a healthy tunnel.
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        if (context.generation === this.tunnelGeneration && this.tunnel?.instance.child === context.child) {
          this.scheduleTunnelHealthCheck(context, TUNNEL_HEALTH_INTERVAL_MS)
        }
        return
      }
      if (!response.ok) failureReason = `HTTP ${response.status}`
    } catch {
      // The probe failed at the transport layer. On a machine behind a system
      // proxy the main-process fetch cannot reach the public URL at all, so a
      // network error is inconclusive: retry it, but only an actual non-2xx
      // response may tear down a running tunnel.
      if (context.generation === this.tunnelGeneration && this.tunnel?.instance.child === context.child) {
        this.scheduleTunnelHealthCheck(context, TUNNEL_HEALTH_INTERVAL_MS)
      }
      return
    }

    if (context.generation !== this.tunnelGeneration || this.tunnel?.instance.child !== context.child) return
    const wasDegraded = this.tunnelState.status === 'error'
    if (failureReason === null) {
      this.tunnelHealthFailures = 0
      this.tunnelExternallyVerified = true
      // A URL that answered before and answers again is healthy — including
      // when the edge reconnected after a transient outage. Coming back from
      // `error` re-publishes the URL so the settings page and the server
      // mirror stop reporting a tunnel that is in fact serving again.
      if (wasDegraded) {
        this.tunnelState = {
          status: 'running',
          url: context.tunnelUrl,
          mode: this.tunnelState.mode ?? 'quick',
          error: null,
          provider: this.tunnelState.provider ?? this.tunnel?.instance.provider ?? null,
          download: this.tunnelState.download,
        }
        await this.reportTunnel(context.serverUrl)
      }
    } else {
      this.tunnelHealthFailures += 1
    }

    if (this.tunnelHealthFailures < TUNNEL_HEALTH_FAILURE_THRESHOLD) {
      this.scheduleTunnelHealthCheck(context, TUNNEL_HEALTH_INTERVAL_MS)
      return
    }

    // The probe failed a URL that had already served traffic. cloudflared
    // reconnects its edge on its own, and only the process exiting means the
    // tunnel is truly gone — so degrade the *status* while leaving the process
    // alive, and keep probing. Killing it here would strand a tunnel that
    // recovers seconds later on a dead address the user then has to restart by
    // hand. A probe that never succeeded (`!tunnelExternallyVerified`) is more
    // likely a client-side limitation than a real outage, so it stays advisory
    // and does not flip the state at all.
    if (!this.tunnelExternallyVerified) {
      this.scheduleTunnelHealthCheck(context, TUNNEL_HEALTH_INTERVAL_MS)
      return
    }
    this.tunnelState = {
      status: 'error',
      url: null,
      mode: this.tunnelState.mode ?? 'quick',
      error: `Cloudflare tunnel is not answering after ${TUNNEL_HEALTH_FAILURE_THRESHOLD} consecutive health check failures (${failureReason}). It will keep retrying.`,
      provider: null,
      download: this.tunnelState.download,
    }
    await this.clearTunnelOnServer(context.serverUrl)
    await this.reportTunnel(context.serverUrl)
    // Keep the process and the schedule: this is a state, not a teardown.
    this.scheduleTunnelHealthCheck(context, TUNNEL_HEALTH_INTERVAL_MS)
  }

  /** Wipe the server-side runtime tunnel override after the tunnel is stopped. */
  private async clearTunnelOnServer(serverUrl: string): Promise<void> {
    try {
      await this.fetchFn(`${serverUrl}/api/h5-access/tunnel/clear`, {
        method: 'POST',
        headers: this.localServerHeaders(),
      })
    } catch (error) {
      console.error('[desktop] failed to clear tunnel state on server', error)
    }
  }

  /** Push the current tunnel state into the server's runtime override. */
  private async reportTunnel(serverUrl: string): Promise<void> {
    try {
      await this.fetchFn(`${serverUrl}/api/h5-access/tunnel/report`, {
        method: 'POST',
        headers: this.localServerHeaders(),
        body: JSON.stringify({
          url: this.tunnelState.url,
          status: this.tunnelState.status,
          mode: this.tunnelState.mode ?? undefined,
          provider: this.tunnelState.provider ?? undefined,
          error: this.tunnelState.error,
        }),
      })
    } catch (error) {
      console.error('[desktop] failed to report tunnel state to server', error)
    }
  }

  async stopAllAndWait(timeoutMs = SERVER_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    const serverChildren = new Set<SidecarChild>()
    for (const child of this.adapters) serverChildren.add(child)
    if (this.startingServer) serverChildren.add(this.startingServer.child)
    if (this.server) serverChildren.add(this.server.child)
    const exitWaits = new Map(
      [...serverChildren].map(child => [child, waitForSidecarExit(child, timeoutMs)]),
    )

    this.stopAll(process.platform === 'win32')

    const results = await Promise.all(
      [...exitWaits].map(async ([child, exited]) => ({ child, exited: await exited })),
    )
    const stillRunning = results.filter(result => !result.exited).map(result => result.child)
    if (stillRunning.length === 0) return

    for (const child of stillRunning) {
      if (process.platform === 'win32') this.deps.killSidecar(child, true)
      else child.kill('SIGKILL')
    }
    const forced = await Promise.all(
      stillRunning.map(child => waitForSidecarExit(child, SERVER_FORCE_EXIT_TIMEOUT_MS)),
    )
    if (forced.some(exited => !exited)) throw new Error('Runtime processes did not exit')
  }


  private async startServerAfterDelay(generation: number, delayMs: number): Promise<string> {
    if (delayMs > 0) await this.deps.sleep(delayMs)
    this.assertCurrentGeneration(generation)
    return await this.startServerOnce(generation)
  }

  private async startServerOnce(generation: number): Promise<string> {
    // Prefer the configured fixed port, then the previous run's port, so
    // phone bookmarks / QR codes / reverse proxies survive restarts (#767).
    const port = await this.deps.reserveServerPort(
      SERVER_BIND_HOST,
      this.deps.preferredServerPorts(this.baseEnv),
    )
    const url = `http://${SERVER_CONTROL_HOST}:${port}`
    const logs: string[] = []
    let startState: ServerStartState | null = null
    const env = this.withServerAccessTokens(await this.resolveSidecarBaseEnv())
    this.assertCurrentGeneration(generation)
    const plan = createServerPlan({
      desktopRoot: this.desktopRoot,
      appRoot: this.appRoot,
      port,
      h5DistDir: this.h5DistDir,
      env: this.diagnosticsFile
        ? { ...env, [ELECTRON_DIAGNOSTICS_FILE_ENV]: this.diagnosticsFile }
        : env,
    })

    try {
      const child = this.deps.spawnSidecar(plan)
      startState = createServerStartState(child)
      this.startingServer = startState
      this.captureLogs(child, 'claude-server', logs, (code, signal) => {
        this.handleServerExit(child, code, signal, logs)
      }, error => {
        this.handleServerError(child, error, logs)
      })
      await Promise.race([
        this.deps.waitForServer(SERVER_CONTROL_HOST, port, SERVER_STARTUP_TIMEOUT_MS),
        startState.failurePromise,
      ])
      if (startState.failure) throw startState.failure
      if (this.baseEnv.CC_HAHA_MIGRATION_VALIDATION !== '1') this.deps.writeLastServerPort(port, this.baseEnv)
      this.server = {
        url,
        child,
        adapterChildren: startState.adapterChildren,
        startedAt: this.deps.now(),
      }
      const activeServer = this.server
      this.startupError = null
      this.stopAdaptersSidecars()
      if (this.baseEnv.CC_HAHA_MIGRATION_VALIDATION !== '1') {
        await Promise.race([
          this.startAdaptersSidecars(url, startState, activeServer),
          startState.failurePromise,
        ])
      }
      if (startState.failure) throw startState.failure
      this.onServerReady?.()
      return url
    } catch (error) {
      if (startState) {
        this.stopAdaptersForStart(startState)
        if (this.server?.child === startState.child) this.server = null
        if (!startState.childStopped) {
          startState.childStopped = true
          this.deps.killSidecar(startState.child)
        }
      }
      if (startState?.failure) {
        throw new Error(this.startupError ?? startState.failure.message)
      }
      const message = error instanceof Error ? error.message : String(error)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[claude-server] [startup-error] ${message}`)
      this.startupError = formatStartupError(message, logs)
      throw new Error(this.startupError)
    } finally {
      if (this.startingServer === startState) this.startingServer = null
    }
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.lifecycleGeneration) throw new Error('server startup stopped')
  }

  private async startAdaptersSidecars(
    serverUrl: string,
    startState?: ServerStartState,
    activeServer?: ActiveServer,
  ): Promise<void> {
    const generation = ++this.adapterGeneration
    const baseEnv: NodeJS.ProcessEnv = { ...this.withLocalAccessToken(await this.resolveSidecarBaseEnv()), CC_HAHA_MIGRATION_CONTROL: '1' }
    const bridgeUrl = baseEnv.CC_HAHA_SYSTEM_PROXY_URL
    const env = bridgeUrl
      ? withAdapterProxyBridgeEnv(baseEnv, bridgeUrl)
      : baseEnv
    const isCurrentGeneration = () => {
      if (startState?.failure) return false
      if (activeServer && this.server !== activeServer) return false
      return true
    }
    if (!isCurrentGeneration()) return
    void this.publishAdapterRuntimeStatus(serverUrl, {
      platform: 'wechat',
      state: 'starting',
      generation,
    })
    const ownedAdapters = startState?.adapterChildren
      ?? activeServer?.adapterChildren
    for (const [label, flag] of [
      ['feishu', '--feishu'],
      ['telegram', '--telegram'],
      ['wechat', '--wechat'],
      ['dingtalk', '--dingtalk'],
      ['whatsapp', '--whatsapp'],
      ['wecom', '--wecom'],
      ['qq', '--qq'],
      ['slack', '--slack'],
    ] as const) {
      if (!isCurrentGeneration()) break
      try {
        const child = this.deps.spawnSidecar(createAdapterPlan({
          desktopRoot: this.desktopRoot,
          appRoot: this.appRoot,
          h5DistDir: this.h5DistDir,
          serverUrl,
          flag,
          env,
        }))
        if (!isCurrentGeneration()) {
          this.deps.killSidecar(child)
          break
        }
        this.captureLogs(
          child,
          `claude-adapters:${label}`,
          undefined,
          undefined,
          undefined,
          label === 'wechat'
            ? line => {
                if (!isCurrentGeneration() || generation !== this.adapterGeneration) return
                const status = parseWechatAdapterStatus(line)
                if (!status) return
                void this.publishAdapterRuntimeStatus(serverUrl, {
                  ...status,
                  generation,
                })
              }
            : undefined,
        )
        this.adapters.push(child)
        ownedAdapters?.push(child)
      } catch (error) {
        console.error(`[desktop] failed to start ${label} adapter sidecar`, error)
      }
    }
  }

  private async publishAdapterRuntimeStatus(
    serverUrl: string,
    status: {
      platform: 'wechat'
      state: 'starting' | 'rebind_required'
      code?: 'session_expired'
      generation: number
    },
  ): Promise<void> {
    try {
      const response = await this.fetchFn(`${serverUrl}/api/adapters/runtime-status`, {
        method: 'POST',
        headers: this.localServerHeaders(),
        body: JSON.stringify(status),
      })
      if (!response.ok && response.status !== 409) {
        console.error(`[desktop] failed to publish adapter runtime status (${response.status})`)
      }
    } catch (error) {
      console.error('[desktop] failed to publish adapter runtime status', error)
    }
  }

  private stopAdaptersSidecars(sync = false) {
    const children = this.adapters.splice(0)
    this.removeOwnedAdapters(this.server?.adapterChildren, children)
    this.removeOwnedAdapters(this.startingServer?.adapterChildren, children)
    for (const child of children) {
      this.deps.killSidecar(child, sync)
    }
  }

  private withLocalAccessToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...env,
      CC_HAHA_LOCAL_ACCESS_TOKEN: this.localAccessToken,
    }
  }

  private withServerAccessTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...this.withLocalAccessToken(env),
      CC_HAHA_PET_ACCESS_TOKEN: this.petAccessToken,
    }
  }

  private localServerHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.localAccessToken}`,
    }
  }

  private removeOwnedAdapters(owned: SidecarChild[] | undefined, removed: SidecarChild[]) {
    if (!owned?.length || !removed.length) return
    const removedSet = new Set(removed)
    const retained = owned.filter(child => !removedSet.has(child))
    owned.splice(0, owned.length, ...retained)
  }

  private stopAdaptersForStart(startState: ServerStartState, sync = false) {
    this.stopAdapterChildren(startState.adapterChildren, sync)
  }

  private captureLogs(
    child: SidecarChild,
    label: string,
    startupLogs?: string[],
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
    onError?: (error: Error) => void,
    onStdoutLine?: (line: string) => void,
  ) {
    let stdoutBuffer = ''
    const emitStdoutLines = (chunk: string, flush = false) => {
      if (!onStdoutLine) return
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      if (flush && stdoutBuffer) {
        lines.push(stdoutBuffer)
        stdoutBuffer = ''
      }
      for (const line of lines) {
        if (line.trim()) onStdoutLine(line.trim())
      }
    }
    let adapterControlBuffer = ''
    child.stdout.on('data', chunk => {
      const chunkText = String(chunk)
      if (label.startsWith('claude-adapters:')) {
        adapterControlBuffer = (adapterControlBuffer + chunkText).slice(-16_384)
        const controlLines = adapterControlBuffer.split('\n')
        adapterControlBuffer = controlLines.pop() ?? ''
        for (const entry of controlLines) {
          try {
            if (JSON.parse(entry)?.type === 'migration_adapter_inactive') this.inactiveAdapters.add(child)
          } catch { /* Platform log output is not a control marker. */ }
        }
      }
      emitStdoutLines(chunkText)
      const line = chunkText.trimEnd()
      if (!line) return
      console.log(`[${label}] ${line}`)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[${label}] [stdout] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[stdout] ${line}`)
    })
    child.stderr.on('data', chunk => {
      const line = String(chunk).trimEnd()
      if (!line) return
      console.error(`[${label}] ${line}`)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[${label}] [stderr] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[stderr] ${line}`)
    })
    child.on('exit', (code, signal) => {
      emitStdoutLines('', true)
      const line = `sidecar exited (code=${code}, signal=${signal})`
      console.log(`[${label}] ${line}`)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[${label}] [exit] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[exit] ${line}`)
      onExit?.(code, signal)
    })
    child.on('error', error => {
      const message = error instanceof Error ? error.message : String(error)
      const line = `sidecar process error: ${message}`
      console.error(`[${label}] ${sanitizeHostDiagnostic(line)}`)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[${label}] [process-error] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[process-error] ${line}`)
      onError?.(error instanceof Error ? error : new Error(message))
    })
  }

  private handleServerExit(
    child: SidecarChild,
    code: number | null,
    signal: NodeJS.Signals | null,
    logs: string[],
  ) {
    this.handleServerFailure(
      child,
      `server sidecar exited after spawn (code=${code}, signal=${signal})`,
      logs,
    )
  }

  private handleServerError(child: SidecarChild, error: Error, logs: string[]) {
    this.handleServerFailure(
      child,
      `server sidecar process error after spawn: ${sanitizeHostDiagnostic(error.message)}`,
      logs,
    )
  }

  private handleServerFailure(child: SidecarChild, message: string, logs: string[]) {
    const active = this.server?.child === child
    const starting = this.startingServer?.child === child
    if (!active && !starting) return
    if (this.migrationActive) {
      if (active) this.server = null
      return
    }
    this.onServerUnavailable?.()
    const failedServer = active ? this.server : null
    if (active) {
      const adapterChildren = this.server!.adapterChildren
      this.server = null
      this.stopAdapterChildren(adapterChildren)
    }
    this.restartAfterExit = true
    this.startupError = formatStartupError(message, logs)
    if (starting) this.startingServer?.fail(new Error(message))
    if (failedServer && !starting) {
      const now = this.deps.now()
      if (now - failedServer.startedAt >= AUTOMATIC_RESTART_STABLE_MS) {
        this.automaticRestartAttempts = 0
      }
      if (this.automaticRestartAttempts >= AUTOMATIC_RESTART_LIMIT) {
        this.openAutomaticRestartCircuit(message, logs, now)
        return
      }
      const attempt = ++this.automaticRestartAttempts
      const backoffMs = AUTOMATIC_RESTART_BACKOFF_MS[attempt - 1] ?? 0
      this.restartNotBefore = now + backoffMs
      const restartGeneration = this.lifecycleGeneration
      void this.startServer().catch((error) => {
        if (this.lifecycleGeneration === restartGeneration) {
          // Keep a later renderer recovery request eligible to retry if this
          // immediate restart lost a port-release race or failed transiently.
          this.restartAfterExit = true
        }
        const detail = sanitizeHostDiagnostic(error instanceof Error ? error.message : String(error))
        console.error(`[desktop] failed to restart server sidecar after exit: ${detail}`)
      })
    }
  }

  private openAutomaticRestartCircuit(message: string, logs: string[], now: number) {
    this.restartAfterExit = false
    this.restartNotBefore = 0
    this.restartBlockedUntil = now + AUTOMATIC_RESTART_COOLDOWN_MS
    const circuitMessage = `automatic restart paused after ${AUTOMATIC_RESTART_LIMIT} consecutive crashes; retry in ${AUTOMATIC_RESTART_COOLDOWN_MS / 1_000} seconds`
    this.startupError = formatStartupError(`${message}; ${circuitMessage}`, logs)
    this.deps.appendHostDiagnostic(
      this.diagnosticsFile,
      `[claude-server] [restart-circuit-open] ${circuitMessage}`,
    )
    console.error(`[desktop] ${circuitMessage}`)
  }

  private assertRestartCircuitAllowsStart() {
    if (this.restartBlockedUntil === 0) return
    if (this.deps.now() < this.restartBlockedUntil) {
      throw new Error(this.startupError ?? 'automatic restart paused')
    }
    this.restartBlockedUntil = 0
    this.automaticRestartAttempts = 0
    this.restartAfterExit = true
  }

  private stopAdapterChildren(children: SidecarChild[], sync = false) {
    for (const child of children.splice(0)) {
      const index = this.adapters.indexOf(child)
      if (index >= 0) this.adapters.splice(index, 1)
      this.deps.killSidecar(child, sync)
    }
  }

  private async resolveSidecarBaseEnv(): Promise<NodeJS.ProcessEnv> {
    this.sidecarEnvPromise ??= this.resolveSidecarBaseEnvOnce()
    return await this.sidecarEnvPromise
  }

  private async resolveSidecarBaseEnvOnce(): Promise<NodeJS.ProcessEnv> {
    const applyRuntimeEnv = (env: NodeJS.ProcessEnv) =>
      this.applyDesktopRuntimeEnv(this.applyPowerShellOverride(env))
    const baseEnv = clearProxyEnv(this.baseEnv)
    if (!this.resolveSystemProxy) return applyRuntimeEnv(baseEnv)

    const bridge = this.deps.createSystemProxyBridge(this.resolveSystemProxy)
    this.systemProxyBridge = bridge
    try {
      const bridgeUrl = await bridge.start()
      if (this.systemProxyBridge !== bridge) {
        throw new Error('system proxy bridge startup was stopped')
      }
      // Remember the URL so the public tunnel health probe can route through
      // the same bridge the sidecars use.
      this.systemProxyBridgeUrl = bridgeUrl
      this.tunnelProxyDispatcher = null
      return applyRuntimeEnv(withSystemProxyBridgeEnv(baseEnv, bridgeUrl))
    } catch (error) {
      if (this.systemProxyBridge === bridge) {
        this.systemProxyBridge = null
        this.systemProxyBridgeUrl = null
        this.tunnelProxyDispatcher = null
        await bridge.stop().catch(() => {})
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[desktop] failed to start system proxy bridge for sidecars: ${sanitizeHostDiagnostic(message)}`)
      return applyRuntimeEnv(withSystemProxyErrorEnv(baseEnv, error))
    }
  }

  private applyDesktopRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!this.appVersion) return env
    return {
      ...env,
      APP_VERSION: this.appVersion,
      CC_HAHA_DESKTOP_VERSION: this.appVersion,
    }
  }

  private stopSystemProxyBridge(): void {
    const bridge = this.systemProxyBridge
    this.systemProxyBridge = null
    this.systemProxyBridgeUrl = null
    this.tunnelProxyDispatcher = null
    this.sidecarEnvPromise = null
    if (bridge) void bridge.stop()
  }

  // On Windows, forward the user's chosen PowerShell to the agent sidecar so its
  // PowerShellTool honors the same shell as the UI terminal (regression from the
  // Tauri build, where this lived in src-tauri/src/lib.rs). Best-effort: never
  // block sidecar startup, and never override an explicitly set env var.
  private applyPowerShellOverride(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (process.platform !== 'win32' || env[POWERSHELL_PATH_OVERRIDE_ENV]) return env
    try {
      const shell = resolveDesktopTerminalShell('win32', readDesktopTerminalConfig(env))
      const override = windowsPowerShellOverride(shell, 'win32')
      if (override) return { ...env, [POWERSHELL_PATH_OVERRIDE_ENV]: override }
    } catch {
      // Misconfigured custom shell etc. — fall through to the unmodified env.
    }
    return env
  }
}

async function quiesceAdapterForMigration(child: SidecarChild, token: string, isInactive: () => boolean): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return
  if (!child.stdin) throw new Error('Adapter has no graceful migration control channel')
  const requestId = randomBytes(16).toString('hex')
  const exited = waitForSidecarExit(child, SERVER_SHUTDOWN_TIMEOUT_MS)
  let buffer = ''
  let remove = () => {}
  let failControl = () => {}
  const acknowledged = isInactive() ? Promise.resolve(true) : new Promise<boolean>(resolve => {
    const finish = (value: boolean) => {
      remove()
      resolve(value)
    }
    // A credential-gated sidecar can close stdin before its inactive marker
    // reaches stdout. Keep waiting for that marker and positive process exit.
    failControl = () => {}
    const onData = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-16_384)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (message.type === 'migration_adapter_inactive') finish(true)
          if (message.requestId === requestId && message.type === 'migration_quiesced') finish(true)
          if (message.requestId === requestId && message.type === 'migration_quiesce_failed') finish(false)
        } catch { /* Ordinary sidecar logs are not control acknowledgements. */ }
      }
    }
    const timer = setTimeout(() => finish(false), SERVER_SHUTDOWN_TIMEOUT_MS)
    remove = () => {
      clearTimeout(timer)
      child.stdout.removeListener('data', onData)
      child.stdin?.removeListener('error', failControl)
    }
    child.stdout.on('data', onData)
    child.stdin!.on('error', failControl)
  })
  try {
    if (!isInactive()) {
      child.stdin.write(JSON.stringify({ type: 'migration_quiesce', requestId, token }) + '\n', error => {
        if (error) failControl()
      })
    }
  } catch {
    failControl()
  }
  const [ack, didExit] = await Promise.all([acknowledged, exited])
  remove()
  if (!ack || !didExit || (child.exitCode != null && child.exitCode !== 0)) throw new Error('Adapter did not confirm a clean migration shutdown')
}

function waitForSidecarExit(child: SidecarChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true)

  return new Promise(resolve => {
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const onError = () => finish(child.exitCode != null || child.signalCode != null)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}
