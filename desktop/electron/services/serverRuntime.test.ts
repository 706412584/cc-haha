import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { SidecarChild, SidecarPlan } from './sidecarManager'
import { ADAPTER_FLAGS, SYSTEM_PROXY_ERROR_ENV } from './sidecarManager'
import { ElectronServerRuntime } from './serverRuntime'
import type { SystemProxyBridgeLike } from './systemProxyBridge'

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
    pinggyChildren: [],
    reportPayloads: [],
    serverPlans: [],
    fetchCalls: [],
    fetchMock: null,
    killedTunnelChildren: [],
    cloudflareFails: false,
    pinggyFails: false,
    downloadFails: false,
    downloadError: 'cloudflared download failed: HTTP 403',
    downloadSteps: null,
  }

  const CF_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
  const PINGGY_URL_RE = /https:\/\/[a-z0-9][a-z0-9.-]*\.(?:pinggy\.link|pinggy-free\.link|pinggy\.online)/i

  function getState() {
    return { ...state }
  }
  function setState(patch) {
    Object.assign(state, patch)
  }

  function makeChild(pid) {
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid,
    })
  }

  function awaitUrl(child, regex, exitMessage) {
    return new Promise((resolve, reject) => {
      const onData = (chunk) => {
        const match = String(chunk).match(regex)
        if (match) {
          child.stderr.off('data', onData)
          resolve(match[0])
        }
      }
      child.stderr.on('data', onData)
      child.on('exit', () => reject(new Error(exitMessage)))
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

  async function waitForPinggyChild(index, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (state.pinggyChildren.length <= index) {
      if (Date.now() > deadline) throw new Error('pinggy child ' + index + ' never spawned')
      await new Promise((r) => setTimeout(r, 5))
    }
    return state.pinggyChildren[index]
  }

  mock.module('./electron/services/sidecarManager.ts', () => ({
    appendHostDiagnostic: () => {},
    claudeConfigDir: () => '/fake/config',
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
    clearProxyEnv: (env) => env,
    withAdapterProxyBridgeEnv: (env) => env,
    withSystemProxyBridgeEnv: (env) => env,
    withSystemProxyErrorEnv: (env) => env,
    POWERSHELL_PATH_OVERRIDE_ENV: 'CLAUDE_CODE_POWERSHELL_PATH',
    preferredServerPorts: () => [],
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
    state.pinggyChildren = []
    state.reportPayloads = []
    state.serverPlans = []
    state.killedTunnelChildren = []
    state.cloudflareFails = false
    state.pinggyFails = false
    state.downloadFails = false
    state.downloadSteps = null
    state.fetchCalls = []
    state.fetchMock = async (url, init) => {
      state.fetchCalls.push({ url: String(url), init })
      if (init?.body && typeof init.body === 'string') {
        state.reportPayloads.push(JSON.parse(init.body))
      }
      return new Response(null, { status: 200 })
    }
    globalThis.fetch = state.fetchMock

    const providerDeps = {
      // A plain resolve unless the test opts into a simulated download.
      ensureCloudflaredBinary: async (opts) => {
        if (state.downloadFails) {
          opts?.onProgress?.({ receivedBytes: 100, totalBytes: 500 })
          throw new Error(state.downloadError)
        }
        if (state.downloadSteps) {
          for (const step of state.downloadSteps) {
            opts?.onProgress?.(step)
            await new Promise((r) => setTimeout(r, 1))
          }
        }
        return '/fake/cloudflared'
      },
      createCloudflareTunnel: async (options) => {
        if (state.cloudflareFails) throw new Error('cloudflared unavailable')
        // Faithful to the real factory: it resolves the binary (which is where
        // the auto-download happens) before it spawns anything.
        if (options.resolveBinary) await options.resolveBinary()
        const pid = 2000 + state.tunnelChildren.length
        const child = makeChild(pid)
        child.emitUrl = (url) => child.stderr.emit('data', 'INF Your quick Tunnel: ' + url + '\n')
        state.tunnelChildren.push(child)
        const url = await awaitUrl(child, CF_URL_RE, 'cloudflared exited before URL')
        return {
          provider: 'cloudflare',
          url,
          child,
          stop: async () => { state.killedTunnelChildren.push(child) },
        }
      },
      createPinggyTunnel: async () => {
        if (state.pinggyFails) throw new Error('ssh unavailable')
        const pid = 3000 + state.pinggyChildren.length
        const child = makeChild(pid)
        child.emitUrl = (url) => child.stderr.emit('data', url + '\n')
        state.pinggyChildren.push(child)
        const url = await awaitUrl(child, PINGGY_URL_RE, 'ssh exited before URL')
        return {
          provider: 'pinggy',
          url,
          child,
          stop: async () => { state.killedTunnelChildren.push(child) },
        }
      },
    }
    const { deps, ...rest } = options
    try {
      const { ElectronServerRuntime } = await import('./electron/services/serverRuntime.ts')
      const runtime = new ElectronServerRuntime({
        desktopRoot: '/fake/desktop',
        ...rest,
        deps: { ...providerDeps, ...(deps ?? {}) },
      })
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
          provider: 'cloudflare',
          download: null,
        }, 'first tunnel status mismatch')

        const stop = runtime.stopTunnel()
        state.tunnelChildren[0].emit('exit', 0, null)
        await stop
        assertEqual(runtime.getTunnelStatus(), { status: 'idle', url: null, mode: null, error: null, provider: null, download: null }, 'stop status mismatch')

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

  it('reconnects an unexpectedly-exited cloudflared and clears the dead server URL', async () => {
    await expectIsolatedPass(String.raw`
      const scheduled = []
      const setTimeoutFn = (fn, delay) => {
        scheduled.push({ fn, delay })
        return scheduled.length
      }
      const clearTimeoutFn = () => {}
      // Health probes use 15s/30s; reconnect backoff is <= 8s. Pick by delay so
      // the shared timer queue cannot hand us the wrong callback.
      const takeReconnect = () => {
        const index = scheduled.findIndex((entry) => entry.delay <= 8000)
        return index < 0 ? null : scheduled.splice(index, 1)[0].fn
      }

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

        assert(urlsHit.some((url) => url.endsWith('/api/h5-access/tunnel/clear')), 'unexpected exit did not clear the dead server URL')
        assertEqual(runtime.getTunnelStatus(), {
          status: 'reconnecting',
          url: null,
          mode: 'quick',
          error: 'cloudflare exited unexpectedly (code=1, signal=null)',
          provider: 'cloudflare',
          download: null,
        }, 'unexpected exit should degrade to reconnecting with the provider preserved')

        // Drive the scheduled reconnect: a fresh provider spawns and the tunnel
        // returns to running with the new URL.
        const reconnect = takeReconnect()
        assert(reconnect, 'no reconnect was scheduled')
        reconnect()
        const child1 = await waitForTunnelChild(1)
        child1.emitUrl('https://reconnected.trycloudflare.com')
        await new Promise((resolve) => setTimeout(resolve, 20))
        assertEqual(runtime.getTunnelStatus().status, 'running', 'reconnect did not restore a running tunnel')
        assertEqual(runtime.getTunnelStatus().url, 'https://reconnected.trycloudflare.com', 'reconnect URL mismatch')
      }, { setTimeoutFn, clearTimeoutFn })
    `)
  })

  it('gives up with the provider preserved after the reconnect budget is spent', async () => {
    await expectIsolatedPass(String.raw`
      const scheduled = []
      const setTimeoutFn = (fn, delay) => {
        scheduled.push({ fn, delay })
        return scheduled.length
      }
      const clearTimeoutFn = () => {}
      const takeReconnect = () => {
        const index = scheduled.findIndex((entry) => entry.delay <= 8000)
        return index < 0 ? null : scheduled.splice(index, 1)[0].fn
      }

      await withRuntime(async (runtime) => {
        globalThis.fetch = async () => new Response(null, { status: 200 })

        const started = runtime.startTunnel({ mode: 'quick' })
        const child0 = await waitForTunnelChild(0)
        child0.emitUrl('https://loop-0.trycloudflare.com')
        await started

        // Each reconnect comes back briefly, then dies again — burning one slot
        // of the 3-attempt budget per cycle.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await waitForTunnelChild(attempt)
          current.emit('exit', 1, null)
          await new Promise((resolve) => setTimeout(resolve, 5))
          const reconnect = takeReconnect()
          assert(reconnect, 'reconnect ' + attempt + ' was not scheduled')
          reconnect()
          const next = await waitForTunnelChild(attempt + 1)
          next.emitUrl('https://loop-' + (attempt + 1) + '.trycloudflare.com')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }

        // Budget spent: the next exit settles into the terminal error state
        // without scheduling another reconnect, and keeps the provider for the UI.
        const last = await waitForTunnelChild(3)
        last.emit('exit', 1, null)
        await new Promise((resolve) => setTimeout(resolve, 10))
        assertEqual(runtime.getTunnelStatus().status, 'error', 'exhausted budget should settle into error')
        assertEqual(runtime.getTunnelStatus().provider, 'cloudflare', 'terminal error should preserve the provider')
        assertEqual(takeReconnect(), null, 'no reconnect should be scheduled after the budget is spent')
      }, { setTimeoutFn, clearTimeoutFn })
    `)
  })

  it('does not resurrect a stopped tunnel when a pending reconnect was mid-start', async () => {
    await expectIsolatedPass(String.raw`
      const scheduled = []
      const setTimeoutFn = (fn, delay) => {
        scheduled.push({ fn, delay })
        return scheduled.length
      }
      const clearTimeoutFn = () => {}
      const takeReconnect = () => {
        const index = scheduled.findIndex((entry) => entry.delay <= 8000)
        return index < 0 ? null : scheduled.splice(index, 1)[0].fn
      }
      const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      await withRuntime(async (runtime) => {
        globalThis.fetch = async () => new Response(null, { status: 200 })

        const started = runtime.startTunnel({ mode: 'quick' })
        const child0 = await waitForTunnelChild(0)
        child0.emitUrl('https://before-stop.trycloudflare.com')
        await started

        // Make the reconnect's own start suspend inside getServerUrl (as it does
        // while the server sidecar is restarting), so a user Stop can land in
        // that window.
        let releaseGate
        const gate = new Promise((resolve) => { releaseGate = resolve })
        const originalGetServerUrl = runtime.getServerUrl.bind(runtime)
        let gated = false
        runtime.getServerUrl = async () => {
          if (!gated) { gated = true; await gate }
          return originalGetServerUrl()
        }

        child0.emit('exit', 1, null)
        await tick(5)
        const reconnect = takeReconnect()
        assert(reconnect, 'reconnect was not scheduled')
        reconnect()
        await tick(5)

        // The user stops the tunnel while the reconnect is suspended.
        await runtime.stopTunnel()
        assertEqual(runtime.getTunnelStatus().status, 'idle', 'stop should settle to idle')

        // Release the suspended reconnect: it must abort, not spawn a new provider.
        releaseGate()
        await tick(40)
        assertEqual(runtime.getTunnelStatus().status, 'idle', 'a stopped tunnel must not be resurrected by a stale reconnect')
        assertEqual(state.tunnelChildren.length, 1, 'no new provider should spawn after the user stopped')
      }, { setTimeoutFn, clearTimeoutFn })
    `)
  })

  it('degrades a verified quick tunnel after three failures without killing it', async () => {
    await expectIsolatedPass(String.raw`
      const scheduled = []
      const setTimeoutFn = (fn) => {
        scheduled.push(fn)
        return scheduled.length
      }
      const clearTimeoutFn = () => {}

      await withRuntime(async (runtime) => {
        const urlsHit = []
        // One healthy probe first: only a URL that has served traffic may be
        // declared down, so the state change is gated on that verification.
        const healthStatuses = [200, 524, 524, 524]
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
        child.emitUrl('https://health-failure.trycloudflare.com')
        await started

        for (let index = 0; index < 4; index += 1) {
          const callback = scheduled.shift()
          assert(callback, 'health check was not scheduled')
          await callback()
        }

        assertEqual(runtime.getTunnelStatus(), {
          status: 'error',
          url: null,
          mode: 'quick',
          error: 'Cloudflare tunnel is not answering after 3 consecutive health check failures (HTTP 524). It will keep retrying.',
          provider: null,
          download: null,
        }, 'health failure status mismatch')
        // The edge reconnects on its own, so the process must survive: killing
        // it would strand a tunnel that recovers seconds later.
        assert(!state.killedTunnelChildren.includes(child), 'a recoverable tunnel must not be killed')
        assert(urlsHit.some((url) => url.endsWith('/api/h5-access/tunnel/clear')), 'degraded tunnel did not clear the server URL')
        assert(scheduled.length > 0, 'probing must continue while the tunnel is degraded')
      }, { setTimeoutFn, clearTimeoutFn })
    `)
  })

  it('recovers a degraded tunnel to running once the public URL answers again', async () => {
    await expectIsolatedPass(String.raw`
      const scheduled = []
      const setTimeoutFn = (fn) => {
        scheduled.push(fn)
        return scheduled.length
      }
      const clearTimeoutFn = () => {}

      await withRuntime(async (runtime) => {
        // 200 (verify) -> 3x524 (degrade) -> 200 (edge reconnected)
        const healthStatuses = [200, 524, 524, 524, 200]
        globalThis.fetch = async (url, init) => {
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
        child.emitUrl('https://health-recover.trycloudflare.com')
        await started

        for (let index = 0; index < 4; index += 1) {
          const callback = scheduled.shift()
          assert(callback, 'health check was not scheduled')
          await callback()
        }
        assertEqual(runtime.getTunnelStatus().status, 'error', 'tunnel should be degraded before recovery')

        const recovery = scheduled.shift()
        assert(recovery, 'probing stopped while degraded, so recovery could never be observed')
        await recovery()

        assertEqual(runtime.getTunnelStatus(), {
          status: 'running',
          url: 'https://health-recover.trycloudflare.com',
          mode: 'quick',
          error: null,
          provider: 'cloudflare',
          download: null,
        }, 'a recovered tunnel must report running again')
        assert(state.reportPayloads.some((payload) => payload.status === 'running' && payload.url === 'https://health-recover.trycloudflare.com'), 'recovery was not reported to the server')
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
          provider: 'cloudflare',
          download: null,
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
          provider: 'cloudflare',
          download: null,
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

  it('keeps Cloudflare and never starts Pinggy when the primary provider succeeds', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        const started = runtime.startTunnel({ mode: 'quick' })
        const child = await waitForTunnelChild(0)
        child.emitUrl('https://cloudflare-ok.trycloudflare.com')
        const status = await started

        assertEqual(status, {
          status: 'running',
          url: 'https://cloudflare-ok.trycloudflare.com',
          mode: 'quick',
          error: null,
          provider: 'cloudflare',
          download: null,
        }, 'cloudflare success status mismatch')
        assert(state.pinggyChildren.length === 0, 'pinggy must not start when cloudflare succeeds')
        const lastRunning = [...state.reportPayloads].reverse().find((p) => p.status === 'running')
        assert(lastRunning?.provider === 'cloudflare', 'report should carry the cloudflare provider')
      })
    `)
  })

  it('falls back to Pinggy when Cloudflare fails to start', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        state.cloudflareFails = true
        const started = runtime.startTunnel({ mode: 'quick' })
        const child = await waitForPinggyChild(0)
        child.emitUrl('https://abc-1-2-3-4.a.free.pinggy.link')
        const status = await started

        assertEqual(status, {
          status: 'running',
          url: 'https://abc-1-2-3-4.a.free.pinggy.link',
          mode: 'quick',
          error: null,
          provider: 'pinggy',
          download: null,
        }, 'pinggy fallback status mismatch')
        assert(state.tunnelChildren.length === 0, 'cloudflare should not have spawned a process')
        const lastRunning = [...state.reportPayloads].reverse().find((p) => p.status === 'running')
        assert(lastRunning?.provider === 'pinggy', 'report should carry the pinggy provider')
      })
    `)
  })

  it('raises an aggregated error when both providers fail', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        state.cloudflareFails = true
        state.pinggyFails = true
        const status = await runtime.startTunnel({ mode: 'quick' })

        assertEqual(status, {
          status: 'error',
          url: null,
          mode: 'quick',
          error: 'Cloudflare: cloudflared unavailable; Pinggy: ssh unavailable',
          provider: null,
          download: null,
        }, 'aggregated failure status mismatch')
        const lastReport = state.reportPayloads[state.reportPayloads.length - 1]
        assert(lastReport?.status === 'error', 'the aggregated failure should be reported to the server')
        assert(lastReport?.provider === undefined, 'a failed start should not declare a provider')
      })
    `)
  })

  it('pins the tunnel to an explicitly requested provider without falling back', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        state.cloudflareFails = true
        const started = runtime.startTunnel({ mode: 'quick', provider: 'pinggy' })
        const child = await waitForPinggyChild(0)
        child.emitUrl('https://pinned-1.pinggy.online')
        const status = await started

        assertEqual(status.provider, 'pinggy', 'explicit provider should be honored')
        assert(status.url === 'https://pinned-1.pinggy.online', 'pinned tunnel URL mismatch')
      })
    `)
  })

  it('preserves the pinggy provider when a fallback tunnel exits unexpectedly', async () => {
    await expectIsolatedPass(String.raw`
      const scheduled = []
      const setTimeoutFn = (fn) => {
        scheduled.push(fn)
        return scheduled.length
      }
      const clearTimeoutFn = () => {}

      await withRuntime(async (runtime) => {
        state.cloudflareFails = true
        const started = runtime.startTunnel({ mode: 'quick' })
        const child = await waitForPinggyChild(0)
        child.emitUrl('https://abc-1-2-3-4.a.free.pinggy.link')
        await started

        child.emit('exit', 1, null)
        await new Promise((resolve) => setTimeout(resolve, 10))
        assertEqual(runtime.getTunnelStatus(), {
          status: 'reconnecting',
          url: null,
          mode: 'quick',
          error: 'pinggy exited unexpectedly (code=1, signal=null)',
          provider: 'pinggy',
          download: null,
        }, 'pinggy unexpected exit status mismatch')
      }, { setTimeoutFn, clearTimeoutFn })
    `)
  })

  it('surfaces cloudflared download progress on the host status while it resolves', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        // Two progress ticks, then a long-lived quick tunnel so the start
        // promise stays pending long enough to observe the download state.
        state.downloadSteps = [
          { receivedBytes: 100, totalBytes: 400 },
          { receivedBytes: 250, totalBytes: 400 },
        ]
        const started = runtime.startTunnel({ mode: 'quick' })
        const child = await waitForTunnelChild(0)

        const downloading = runtime.getTunnelStatus().download
        assert(downloading?.state === 'downloading', 'download state should be visible while resolving')
        assert(downloading.receivedBytes === 250, 'download progress should reflect the latest tick')
        assert(downloading.totalBytes === 400, 'download total should be reported')
        // The server has no download concept; it must never be mirrored there.
        assert(
          state.reportPayloads.every((p) => p.download === undefined),
          'download progress must not be reported to the server',
        )

        child.emitUrl('https://progress-observed.trycloudflare.com')
        const status = await started
        assert(status.download === null, 'a running tunnel should clear the download state')
      })
    `)
  })

  it('does not show a stale download failure once Pinggy takes over', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        state.downloadFails = true
        const started = runtime.startTunnel({ mode: 'quick' })
        const child = await waitForPinggyChild(0)
        child.emitUrl('https://download-failed.pinggy.online')
        const status = await started

        // Pinggy took over, so the tunnel is healthy: a "download failed" banner
        // would be misleading even though the download really did fail.
        assert(status.provider === 'pinggy', 'pinggy should take over after a download failure')
        assert(status.download === null, 'a healthy fallback tunnel must not show a download failure')
      })
    `)
  })

  it('preserves the download failure when every provider fails', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        state.downloadFails = true
        state.pinggyFails = true
        const status = await runtime.startTunnel({ mode: 'quick' })

        // Nothing is running, so the download failure is the most actionable
        // clue and must survive into the terminal error state.
        assert(status.status === 'error', 'both providers failing should be an error state')
        assert(status.download?.state === 'failed', 'the download failure should survive')
        assert(
          status.download.error === state.downloadError,
          'the download error should be preserved verbatim',
        )
        assert(
          typeof status.error === 'string' && status.error.includes('Pinggy'),
          'the aggregated error should still mention both providers',
        )
      })
    `)
  })

  it('does not report a download failure when the binary resolved but the spawn failed', async () => {
    await expectIsolatedPass(String.raw`
      await withRuntime(async (runtime) => {
        // The binary resolves fine; only the spawn blows up. The settings page
        // must not be told "cloudflared download failed".
        state.cloudflareFails = true
        const started = runtime.startTunnel({ mode: 'quick' })
        const child = await waitForPinggyChild(0)
        child.emitUrl('https://spawn-failed.pinggy.online')
        const status = await started

        assert(status.provider === 'pinggy', 'pinggy should take over after a spawn failure')
        assert(status.download === null, 'a spawn failure is not a download failure')
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

/** One sidecar per IM adapter, so the counts below track the flag list
 *  rather than a number that has to be edited whenever a platform is added. */
const ADAPTER_COUNT = ADAPTER_FLAGS.length

let isolatedConfigDir = ''

class FakeSidecarChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn()
}

function createRuntime(options: {
  appRoot?: string
  appVersion?: string
  diagnosticsFile?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  resolveSystemProxy?: (url: string) => Promise<string>
  sleep?: (delayMs: number) => Promise<void>
  proxyBridge?: SystemProxyBridgeLike
  fetchFn?: typeof fetch
} = {}) {
  return new ElectronServerRuntime({
    desktopRoot: '/isolated/desktop',
    appRoot: options.appRoot,
    appVersion: options.appVersion,
    diagnosticsFile: options.diagnosticsFile,
    env: { CLAUDE_CONFIG_DIR: isolatedConfigDir, ...options.env },
    resolveSystemProxy: options.resolveSystemProxy,
    fetchFn: options.fetchFn ?? (async () => new Response('{}', { status: 200 })),
    deps: {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      appendHostDiagnostic: sidecarMocks.appendHostDiagnostic,
      ...(options.now ? { now: options.now } : {}),
      preferredServerPorts: () => [],
      reserveServerPort: async () => sidecarMocks.nextPort++,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      spawnSidecar: sidecarMocks.spawnSidecar,
      waitForServer: async () => await sidecarMocks.waitForServerImpl(),
      writeLastServerPort: () => undefined,
      ...(options.proxyBridge
        ? { createSystemProxyBridge: () => options.proxyBridge! }
        : {}),
    },
  })
}

async function waitForServerChildren(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && sidecarMocks.serverChildren.length !== count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(sidecarMocks.serverChildren).toHaveLength(count)
}

type FetchMock = ReturnType<typeof vi.fn> & typeof fetch

async function waitForCallCount(mock: FetchMock, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length !== count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(mock).toHaveBeenCalledTimes(count)
}

async function waitForMockCalls(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length !== count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(mock).toHaveBeenCalledTimes(count)
}

describe('ElectronServerRuntime', () => {
  it('drains the authenticated server and every adapter before stopping the server', async () => {
    const order: string[] = []
    const runtime = createRuntime({ fetch: (async (_url, options) => {
      expect(options?.headers).toEqual({ Authorization: `Bearer ${runtime.getLocalAccessToken()}` })
      order.push('server-drained')
      return Response.json({ quiesced: true })
    }) as typeof fetch })
    await runtime.startServer()
    const server = sidecarMocks.serverChildren[0]!
    server.kill.mockImplementation(() => {
      expect(order.filter(entry => entry === 'adapter-drained')).toHaveLength(ADAPTER_COUNT)
      order.push('server-stopped')
      server.exitCode = 0
      server.emit('exit', 0, null)
    })
    for (const child of sidecarMocks.adapterChildren) {
      child.stdin.on('data', value => {
        const request = JSON.parse(value.toString())
        expect(request.token).toBe(runtime.getLocalAccessToken())
        order.push('adapter-drained')
        child.stdout.write(JSON.stringify({ type: 'migration_quiesced', requestId: request.requestId }) + '\n')
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
    }
    await runtime.quiesceForMigration()
    expect(order[0]).toBe('server-drained')
    expect(order.at(-1)).toBe('server-stopped')
    await expect(runtime.getServerUrl()).rejects.toThrow('Data migration')
    await expect(runtime.restartAdaptersSidecars()).rejects.toThrow('Data migration')
    expect(sidecarMocks.serverChildren).toHaveLength(1)
  })

  it('does not kill the server or acknowledge migration after an adapter drain failure', async () => {
    const runtime = createRuntime({ fetch: (async () => Response.json({ quiesced: true })) as typeof fetch })
    await runtime.startServer()
    for (const child of sidecarMocks.adapterChildren) {
      child.stdin.on('data', value => {
        const request = JSON.parse(value.toString())
        child.stdout.write(JSON.stringify({ type: 'migration_quiesce_failed', requestId: request.requestId }) + '\n')
        child.exitCode = 1
        child.emit('exit', 1, null)
      })
    }
    await expect(runtime.quiesceForMigration()).rejects.toThrow('Adapter did not confirm')
    expect(sidecarMocks.serverChildren[0]!.kill).not.toHaveBeenCalled()
    expect(sidecarMocks.serverChildren).toHaveLength(1)
    runtime.stopAll()
  })

  it.each(['before-control', 'during-control'] as const)('accepts credential-gated sidecars that become inactive %s and positively exit', async timing => {
    const runtime = createRuntime({ fetch: (async () => Response.json({ quiesced: true })) as typeof fetch })
    await runtime.startServer()
    for (const child of sidecarMocks.adapterChildren) {
      const complete = () => {
        child.stdout.write('{"type":"migration_adapter_inactive"}\n')
        queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0, null) })
      }
      if (timing === 'before-control') complete()
      else child.stdin.on('data', complete)
    }
    const server = sidecarMocks.serverChildren[0]!
    server.kill.mockImplementation(() => { server.exitCode = 0; server.emit('exit', 0, null) })
    await runtime.quiesceForMigration()
    expect(sidecarMocks.adapterChildren.every(child => child.exitCode === 0)).toBe(true)
    expect(await runtime.getMigrationPreview()).toEqual({ activeTasks: 0, externalProcesses: 0 })
  })

  it('rechecks outside live PID registrations after the source server has exited', async () => {
    const request = vi.fn(async () => Response.json({ quiesced: true }))
    const runtime = createRuntime({ fetch: request as typeof fetch })
    await runtime.startServer()
    for (const child of sidecarMocks.adapterChildren) {
      child.stdin.on('data', value => {
        const message = JSON.parse(value.toString())
        child.stdout.write(JSON.stringify({ type: 'migration_quiesced', requestId: message.requestId }) + '\n')
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
    }
    const server = sidecarMocks.serverChildren[0]!
    server.kill.mockImplementation(() => { server.exitCode = 0; server.emit('exit', 0, null) })
    await runtime.quiesceForMigration()
    expect(await runtime.getMigrationPreview()).toEqual({ activeTasks: 0, externalProcesses: 0 })
    const external = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      mkdirSync(path.join(isolatedConfigDir, 'sessions'))
      writeFileSync(path.join(isolatedConfigDir, 'sessions', `${external.pid}.json`), JSON.stringify({ pid: external.pid }))
      expect(await runtime.getMigrationPreview()).toEqual({ activeTasks: 0, externalProcesses: 1 })
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      external.kill('SIGKILL')
      await new Promise<void>(resolve => external.once('exit', () => resolve()))
    }
  })

  it('drains owned writers before restarting the source after an outside-writer rejection', async () => {
    const order: string[] = []
    const runtime = createRuntime({ fetch: (async input => {
      const route = String(input).split('/').at(-1)!
      order.push(route)
      return route === 'quiesce'
        ? Response.json({ error: 'Close external CLI sessions' }, { status: 409 })
        : Response.json({ quiesced: true })
    }) as typeof fetch })
    await runtime.startServer()
    const server = sidecarMocks.serverChildren[0]!
    server.kill.mockImplementation(() => {
      order.push('server-stopped')
      server.exitCode = 0
      server.emit('exit', 0, null)
    })
    for (const child of sidecarMocks.adapterChildren) {
      child.stdin.on('data', value => {
        const message = JSON.parse(value.toString())
        order.push('adapter-drained')
        child.stdout.write(JSON.stringify({ type: 'migration_quiesced', requestId: message.requestId }) + '\n')
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
    }
    await expect(runtime.quiesceForMigration()).rejects.toThrow('Close external CLI')
    expect(server.kill).not.toHaveBeenCalled()
    await runtime.resumeAfterMigration()
    expect(order.slice(0, 2)).toEqual(['quiesce', 'recover'])
    expect(order.at(-1)).toBe('server-stopped')
    expect(order.filter(value => value === 'adapter-drained')).toHaveLength(ADAPTER_COUNT)
    expect(sidecarMocks.serverChildren).toHaveLength(2)
    runtime.stopAll()
  })

  it('keeps adapters stopped until migrated startup is validated and explicitly activated', async () => {
    const paths: string[] = []
    const runtime = createRuntime({ env: { CC_HAHA_MIGRATION_VALIDATION: '1' }, fetch: (async input => {
      paths.push(String(input))
      return Response.json(String(input).endsWith('/validate') ? { valid: true } : { activated: true })
    }) as typeof fetch })
    await runtime.startServer()
    expect(sidecarMocks.adapterChildren).toHaveLength(0)
    await runtime.validateMigrationStartup()
    expect(sidecarMocks.adapterChildren).toHaveLength(0)
    await runtime.activateAfterMigrationValidation()
    expect(paths.map(value => value.split('/').at(-1))).toEqual(['validate', 'activate'])
    expect(sidecarMocks.adapterChildren).toHaveLength(ADAPTER_COUNT)
    runtime.stopAll()
  })

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
    expect(firstAdapters).toHaveLength(ADAPTER_COUNT)
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
    expect(sidecarMocks.adapterChildren).toHaveLength(ADAPTER_COUNT * 2)
    for (const adapter of firstAdapters) expect(adapter.kill).toHaveBeenCalledTimes(1)
    for (const adapter of sidecarMocks.adapterChildren.slice(ADAPTER_COUNT)) {
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

  it('keeps the pet capability independent and exposes it only to the server sidecar', async () => {
    const runtime = createRuntime()

    await runtime.startServer()

    const localToken = runtime.getLocalAccessToken()
    const petToken = runtime.getPetAccessToken()
    expect(localToken.length).toBeGreaterThanOrEqual(32)
    expect(petToken.length).toBeGreaterThanOrEqual(32)
    expect(petToken).not.toBe(localToken)
    expect(sidecarMocks.serverPlans[0]!.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(localToken)
    expect(sidecarMocks.serverPlans[0]!.env.CC_HAHA_PET_ACCESS_TOKEN).toBe(petToken)
    for (const adapter of sidecarMocks.spawnSidecar.mock.calls
      .map(([plan]) => plan)
      .filter(plan => plan.args[0] === 'adapters')) {
      expect(adapter.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(localToken)
      expect(adapter.env.CC_HAHA_PET_ACCESS_TOKEN).toBeUndefined()
    }
  })

  it('relays WeChat session expiry only from the current adapter generation', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as FetchMock
    const runtime = createRuntime({ fetchFn })
    await runtime.startServer()
    await waitForCallCount(fetchFn, 1)
    fetchFn.mockClear()
    const firstWechat = sidecarMocks.adapterChildren[2]!
    const expiryEvent = JSON.stringify({
      type: 'adapter_status',
      adapter: 'wechat',
      status: 'session_timeout',
      code: -14,
    })

    firstWechat.stdout.write(expiryEvent.slice(0, 20))
    firstWechat.stdout.write(`${expiryEvent.slice(20)}\n`)
    await waitForCallCount(fetchFn, 1)
    expect(fetchFn).toHaveBeenLastCalledWith(
      'http://127.0.0.1:49321/api/adapters/runtime-status',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${runtime.getLocalAccessToken()}`,
        }),
        body: JSON.stringify({
          platform: 'wechat',
          state: 'rebind_required',
          code: 'session_expired',
          generation: 1,
        }),
      }),
    )

    await runtime.restartAdaptersSidecars()
    await waitForCallCount(fetchFn, 2)
    fetchFn.mockClear()
    firstWechat.stdout.write(`${expiryEvent}\n`)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('gives the server only the dynamic bridge URL while adapters explicitly inherit it', async () => {
    const bridge = {
      start: vi.fn(async () => 'http://127.0.0.1:49123'),
      stop: vi.fn(async () => undefined),
    }
    const runtime = createRuntime({
      env: {
        HTTP_PROXY: 'http://stale.example:8080',
        HTTPS_PROXY: 'http://stale.example:8080',
        ALL_PROXY: 'socks5://stale.example:1080',
        all_proxy: 'socks5://stale.example:1080',
      },
      resolveSystemProxy: async () => 'DIRECT',
      proxyBridge: bridge,
    })

    await runtime.startServer()

    const serverEnv = sidecarMocks.serverPlans[0]!.env
    expect(serverEnv.CC_HAHA_SYSTEM_PROXY_URL).toBe('http://127.0.0.1:49123')
    expect(serverEnv.HTTP_PROXY).toBeUndefined()
    expect(serverEnv.HTTPS_PROXY).toBeUndefined()
    expect(serverEnv.ALL_PROXY).toBeUndefined()
    expect(serverEnv.all_proxy).toBeUndefined()
    const adapterPlans = sidecarMocks.spawnSidecar.mock.calls
      .map(([plan]) => plan)
      .filter(plan => plan.args[0] === 'adapters')
    expect(adapterPlans).toHaveLength(ADAPTER_COUNT)
    for (const plan of adapterPlans) {
      expect(plan.env.HTTP_PROXY).toBe('http://127.0.0.1:49123')
      expect(plan.env.HTTPS_PROXY).toBe('http://127.0.0.1:49123')
      expect(plan.env.ALL_PROXY).toBe('http://127.0.0.1:49123')
      expect(plan.env.all_proxy).toBe('http://127.0.0.1:49123')
    }

    runtime.stopAll()
    expect(bridge.stop).toHaveBeenCalledTimes(1)
  })

  it('does not spawn a server when stopAll races with proxy bridge startup', async () => {
    let releaseBridge!: (url: string) => void
    const bridge = {
      start: vi.fn(() => new Promise<string>(resolve => { releaseBridge = resolve })),
      stop: vi.fn(async () => undefined),
    }
    const runtime = createRuntime({
      resolveSystemProxy: async () => 'DIRECT',
      proxyBridge: bridge,
    })

    const starting = runtime.startServer()
    for (let attempt = 0; attempt < 10 && bridge.start.mock.calls.length === 0; attempt++) {
      await Promise.resolve()
    }
    expect(bridge.start).toHaveBeenCalledTimes(1)
    runtime.stopAll()
    releaseBridge('http://127.0.0.1:49123')

    await expect(starting).rejects.toThrow('server startup stopped')
    expect(sidecarMocks.spawnSidecar).not.toHaveBeenCalled()
    expect(bridge.stop).toHaveBeenCalledTimes(1)
  })

  it('waits for real server shutdown cleanup before the first restart attempt', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-electron-restart-'))
    const activeTurn = path.join(root, 'active-turn')
    const children: ChildProcess[] = []
    const readyFiles: string[] = []
    let serverStarts = 0
    const fixture = String.raw`
      const fs = require('node:fs')
      const activeTurn = process.argv[1]
      const readyFile = process.argv[2]
      let owned = false
      process.stdin.on('data', () => {
        setTimeout(() => {
          if (owned) fs.rmSync(activeTurn, { force: true })
          process.exit(0)
        }, 150)
      })
      try {
        const fd = fs.openSync(activeTurn, 'wx')
        fs.closeSync(fd)
        owned = true
        fs.writeFileSync(readyFile, 'ready')
      } catch {
        process.exit(17)
      }
      setInterval(() => {}, 1_000)
    `

    const runtime = new ElectronServerRuntime({
      desktopRoot: '/isolated/desktop',
      env: { CLAUDE_CONFIG_DIR: root },
      deps: {
        appendHostDiagnostic: () => undefined,
        // Use an inherited pipe: Windows does not deliver POSIX SIGTERM.
        killSidecar: child => {
          if (children.includes(child)) child.stdin!.write('stop\n')
          else child.kill()
        },
        preferredServerPorts: () => [],
        reserveServerPort: async () => 49321 + serverStarts,
        spawnSidecar: plan => {
          if (plan.args[0] !== 'server') {
            const child = new FakeSidecarChild()
            child.kill.mockImplementation(() => { child.exitCode = 0; child.emit('exit', 0, null) })
            return child as unknown as SidecarChild
          }
          const readyFile = path.join(root, `ready-${++serverStarts}`)
          readyFiles.push(readyFile)
          const child = spawn(process.execPath, ['-e', fixture, activeTurn, readyFile], {
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          children.push(child)
          return child as SidecarChild
        },
        waitForServer: async () => {
          const readyFile = readyFiles.at(-1)!
          for (let attempt = 0; attempt < 100 && !existsSync(readyFile); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10))
          }
          if (!existsSync(readyFile)) throw new Error('fixture server did not become ready')
        },
        writeLastServerPort: () => undefined,
      },
    })

    try {
      await runtime.startServer()
      expect(existsSync(activeTurn)).toBe(true)

      await runtime.stopAllAndWait(2_000)

      expect(existsSync(activeTurn)).toBe(false)
      await runtime.startServer()
      expect(serverStarts).toBe(2)
      expect(children[1]!.exitCode).toBeNull()
    } finally {
      await runtime.stopAllAndWait(2_000).catch(() => undefined)
      for (const child of children) {
        if (child.exitCode === null) child.kill('SIGKILL')
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes a sanitized bridge startup failure to the server without silently using direct mode', async () => {
    const bridge = {
      start: vi.fn(async () => {
        throw new Error('failed via https://user:password@proxy.example/path with sk-secret12345678')
      }),
      stop: vi.fn(async () => undefined),
    }
    const runtime = createRuntime({
      env: {
        HTTP_PROXY: 'http://stale.example:8080',
        HTTPS_PROXY: 'http://stale.example:8080',
        ALL_PROXY: 'socks5://stale.example:1080',
      },
      resolveSystemProxy: async () => 'DIRECT',
      proxyBridge: bridge,
    })

    await runtime.startServer()

    const serverEnv = sidecarMocks.serverPlans[0]!.env
    expect(serverEnv.HTTP_PROXY).toBeUndefined()
    expect(serverEnv.HTTPS_PROXY).toBeUndefined()
    expect(serverEnv.ALL_PROXY).toBeUndefined()
    expect(serverEnv.CC_HAHA_SYSTEM_PROXY_URL).toBeUndefined()
    expect(serverEnv[SYSTEM_PROXY_ERROR_ENV]).toContain('System proxy bridge unavailable: failed via')
    expect(serverEnv[SYSTEM_PROXY_ERROR_ENV]).not.toContain('password')
    expect(serverEnv[SYSTEM_PROXY_ERROR_ENV]).not.toContain('sk-secret')
    expect(sidecarMocks.serverChildren).toHaveLength(1)
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

  it('stops active adapters and waits for the replacement server to become healthy', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const activeAdapters = [...sidecarMocks.adapterChildren]
    let releaseReplacementHealth!: () => void
    sidecarMocks.waitForServerImpl = () => new Promise<void>(resolve => {
      releaseReplacementHealth = resolve
    })

    sidecarMocks.serverChildren[0]!.emit('exit', 19, null)
    await waitForServerChildren(2)

    for (const adapter of activeAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    let recoveredUrl: string | null = null
    const recovery = runtime.getServerUrl().then((url) => {
      recoveredUrl = url
    })
    await Promise.resolve()
    expect(recoveredUrl).toBeNull()

    releaseReplacementHealth()
    await recovery
    expect(recoveredUrl).toBe('http://127.0.0.1:49322')
    expect(sidecarMocks.adapterChildren).toHaveLength(ADAPTER_COUNT * 2)
  })

  it('keeps demand recovery available after an immediate restart fails transiently', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = createRuntime()
    await runtime.startServer()
    let replacementAttempts = 0
    sidecarMocks.waitForServerImpl = () => {
      replacementAttempts += 1
      return replacementAttempts === 1
        ? Promise.reject(new Error('port release race'))
        : Promise.resolve()
    }

    sidecarMocks.serverChildren[0]!.emit('exit', 24, null)
    await waitForServerChildren(2)
    await waitForMockCalls(sidecarMocks.serverChildren[1]!.kill, 1)

    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49323')
    expect(sidecarMocks.serverChildren).toHaveLength(3)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('failed to restart server sidecar after exit'),
    )
  })

  it('opens a circuit after three consecutive automatic restarts', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let now = 0
    const restartDelays: number[] = []
    const runtime = createRuntime({
      now: () => now,
      sleep: async (delayMs) => {
        restartDelays.push(delayMs)
        now += delayMs
      },
    })
    await runtime.startServer()

    for (let crash = 0; crash < 3; crash++) {
      sidecarMocks.serverChildren[crash]!.emit('exit', 30 + crash, null)
      await waitForServerChildren(crash + 2)
    }
    sidecarMocks.serverChildren[3]!.emit('exit', 33, null)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sidecarMocks.serverChildren).toHaveLength(4)
    await expect(runtime.getServerUrl()).rejects.toThrow('automatic restart paused')
    expect(restartDelays).toEqual([250, 1_000])
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('automatic restart paused after 3 consecutive crashes'),
    )

    now += 60_000
    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49325')
    expect(sidecarMocks.serverChildren).toHaveLength(5)
  })

  it('resets the automatic restart budget after a stable server window', async () => {
    let now = 0
    const restartDelays: number[] = []
    const runtime = createRuntime({
      now: () => now,
      sleep: async (delayMs) => {
        restartDelays.push(delayMs)
      },
    })
    await runtime.startServer()

    sidecarMocks.serverChildren[0]!.emit('exit', 40, null)
    await waitForServerChildren(2)
    now = 60_000
    sidecarMocks.serverChildren[1]!.emit('exit', 41, null)
    await waitForServerChildren(3)

    expect(restartDelays).toEqual([])
  })

  it('cancels a delayed automatic restart when the runtime stops', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let releaseBackoff!: () => void
    const sleep = vi.fn(() => new Promise<void>(resolve => {
      releaseBackoff = resolve
    }))
    const runtime = createRuntime({ now: () => 0, sleep })
    await runtime.startServer()

    sidecarMocks.serverChildren[0]!.emit('exit', 42, null)
    await waitForServerChildren(2)
    sidecarMocks.serverChildren[1]!.emit('exit', 43, null)
    await waitForMockCalls(sleep, 1)
    runtime.stopAll()
    releaseBackoff()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sidecarMocks.serverChildren).toHaveLength(2)
  })

  it('stops active adapters immediately when the server emits a process error', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const activeAdapters = [...sidecarMocks.adapterChildren]

    sidecarMocks.serverChildren[0]!.emit('error', new Error('active server failed'))
    await waitForServerChildren(2)

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
    const replacementAdapters = sidecarMocks.adapterChildren.slice(ADAPTER_COUNT)

    firstServer.emit('exit', 21, 'SIGTERM')

    expect(replacementAdapters).toHaveLength(ADAPTER_COUNT)
    for (const adapter of replacementAdapters) {
      expect(adapter.kill).not.toHaveBeenCalled()
    }
  })

  it('stops the current adapter generation after an explicit adapter restart', async () => {
    const runtime = createRuntime()
    await runtime.startServer()
    const firstAdapters = [...sidecarMocks.adapterChildren]

    await runtime.restartAdaptersSidecars()
    const restartedAdapters = sidecarMocks.adapterChildren.slice(ADAPTER_COUNT)
    sidecarMocks.serverChildren[0]!.emit('exit', 22, null)
    await waitForServerChildren(2)

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
    expect(sidecarMocks.adapterChildren).toHaveLength(ADAPTER_COUNT * 2)
    for (const adapter of originalAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    for (const adapter of sidecarMocks.adapterChildren.slice(ADAPTER_COUNT)) {
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

    expect(sidecarMocks.adapterChildren).toHaveLength(ADAPTER_COUNT + 1)
    for (const adapter of originalAdapters) {
      expect(adapter.kill).toHaveBeenCalledTimes(1)
    }
    expect(sidecarMocks.adapterChildren[ADAPTER_COUNT]!.kill).toHaveBeenCalledTimes(1)

    await expect(runtime.getServerUrl()).resolves.toBe('http://127.0.0.1:49322')
    expect(sidecarMocks.serverChildren).toHaveLength(2)
    expect(sidecarMocks.adapterChildren).toHaveLength(ADAPTER_COUNT * 2 + 1)
    for (const adapter of sidecarMocks.adapterChildren.slice(ADAPTER_COUNT + 1)) {
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
    expect(sidecarMocks.adapterChildren).toHaveLength(ADAPTER_COUNT + 1)
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
