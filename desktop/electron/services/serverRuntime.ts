import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  appendHostDiagnostic,
  clearProxyEnv,
  createAdapterPlan,
  createServerPlan,
  createTunnelPlan,
  ELECTRON_DIAGNOSTICS_FILE_ENV,
  formatStartupError,
  killSidecar,
  POWERSHELL_PATH_OVERRIDE_ENV,
  preferredServerPorts,
  pushStartupLog,
  reserveServerPort,
  resolveCloudflaredPath,
  sanitizeHostDiagnostic,
  SERVER_BIND_HOST,
  SERVER_CONTROL_HOST,
  SERVER_STARTUP_TIMEOUT_MS,
  spawnSidecar,
  spawnTunnel,
  waitForServer,
  waitForTunnelUrl,
  withAdapterProxyBridgeEnv,
  withSystemProxyBridgeEnv,
  withSystemProxyErrorEnv,
  windowsPowerShellOverride,
  writeLastServerPort,
  type H5TunnelMode,
  type SidecarChild,
} from './sidecarManager'
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
}

export type TunnelStatus = {
  status: 'idle' | 'starting' | 'running' | 'error'
  url: string | null
  mode: H5TunnelMode | null
  error: string | null
}

const TUNNEL_HEALTH_INITIAL_DELAY_MS = 15_000
const TUNNEL_HEALTH_INTERVAL_MS = 30_000
const TUNNEL_HEALTH_TIMEOUT_MS = 10_000
const TUNNEL_HEALTH_FAILURE_THRESHOLD = 3

type ServerRuntimeOptions = {
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
  appendHostDiagnostic: typeof appendHostDiagnostic
  now: () => number
  preferredServerPorts: typeof preferredServerPorts
  reserveServerPort: typeof reserveServerPort
  sleep: (delayMs: number) => Promise<void>
  spawnSidecar: typeof spawnSidecar
  waitForServer: typeof waitForServer
  writeLastServerPort: typeof writeLastServerPort
  createSystemProxyBridge: (resolveSystemProxy: (url: string) => Promise<string>) => SystemProxyBridgeLike
}

const DEFAULT_SERVER_RUNTIME_DEPS: ServerRuntimeDeps = {
  appendHostDiagnostic,
  now: Date.now,
  preferredServerPorts,
  reserveServerPort,
  sleep: delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
  spawnSidecar,
  waitForServer,
  writeLastServerPort,
  createSystemProxyBridge: resolveSystemProxy => new SystemProxyBridge(resolveSystemProxy),
}

const AUTOMATIC_RESTART_LIMIT = 3
const AUTOMATIC_RESTART_STABLE_MS = 60_000
const AUTOMATIC_RESTART_COOLDOWN_MS = 60_000
const AUTOMATIC_RESTART_BACKOFF_MS = [0, 250, 1_000] as const

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
  private server: ActiveServer | null = null
  private adapters: SidecarChild[] = []
  private tunnel: { child: SidecarChild, mode: H5TunnelMode } | null = null
  private tunnelState: TunnelStatus = { status: 'idle', url: null, mode: null, error: null }
  private tunnelGeneration = 0
  private tunnelHealthTimer: ReturnType<typeof setTimeout> | null = null
  private tunnelHealthFailures = 0
  private startupError: string | null = null
  private restartAfterExit = false
  private automaticRestartAttempts = 0
  private restartBlockedUntil = 0
  private restartNotBefore = 0
  private startPromise: Promise<string> | null = null
  private lifecycleGeneration = 0
  private startingServer: ServerStartState | null = null
  private adapterRestartPromise: Promise<void> | null = null
  private adapterGeneration = 0

  constructor(options: ServerRuntimeOptions) {
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

  restartAdaptersSidecars(): Promise<void> {
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
    this.stopTunnelProcess(sync)
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
        killSidecar(starting.child, sync)
      }
    }
    this.stopAdaptersSidecars(sync)
    if (this.server) {
      killSidecar(this.server.child, sync)
      this.server = null
    }
    this.stopSystemProxyBridge()
  }

  getTunnelStatus(): TunnelStatus {
    return { ...this.tunnelState }
  }

  /**
   * Start a Cloudflare tunnel and report the resulting public URL to the running
   * H5 server so it becomes the effective publicBaseUrl. Quick mode scrapes the
   * trycloudflare URL from cloudflared's output; named mode uses the user's
   * configured domain (namedUrl) since cloudflared does not print it.
   */
  async startTunnel(options: TunnelStartOptions): Promise<TunnelStatus> {
    const serverUrl = await this.getServerUrl()
    const port = Number(new URL(serverUrl).port) || 0

    // Replace any existing tunnel so a mode switch / restart is clean.
    this.stopTunnelProcess()
    const generation = this.tunnelGeneration
    this.tunnelState = { status: 'starting', url: null, mode: options.mode, error: null }

    const cloudflaredPath = resolveCloudflaredPath()
    if (!cloudflaredPath) {
      this.tunnelState = {
        status: 'error',
        url: null,
        mode: options.mode,
        error: 'cloudflared not found. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
      }
      await this.reportTunnel(serverUrl)
      return this.getTunnelStatus()
    }

    try {
      const env = await this.resolveSidecarBaseEnv()
      if (generation !== this.tunnelGeneration) return this.getTunnelStatus()
      const plan = createTunnelPlan({
        cloudflaredPath,
        port,
        mode: options.mode,
        token: options.token,
        env,
      })
      const child = spawnTunnel(plan)
      this.tunnel = { child, mode: options.mode }
      this.captureLogs(child, `cloudflared:${options.mode}`)
      child.on('exit', (code, signal) => {
        if (generation !== this.tunnelGeneration || this.tunnel?.child !== child) return
        this.clearTunnelHealthTimer()
        this.tunnel = null
        this.tunnelState = {
          status: 'error',
          url: null,
          mode: options.mode,
          error: `cloudflared exited unexpectedly (code=${code}, signal=${signal})`,
        }
        void this.clearTunnelOnServer(serverUrl).then(() => this.reportTunnel(serverUrl))
      })

      let url: string
      if (options.mode === 'named') {
        if (!options.namedUrl) {
          throw new Error('A bound domain (public URL) is required for the named tunnel mode.')
        }
        url = options.namedUrl
      } else {
        url = await waitForTunnelUrl(child)
      }

      if (generation !== this.tunnelGeneration || this.tunnel?.child !== child) {
        if (this.tunnel?.child !== child) killSidecar(child)
        return this.getTunnelStatus()
      }
      this.tunnelState = { status: 'running', url, mode: options.mode, error: null }
      await this.reportTunnel(serverUrl)
      if (options.mode === 'quick') {
        this.scheduleTunnelHealthCheck({ generation, child, serverUrl, tunnelUrl: url })
      }
      return this.getTunnelStatus()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.stopTunnelProcess()
      this.tunnelState = { status: 'error', url: null, mode: options.mode, error: message }
      await this.reportTunnel(serverUrl)
      return this.getTunnelStatus()
    }
  }

  async stopTunnel(): Promise<TunnelStatus> {
    this.stopTunnelProcess()
    this.tunnelState = { status: 'idle', url: null, mode: null, error: null }
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
    this.clearTunnelHealthTimer()
    if (this.tunnel) {
      const child = this.tunnel.child
      this.tunnel = null
      killSidecar(child, sync)
    }
  }

  private clearTunnelHealthTimer() {
    if (this.tunnelHealthTimer !== null) {
      this.clearTimeoutFn(this.tunnelHealthTimer)
      this.tunnelHealthTimer = null
    }
    this.tunnelHealthFailures = 0
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
    if (context.generation !== this.tunnelGeneration || this.tunnel?.child !== context.child) return

    let failureReason: string | null = null
    try {
      const response = await this.fetchFn(new URL('/health', context.tunnelUrl), {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TUNNEL_HEALTH_TIMEOUT_MS),
      })
      if (!response.ok) failureReason = `HTTP ${response.status}`
    } catch {
      // The main-process fetch may not share Electron's system/PAC proxy while
      // cloudflared does. A network error is therefore inconclusive: retry it,
      // but only an actual non-2xx response may tear down a running tunnel.
      if (context.generation === this.tunnelGeneration && this.tunnel?.child === context.child) {
        this.scheduleTunnelHealthCheck(context, TUNNEL_HEALTH_INTERVAL_MS)
      }
      return
    }

    if (context.generation !== this.tunnelGeneration || this.tunnel?.child !== context.child) return
    if (failureReason === null) {
      this.tunnelHealthFailures = 0
    } else {
      this.tunnelHealthFailures += 1
    }

    if (this.tunnelHealthFailures < TUNNEL_HEALTH_FAILURE_THRESHOLD) {
      this.scheduleTunnelHealthCheck(context, TUNNEL_HEALTH_INTERVAL_MS)
      return
    }

    this.clearTunnelHealthTimer()
    this.tunnel = null
    killSidecar(context.child)
    this.tunnelState = {
      status: 'error',
      url: null,
      mode: 'quick',
      error: `Cloudflare tunnel became unreachable after ${TUNNEL_HEALTH_FAILURE_THRESHOLD} consecutive health check failures (${failureReason}).`,
    }
    await this.clearTunnelOnServer(context.serverUrl)
    await this.reportTunnel(context.serverUrl)
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
          error: this.tunnelState.error,
        }),
      })
    } catch (error) {
      console.error('[desktop] failed to report tunnel state to server', error)
    }
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
      this.deps.writeLastServerPort(port, this.baseEnv)
      this.server = {
        url,
        child,
        adapterChildren: startState.adapterChildren,
        startedAt: this.deps.now(),
      }
      const activeServer = this.server
      this.startupError = null
      this.stopAdaptersSidecars()
      await Promise.race([
        this.startAdaptersSidecars(url, startState, activeServer),
        startState.failurePromise,
      ])
      if (startState.failure) throw startState.failure
      return url
    } catch (error) {
      if (startState) {
        this.stopAdaptersForStart(startState)
        if (this.server?.child === startState.child) this.server = null
        if (!startState.childStopped) {
          startState.childStopped = true
          killSidecar(startState.child)
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
    const baseEnv = this.withLocalAccessToken(await this.resolveSidecarBaseEnv())
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
          killSidecar(child)
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
      killSidecar(child, sync)
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
    child.stdout.on('data', chunk => {
      const chunkText = String(chunk)
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
      killSidecar(child, sync)
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
      return applyRuntimeEnv(withSystemProxyBridgeEnv(baseEnv, bridgeUrl))
    } catch (error) {
      if (this.systemProxyBridge === bridge) {
        this.systemProxyBridge = null
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
