import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { SidecarChild, SidecarPlan } from './sidecarManager'
import { ElectronServerRuntime } from './serverRuntime'

async function runIsolated(script: string) {
  const child = spawn('bun', ['-e', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', code => resolve(code))
  })
  return { stdout, stderr, exitCode }
}

const harness = String.raw`
  import { mock } from 'bun:test'
  import { EventEmitter } from 'node:events'

  function assert(condition, message) {
    if (!condition) throw new Error(message)
  }

  function assertEqual(actual, expected, message) {
    const actualJson = JSON.stringify(actual)
    const expectedJson = JSON.stringify(expected)
    if (actualJson !== expectedJson) {
      throw new Error(message + '\nExpected: ' + expectedJson + '\nReceived: ' + actualJson)
    }
  }

  const state = {
    serverChild: null,
    tunnelChildren: [],
    reportPayloads: [],
    serverPlans: [],
    fetchCalls: [],
    fetchMock: null,
    killedTunnelChildren: [],
  }

  function makeChild(pid) {
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid,
    })
  }

  async function waitForTunnelChild(index, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (state.tunnelChildren.length <= index) {
      if (Date.now() > deadline) throw new Error('tunnel child ' + index + ' never spawned')
      await new Promise((r) => setTimeout(r, 5))
    }
    return state.tunnelChildren[index]
  }

  mock.module('./electron/services/sidecarManager.ts', () => ({
    appendHostDiagnostic: () => {},
    ELECTRON_DIAGNOSTICS_FILE_ENV: 'CC_HAHA_ELECTRON_DIAGNOSTICS_FILE',
    SERVER_BIND_HOST: '0.0.0.0',
    SERVER_CONTROL_HOST: '127.0.0.1',
    SERVER_STARTUP_TIMEOUT_MS: 30_000,
    createAdapterPlan: () => ({ command: '/fake', args: [], env: {} }),
    createServerPlan: (plan) => {
      state.serverPlans.push(plan)
      return { command: '/fake', args: [], env: plan.env ?? {} }
    },
    createTunnelPlan: ({ mode }) => ({
      command: '/fake/cloudflared',
      args: ['--mode', mode],
      env: {},
    }),
    formatStartupError: (msg) => msg,
    killSidecar: (child) => state.killedTunnelChildren.push(child),
    mergeProxyEnv: (env) => env,
    POWERSHELL_PATH_OVERRIDE_ENV: 'CLAUDE_CODE_POWERSHELL_PATH',
    preferredServerPorts: () => [],
    proxyUrlFromElectronProxyRules: () => undefined,
    pushStartupLog: () => {},
    reserveServerPort: async () => 28670,
    sanitizeHostDiagnostic: (line) => line,
    resolveCloudflaredPath: () => '/fake/cloudflared',
    spawnSidecar: () => {
      const child = makeChild(1000)
      state.serverChild = child
      return child
    },
    spawnTunnel: () => {
      const pid = 2000 + state.tunnelChildren.length
      const child = makeChild(pid)
      child.emitUrl = (url) => child.stderr.emit('data', 'inf | INF Your quick Tunnel: ' + url + '\n')
      state.tunnelChildren.push(child)
      return child
    },
    waitForServer: async () => undefined,
    waitForTunnelUrl: async (child) => {
      return new Promise((resolve, reject) => {
        const onData = (chunk) => {
          const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
          if (match) {
            child.stderr.off('data', onData)
            resolve(match[0])
          }
        }
        child.stderr.on('data', onData)
        child.on('exit', () => reject(new Error('cloudflared exited before URL')))
      })
    },
    windowsPowerShellOverride: () => null,
    writeLastServerPort: () => {},
  }))

  mock.module('./electron/services/terminal.ts', () => ({
    readDesktopTerminalConfig: () => undefined,
    resolveDesktopTerminalShell: () => null,
  }))

  const originalFetch = globalThis.fetch

  async function withRuntime(fn, options = {}) {
    state.serverChild = null
    state.tunnelChildren = []
    state.reportPayloads = []
    state.serverPlans = []
    state.killedTunnelChildren = []
    state.fetchCalls = []
    state.fetchMock = async (url, init) => {
      state.fetchCalls.push({ url: String(url), init })
      if (init?.body && typeof init.body === 'string') {
        state.reportPayloads.push(JSON.parse(init.body))
      }
      return new Response(null, { status: 200 })
    }
    globalThis.fetch = state.fetchMock
    try {
      const { ElectronServerRuntime } = await import('./electron/services/serverRuntime.ts')
      const runtime = new ElectronServerRuntime({ desktopRoot: '/fake/desktop', ...options })
      await runtime.startServer()
      await fn(runtime)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
`

async function expectIsolatedPass(script: string) {
  const result = await runIsolated(`${harness}\n${script}`)
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
}

describe('ElectronServerRuntime tunnel lifecycle', () => {
  it('passes the packaged app version to the sidecar environment', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async () => {
        assertEqual(state.serverPlans[0].env.APP_VERSION, '0.5.32', 'APP_VERSION should match Electron app version')
        assertEqual(state.serverPlans[0].env.CC_HAHA_DESKTOP_VERSION, '0.5.32', 'desktop version should be available separately')
      }, { appVersion: '0.5.32' })
    `)
  })

  it('restarts the tunnel cleanly: stop -> start yields a fresh URL, not the stale one', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        const first = runtime.startTunnel({ mode: 'quick' })
        const child0 = await waitForTunnelChild(0)
        child0.emitUrl('https://owner-standards-answered-staff.trycloudflare.com')
        const firstStatus = await first
        assertEqual(firstStatus, {
          status: 'running',
          url: 'https://owner-standards-answered-staff.trycloudflare.com',
          mode: 'quick',
          error: null,
        }, 'first tunnel status mismatch')

        const stop = runtime.stopTunnel()
        state.tunnelChildren[0].emit('exit', 0, null)
        await stop
        assertEqual(runtime.getTunnelStatus(), { status: 'idle', url: null, mode: null, error: null }, 'stop status mismatch')

        const second = runtime.startTunnel({ mode: 'quick' })
        const child1 = await waitForTunnelChild(1)
        child1.emitUrl('https://aaaa-bbbb-cccc-dddd.trycloudflare.com')
        const secondStatus = await second
        assert(secondStatus.url === 'https://aaaa-bbbb-cccc-dddd.trycloudflare.com', 'second status returned stale URL')
        assert(runtime.getTunnelStatus().url === 'https://aaaa-bbbb-cccc-dddd.trycloudflare.com', 'runtime status returned stale URL')

        const lastRunning = [...state.reportPayloads].reverse().find((p) => p.status === 'running')
        assert(lastRunning?.url === 'https://aaaa-bbbb-cccc-dddd.trycloudflare.com', 'last running report returned stale URL')
        const reportCall = [...state.fetchCalls].reverse().find((call) => call.url.endsWith('/api/h5-access/tunnel/report'))
        assert(reportCall?.init?.headers?.Authorization === 'Bearer ' + runtime.getLocalAccessToken(), 'tunnel report did not use local access auth')
      })
    `)
  })

  it('stopTunnel asks the server to clear (not just report idle), so the runtime URL is wiped on the server side', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        const first = runtime.startTunnel({ mode: 'quick' })
        const child0 = await waitForTunnelChild(0)
        child0.emitUrl('https://stale.trycloudflare.com')
        await first

        const urlsHit = []
        globalThis.fetch = async (url, init) => {
          urlsHit.push(String(url))
          if (init?.body && typeof init.body === 'string') {
            state.reportPayloads.push(JSON.parse(init.body))
          }
          return new Response(null, { status: 200 })
        }

        const stop = runtime.stopTunnel()
        child0.emit('exit', 0, null)
        await stop

        assert(urlsHit.some((url) => url.endsWith('/api/h5-access/tunnel/clear')), 'stopTunnel did not call /api/h5-access/tunnel/clear')
      })
    `)
  })

  it('clears the server URL when the active cloudflared exits unexpectedly', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        const urlsHit = []
        globalThis.fetch = async (url, init) => {
          urlsHit.push(String(url))
          if (init?.body && typeof init.body === 'string') {
            state.reportPayloads.push(JSON.parse(init.body))
          }
          return new Response(null, { status: 200 })
        }

        const started = runtime.startTunnel({ mode: 'quick' })
        const child = await waitForTunnelChild(0)
        child.emitUrl('https://active-exit.trycloudflare.com')
        await started
        child.emit('exit', 1, null)
        await new Promise((resolve) => setTimeout(resolve, 10))

        assert(urlsHit.some((url) => url.endsWith('/api/h5-access/tunnel/clear')), 'unexpected exit did not clear the server URL')
        assertEqual(runtime.getTunnelStatus(), {
          status: 'error',
          url: null,
          mode: 'quick',
          error: 'cloudflared exited unexpectedly (code=1, signal=null)',
        }, 'unexpected exit status mismatch')
      })
    `)
  })

  it('marks a quick tunnel unavailable after three consecutive public health failures', async () => {
    await expectIsolatedPass(String.raw`
      const scheduled = []
      const setTimeoutFn = (fn) => {
        scheduled.push(fn)
        return scheduled.length
      }
      const clearTimeoutFn = () => {}

      await withRuntime(async (runtime) => {
        const urlsHit = []
        globalThis.fetch = async (url, init) => {
          urlsHit.push(String(url))
          if (String(url).includes('trycloudflare.com/health')) {
            return new Response(null, { status: 524 })
          }
          if (init?.body && typeof init.body === 'string') {
            state.reportPayloads.push(JSON.parse(init.body))
          }
          return new Response(null, { status: 200 })
        }

        const started = runtime.startTunnel({ mode: 'quick' })
        const child = await waitForTunnelChild(0)
        child.emitUrl('https://health-failure.trycloudflare.com')
        await started

        for (let index = 0; index < 3; index += 1) {
          const callback = scheduled.shift()
          assert(callback, 'health check was not scheduled')
          await callback()
        }

        assertEqual(runtime.getTunnelStatus(), {
          status: 'error',
          url: null,
          mode: 'quick',
          error: 'Cloudflare tunnel became unreachable after 3 consecutive health check failures (HTTP 524).',
        }, 'health failure status mismatch')
        assert(state.killedTunnelChildren.includes(child), 'unhealthy tunnel child was not stopped')
        assert(urlsHit.some((url) => url.endsWith('/api/h5-access/tunnel/clear')), 'unhealthy tunnel did not clear the server URL')
      }, { setTimeoutFn, clearTimeoutFn })
    `)
  })

  it('resets the quick tunnel health failure count after a successful check', async () => {
    await expectIsolatedPass(String.raw`
      const scheduled = []
      const setTimeoutFn = (fn) => {
        scheduled.push(fn)
        return scheduled.length
      }
      const clearTimeoutFn = () => {}

      await withRuntime(async (runtime) => {
        const healthStatuses = [524, 200, 524, 524]
        const urlsHit = []
        globalThis.fetch = async (url, init) => {
          urlsHit.push(String(url))
          if (String(url).includes('trycloudflare.com/health')) {
            return new Response(null, { status: healthStatuses.shift() ?? 524 })
          }
          if (init?.body && typeof init.body === 'string') {
            state.reportPayloads.push(JSON.parse(init.body))
          }
          return new Response(null, { status: 200 })
        }

        const started = runtime.startTunnel({ mode: 'quick' })
        const child = await waitForTunnelChild(0)
        child.emitUrl('https://health-reset.trycloudflare.com')
        await started

        for (let index = 0; index < 4; index += 1) {
          const callback = scheduled.shift()
          assert(callback, 'health check was not scheduled')
          await callback()
        }

        assertEqual(runtime.getTunnelStatus(), {
          status: 'running',
          url: 'https://health-reset.trycloudflare.com',
          mode: 'quick',
          error: null,
        }, 'a successful health check should reset the consecutive failure count')
        assert(!state.killedTunnelChildren.includes(child), 'tunnel was stopped even though failures were not consecutive')
        assert(!urlsHit.some((url) => url.endsWith('/api/h5-access/tunnel/clear')), 'non-consecutive failures cleared the server URL')
      }, { setTimeoutFn, clearTimeoutFn })
    `)
  })

  it('ignores an old tunnel health callback after a new tunnel starts', async () => {
    await expectIsolatedPass(String.raw`
      const scheduled = []
      const setTimeoutFn = (fn) => {
        scheduled.push(fn)
        return scheduled.length
      }
      const clearTimeoutFn = () => {}

      await withRuntime(async (runtime) => {
        let healthFetches = 0
        globalThis.fetch = async (url, init) => {
          if (String(url).includes('trycloudflare.com/health')) {
            healthFetches += 1
            return new Response(null, { status: 524 })
          }
          if (init?.body && typeof init.body === 'string') {
            state.reportPayloads.push(JSON.parse(init.body))
          }
          return new Response(null, { status: 200 })
        }

        const first = runtime.startTunnel({ mode: 'quick' })
        const oldChild = await waitForTunnelChild(0)
        oldChild.emitUrl('https://old-health.trycloudflare.com')
        await first
        const oldHealthCallback = scheduled.shift()
        assert(oldHealthCallback, 'old health check was not scheduled')

        const second = runtime.startTunnel({ mode: 'quick' })
        const newChild = await waitForTunnelChild(1)
        newChild.emitUrl('https://new-health.trycloudflare.com')
        await second

        await oldHealthCallback()

        assert(healthFetches === 0, 'stale health callback should not probe the old public URL')
        assertEqual(runtime.getTunnelStatus(), {
          status: 'running',
          url: 'https://new-health.trycloudflare.com',
          mode: 'quick',
          error: null,
        }, 'stale health callback clobbered the new tunnel')
      }, { setTimeoutFn, clearTimeoutFn })
    `)
  })

  it('a delayed exit from the previous cloudflared does not clobber a running new tunnel', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        const first = runtime.startTunnel({ mode: 'quick' })
        const oldChild = await waitForTunnelChild(0)
        oldChild.emitUrl('https://old.trycloudflare.com')
        await first

        const second = runtime.startTunnel({ mode: 'quick' })
        const newChild = await waitForTunnelChild(1)
        newChild.emitUrl('https://new.trycloudflare.com')
        await second
        assert(runtime.getTunnelStatus().url === 'https://new.trycloudflare.com', 'new tunnel did not start')

        oldChild.emit('exit', 0, null)
        await new Promise((resolve) => setTimeout(resolve, 10))
        assert(runtime.getTunnelStatus().url === 'https://new.trycloudflare.com', 'old exit clobbered new URL')
        assert(runtime.getTunnelStatus().status === 'running', 'old exit clobbered running status')
      })
    `)
  })
})

const sidecarMocks = {
  nextPort: 49321,
  spawnError: null as Error | null,
  serverChildren: [] as FakeSidecarChild[],
  adapterChildren: [] as FakeSidecarChild[],
  serverPlans: [] as SidecarPlan[],
  appendHostDiagnostic: vi.fn(),
  waitForServerImpl: () => Promise.resolve(),
  onAdapterSpawn: null as (() => void) | null,
  spawnSidecar: vi.fn((plan: SidecarPlan) => {
    if (plan.args[0] === 'server' && sidecarMocks.spawnError) throw sidecarMocks.spawnError
    const child = new FakeSidecarChild()
    if (plan.args[0] === 'server') {
      sidecarMocks.serverChildren.push(child)
      sidecarMocks.serverPlans.push(plan)
    } else {
      sidecarMocks.adapterChildren.push(child)
      sidecarMocks.onAdapterSpawn?.()
    }
    return child as unknown as SidecarChild
  }),
}

let isolatedConfigDir = ''

class FakeSidecarChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn()
}

function createRuntime(options: { appRoot?: string, appVersion?: string, diagnosticsFile?: string } = {}) {
  return new ElectronServerRuntime({
    desktopRoot: '/isolated/desktop',
    appRoot: options.appRoot,
    appVersion: options.appVersion,
    diagnosticsFile: options.diagnosticsFile,
    env: { CLAUDE_CONFIG_DIR: isolatedConfigDir },
    deps: {
      appendHostDiagnostic: sidecarMocks.appendHostDiagnostic,
      preferredServerPorts: () => [],
      reserveServerPort: async () => sidecarMocks.nextPort++,
      spawnSidecar: sidecarMocks.spawnSidecar,
      waitForServer: async () => await sidecarMocks.waitForServerImpl(),
      writeLastServerPort: () => undefined,
    },
  })
}

async function waitForServerChildren(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && sidecarMocks.serverChildren.length !== count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(sidecarMocks.serverChildren).toHaveLength(count)
}

describe('ElectronServerRuntime', () => {
  beforeEach(() => {
    isolatedConfigDir = mkdtempSync(path.join(tmpdir(), 'cc-haha-electron-runtime-'))
    sidecarMocks.nextPort = 49321
    sidecarMocks.spawnError = null
    sidecarMocks.serverChildren.length = 0
    sidecarMocks.adapterChildren.length = 0
    sidecarMocks.serverPlans.length = 0
    sidecarMocks.appendHostDiagnostic.mockClear()
    sidecarMocks.waitForServerImpl = () => Promise.resolve()
    sidecarMocks.onAdapterSpawn = null
    sidecarMocks.spawnSidecar.mockClear()
  })

  afterEach(() => {
    rmSync(isolatedConfigDir, { recursive: true, force: true })
  })

  it('restarts after the active healthy server exits and ignores its late exit', async () => {
    const runtime = createRuntime({
      appRoot: '/isolated/app',
    })

    const firstUrl = await runtime.getServerUrl()
    const firstChild = sidecarMocks.serverChildren[0]!
    const firstAdapters = [...sidecarMocks.adapterChildren]
    expect(firstAdapters).toHaveLength(5)
    firstChild.emit('exit', 7, null)

    const [secondUrl, coalescedUrl] = await Promise.all([
      runtime.getServerUrl(),
      runtime.getServerUrl(),
    ])
    const secondChild = sidecarMocks.serverChildren[1]!
    firstChild.emit('exit', 9, 'SIGTERM')

    expect(firstUrl).toBe('http://127.0.0.1:49321')
    expect(secondUrl).toBe('http://127.0.0.1:49322')
    expect(coalescedUrl).toBe(secondUrl)
    expect(sidecarMocks.serverChildren).toHaveLength(2)
    expect(sidecarMocks.adapterChildren).toHaveLength(10)
    for (const adapter of firstAdapters) expect(adapter.kill).toHaveBeenCalledTimes(1)
    for (const adapter of sidecarMocks.adapterChildren.slice(5)) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
    expect(await runtime.getServerUrl()).toBe(secondUrl)
    expect(secondChild).toBeDefined()
  })

  it('passes the isolated base env, diagnostics file, and desktop version to the server sidecar', async () => {
    const runtime = createRuntime({
      appVersion: '0.5.32',
      diagnosticsFile: '/isolated/user-data/diagnostics/electron-host.log',
    })

    await runtime.startServer()

    expect(sidecarMocks.serverPlans[0]!.env.CC_HAHA_ELECTRON_DIAGNOSTICS_FILE)
      .toBe('/isolated/user-data/diagnostics/electron-host.log')
    expect(sidecarMocks.serverPlans[0]!.env.CLAUDE_CONFIG_DIR).toBe(isolatedConfigDir)
    expect(sidecarMocks.serverPlans[0]!.env.CLAUDE_CONFIG_DIR)
      .not.toBe(path.join(homedir(), '.claude'))
    expect(sidecarMocks.serverPlans[0]!.env.APP_VERSION).toBe('0.5.32')
    expect(sidecarMocks.serverPlans[0]!.env.CC_HAHA_DESKTOP_VERSION).toBe('0.5.32')
  })

  it('shares one unguessable local access token with server, adapters, and renderer', async () => {
    const runtime = createRuntime()

    await runtime.startServer()

    const token = runtime.getLocalAccessToken()
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(sidecarMocks.serverPlans[0]!.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(token)
    for (const adapter of sidecarMocks.spawnSidecar.mock.calls
      .map(([plan]) => plan)
      .filter(plan => plan.args[0] === 'adapters')) {
      expect(adapter.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(token)
    }
  })

  it('persists a server startup failure through the sanitized host-log boundary', async () => {
    sidecarMocks.spawnError = new Error('spawn failed')
    const runtime = createRuntime({
      diagnosticsFile: '/isolated/user-data/diagnostics/electron-host.log',
    })

    await expect(runtime.startServer()).rejects.toThrow('spawn failed')

    expect(sidecarMocks.appendHostDiagnostic).toHaveBeenCalledWith(
      '/isolated/user-data/diagnostics/electron-host.log',
      expect.stringContaining('[startup-error] spawn failed'),
    )
  })

  it('rejects an in-flight start when the child exits before health publication', async () => {
    sidecarMocks.waitForServerImpl = () => new Promise(() => undefined)
    const runtime = createRuntime()

    const starting = runtime.startServer()
    await waitForServerChildren(1)
    sidecarMocks.serverChildren[0]!.emit('exit', 17, null)

    await expect(starting).rejects.toThrow('code=17, signal=null')
    sidecarMocks.waitForServerImpl = () => Promise.resolve()
    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49322')
    expect(sidecarMocks.serverChildren).toHaveLength(2)
  })

  it('kills the attempted server child when the health wait rejects', async () => {
    sidecarMocks.waitForServerImpl = () => Promise.reject(new Error('health wait timed out'))
    const runtime = createRuntime()

    await expect(runtime.startServer()).rejects.toThrow('health wait timed out')

    expect(sidecarMocks.serverChildren).toHaveLength(1)
    expect(sidecarMocks.serverChildren[0]!.kill).toHaveBeenCalledTimes(1)
    expect(sidecarMocks.adapterChildren).toHaveLength(0)
  })

  it('kills an unpublished server exactly once when stopAll runs during health wait', async () => {
    let releaseHealth!: () => void
    sidecarMocks.waitForServerImpl = () => new Promise<void>(resolve => {
      releaseHealth = resolve
    })
    const runtime = createRuntime()

    const starting = runtime.startServer()
    await waitForServerChildren(1)
    runtime.stopAll(true)

    expect(sidecarMocks.serverChildren[0]!.kill).toHaveBeenCalledTimes(1)
    await expect(starting).rejects.toThrow('stopped')
    releaseHealth()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sidecarMocks.serverChildren).toHaveLength(1)
    expect(sidecarMocks.adapterChildren).toHaveLength(0)
    expect(sidecarMocks.serverChildren[0]!.kill).toHaveBeenCalledTimes(1)
  })

  it('stops active adapters immediately when the server exits without restart demand', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const activeAdapters = [...sidecarMocks.adapterChildren]

    sidecarMocks.serverChildren[0]!.emit('exit', 19, null)

    for (const adapter of activeAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    expect(sidecarMocks.serverChildren).toHaveLength(1)
  })

  it('stops active adapters immediately when the server emits a process error', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const activeAdapters = [...sidecarMocks.adapterChildren]

    sidecarMocks.serverChildren[0]!.emit('error', new Error('active server failed'))

    for (const adapter of activeAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
  })

  it('does not let a stale server exit stop replacement adapters', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const firstServer = sidecarMocks.serverChildren[0]!
    firstServer.emit('exit', 20, null)
    await runtime.getServerUrl()
    const replacementAdapters = sidecarMocks.adapterChildren.slice(5)

    firstServer.emit('exit', 21, 'SIGTERM')

    expect(replacementAdapters).toHaveLength(5)
    for (const adapter of replacementAdapters) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
  })

  it('stops the current adapter generation after an explicit adapter restart', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const firstAdapters = [...sidecarMocks.adapterChildren]

    await runtime.restartAdaptersSidecars()
    const restartedAdapters = sidecarMocks.adapterChildren.slice(5)
    sidecarMocks.serverChildren[0]!.emit('exit', 22, null)

    for (const adapter of firstAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    for (const adapter of restartedAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
  })

  it('coalesces overlapping manual adapter restarts into one live generation', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const originalAdapters = [...sidecarMocks.adapterChildren]

    const firstRestart = runtime.restartAdaptersSidecars()
    const secondRestart = runtime.restartAdaptersSidecars()

    expect(secondRestart).toBe(firstRestart)
    await Promise.all([firstRestart, secondRestart])
    expect(sidecarMocks.adapterChildren).toHaveLength(10)
    for (const adapter of originalAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    for (const adapter of sidecarMocks.adapterChildren.slice(5)) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
  })

  it('cancels a manual adapter restart when its server exits after the first spawn', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const firstServer = sidecarMocks.serverChildren[0]!
    const originalAdapters = [...sidecarMocks.adapterChildren]
    sidecarMocks.onAdapterSpawn = () => {
      sidecarMocks.onAdapterSpawn = null
      firstServer.emit('exit', 23, null)
    }

    await runtime.restartAdaptersSidecars()

    expect(sidecarMocks.adapterChildren).toHaveLength(6)
    for (const adapter of originalAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    expect(sidecarMocks.adapterChildren[5]!.kill).toHaveBeenCalledTimes(1)

    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49322')
    expect(sidecarMocks.serverChildren).toHaveLength(2)
    expect(sidecarMocks.adapterChildren).toHaveLength(11)
    for (const adapter of sidecarMocks.adapterChildren.slice(6)) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
  })

  it('rejects when the published child exits during adapter startup', async () => {
    const runtime = createRuntime()
    sidecarMocks.onAdapterSpawn = () => {
      sidecarMocks.onAdapterSpawn = null
      sidecarMocks.serverChildren[0]!.emit('exit', 18, 'SIGTERM')
    }

    await expect(runtime.startServer()).rejects.toThrow('code=18, signal=SIGTERM')

    expect(sidecarMocks.adapterChildren).toHaveLength(1)
    expect(sidecarMocks.adapterChildren[0]!.kill).toHaveBeenCalledTimes(1)

    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49322')
    expect(sidecarMocks.serverChildren).toHaveLength(2)
    expect(sidecarMocks.adapterChildren).toHaveLength(6)
    for (const adapter of sidecarMocks.adapterChildren.slice(1)) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
  })

  it('handles an asynchronous child process error without crashing Electron', async () => {
    sidecarMocks.waitForServerImpl = () => new Promise(() => undefined)
    const runtime = createRuntime({
      diagnosticsFile: '/isolated/user-data/diagnostics/electron-host.log',
    })

    const starting = runtime.startServer()
    await waitForServerChildren(1)
    expect(() => sidecarMocks.serverChildren[0]!.emit(
      'error',
      new Error('spawn error OPENAI_API_KEY=unsafe-value'),
    )).not.toThrow()

    const rejection = await starting.then(
      () => null,
      error => error as Error,
    )
    expect(rejection?.message).toContain('spawn error')
    expect(rejection?.message).not.toContain('unsafe-value')
    expect(sidecarMocks.appendHostDiagnostic).toHaveBeenCalledWith(
      '/isolated/user-data/diagnostics/electron-host.log',
      expect.stringContaining('[process-error] sidecar process error: spawn error'),
    )
  })
})
