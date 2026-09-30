/**
 * Tunnel provider abstraction for the H5 one-click public tunnel.
 *
 * Cloudflare (cloudflared) is the primary provider. When it cannot be brought
 * up — binary unavailable / download failed / spawn failed / no URL within the
 * timeout / early exit — the runtime falls back to Pinggy, which rides the
 * system `ssh` client and therefore needs no extra binary.
 *
 * The provider factories here only *start* a tunnel and hand back the live
 * process plus its public URL. Health checking and teardown bookkeeping stay in
 * serverRuntime so a single place owns the tunnel lifecycle.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  createTunnelPlan,
  killSidecar,
  spawnTunnel,
  waitForTunnelUrl,
  type H5TunnelMode,
  type SidecarChild,
  type SidecarPlan,
} from './sidecarManager'

/** Which provider is driving a tunnel. Mirrors the server-side union. */
export type H5TunnelProvider = 'cloudflare' | 'pinggy'

/**
 * Tunnel lifecycle state. Structurally identical to the server-side
 * `H5TunnelStatus` in src/server/services/h5AccessService.ts — the literal
 * values must stay in lockstep with it.
 */
export type H5TunnelStatus = 'idle' | 'starting' | 'running' | 'error'

/** A started tunnel: which provider, its public URL, and how to stop it. */
export type TunnelProviderInstance = {
  provider: H5TunnelProvider
  url: string
  child: SidecarChild
  stop: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

export type CloudflareTunnelOptions = {
  port: number
  mode: H5TunnelMode
  token?: string | null
  /** Public URL to report for a named tunnel (the user's bound domain). */
  namedUrl?: string | null
  env: NodeJS.ProcessEnv
  /**
   * Resolve a runnable cloudflared, downloading it when necessary. Runs inside
   * the caller's try/catch, so a download failure becomes a fallback trigger.
   */
  resolveBinary: () => Promise<string>
  /** Test seam: override the tunnel spawner. Defaults to sidecarManager.spawnTunnel. */
  spawnTunnelFn?: typeof spawnTunnel
  /** Test seam: override the URL waiter. Defaults to sidecarManager.waitForTunnelUrl. */
  waitForUrlFn?: typeof waitForTunnelUrl
  /** How long to wait for a quick-tunnel URL. Defaults to waitForTunnelUrl's own 30s. */
  timeoutMs?: number
  /**
   * Called synchronously right after the process is spawned, so the caller can
   * attach log capture before any output (including the URL line) is emitted.
   */
  onChild?: (child: SidecarChild) => void
}

/**
 * Start a Cloudflare tunnel. Throws (after killing any spawned process) when the
 * binary cannot be resolved, the process cannot be spawned, the quick-tunnel URL
 * is not printed in time, or the process exits first.
 */
export async function createCloudflareTunnel(options: CloudflareTunnelOptions): Promise<TunnelProviderInstance> {
  const binaryPath = await options.resolveBinary()
  const plan = createTunnelPlan({
    cloudflaredPath: binaryPath,
    port: options.port,
    mode: options.mode,
    token: options.token,
    env: options.env,
  })
  const child = (options.spawnTunnelFn ?? spawnTunnel)(plan)
  options.onChild?.(child)
  const stop = async () => {
    killSidecar(child)
  }

  try {
    let url: string
    if (options.mode === 'named') {
      if (!options.namedUrl) {
        throw new Error('A bound domain (public URL) is required for the named tunnel mode.')
      }
      url = options.namedUrl
    } else {
      url = await (options.waitForUrlFn ?? waitForTunnelUrl)(child, { timeoutMs: options.timeoutMs })
    }
    return { provider: 'cloudflare', url, child, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

// ---------------------------------------------------------------------------
// Pinggy (system ssh)
// ---------------------------------------------------------------------------

export const PINGGY_HOST = 'free.pinggy.io'
export const PINGGY_PORT = 443
export const PINGGY_IDENTITY_FILENAME = 'id_ed25519'
export const PINGGY_KNOWN_HOSTS_FILENAME = 'known_hosts'
/** How long to wait for Pinggy to print its public URL after ssh connects. */
export const PINGGY_URL_TIMEOUT_MS = 30_000

/**
 * Public URL printed by Pinggy, e.g.
 * "https://rnabv-1-2-3-4.a.free.pinggy.link". Accepts any sub-domain of the
 * three Pinggy public suffixes.
 */
export const PINGGY_URL_RE = /https:\/\/[a-z0-9][a-z0-9.-]*\.(?:pinggy\.link|pinggy-free\.link|pinggy\.online)\b/i

export type PinggySshArgsOptions = {
  port: number
  identityPath: string
  knownHostsPath: string
  /** Local host the tunnel forwards to. Defaults to loopback. */
  controlHost?: string
  /** Remote Pinggy host. Defaults to free.pinggy.io. */
  host?: string
  /** Remote ssh port. Defaults to 443 (the port Pinggy serves free tunnels on). */
  remotePort?: number
}

/**
 * Build the `ssh` argv for a Pinggy reverse tunnel.
 *
 * `-R 0:...` asks the server to assign a random public port. The dedicated
 * known-hosts file plus `StrictHostKeyChecking=accept-new` keeps us out of the
 * user's ~/.ssh/known_hosts. No `-o User=` is passed: Pinggy's free tier accepts
 * any username and we do not want to imply a third-party product identity.
 */
export function buildPinggySshArgs(options: PinggySshArgsOptions): string[] {
  const {
    port,
    identityPath,
    knownHostsPath,
    controlHost = '127.0.0.1',
    host = PINGGY_HOST,
    remotePort = PINGGY_PORT,
  } = options
  return [
    '-p', String(remotePort),
    '-R', `0:${controlHost}:${port}`,
    '-i', identityPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
    host,
  ]
}

/** Extract the first Pinggy public URL from a chunk of ssh output, or null. */
export function extractPinggyUrl(text: string): string | null {
  const match = text.match(PINGGY_URL_RE)
  return match ? match[0] : null
}

export type ResolveSshDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawnSyncFn?: typeof spawnSync
  existsSyncFn?: typeof existsSync
}

/**
 * Locate the system ssh client. Windows uses `where ssh`, POSIX uses `which
 * ssh`; both fall back to the usual install locations. Returns null when no ssh
 * is available so the caller can raise a clear error.
 */
export function resolveSshPath(deps: ResolveSshDeps = {}): string | null {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const spawnSyncFn = deps.spawnSyncFn ?? spawnSync

  const locator = platform === 'win32' ? 'where' : 'which'
  try {
    const result = spawnSyncFn(locator, ['ssh'], { encoding: 'utf-8', windowsHide: true, env })
    if (result.status === 0) {
      const first = String(result.stdout ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean)
      if (first) return first
    }
  } catch {
    // Fall through to the well-known locations below.
  }

  const exists = deps.existsSyncFn ?? existsSync
  const systemRoot = platform === 'win32'
    ? (env.SystemRoot || env.windir || 'C:\\Windows')
    : ''
  const candidates = platform === 'win32'
    ? [path.win32.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe')]
    : ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

export type PinggyIdentity = {
  identityPath: string
  knownHostsPath: string
  generated: boolean
}

export type EnsurePinggyIdentityDeps = {
  spawnSyncFn?: typeof spawnSync
  existsSyncFn?: typeof existsSync
  mkdirSyncFn?: typeof mkdirSync
}

/**
 * Ensure a dedicated ed25519 identity key exists for Pinggy inside `directory`,
 * generating it with ssh-keygen on first use. The matching known-hosts file is
 * expected to live in the same directory. Reusing the key keeps Pinggy's
 * free-tier identity stable across restarts.
 */
export function ensurePinggyIdentity(directory: string, deps: EnsurePinggyIdentityDeps = {}): PinggyIdentity {
  const exists = deps.existsSyncFn ?? existsSync
  const spawnSyncFn = deps.spawnSyncFn ?? spawnSync
  const mkdirSyncFn = deps.mkdirSyncFn ?? mkdirSync
  const identityPath = path.join(directory, PINGGY_IDENTITY_FILENAME)
  const knownHostsPath = path.join(directory, PINGGY_KNOWN_HOSTS_FILENAME)

  if (exists(identityPath)) return { identityPath, knownHostsPath, generated: false }

  mkdirSyncFn(directory, { recursive: true, mode: 0o700 })
  const result = spawnSyncFn(
    'ssh-keygen',
    ['-t', 'ed25519', '-N', '', '-q', '-f', identityPath],
    { stdio: 'ignore', windowsHide: true },
  )
  if (result.error) {
    throw new Error(`Failed to generate a Pinggy SSH identity key: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`ssh-keygen exited with code ${result.status ?? 'unknown'} while creating the Pinggy identity key.`)
  }
  if (!exists(identityPath)) {
    throw new Error(`ssh-keygen did not create the Pinggy identity key at ${identityPath}.`)
  }
  return { identityPath, knownHostsPath, generated: true }
}

export type PinggyTunnelDeps = {
  resolveSshPath?: typeof resolveSshPath
  ensureIdentity?: typeof ensurePinggyIdentity
  spawnTunnelFn?: typeof spawnTunnel
  waitForUrlFn?: typeof waitForTunnelUrl
}

export type PinggyTunnelOptions = {
  port: number
  /** Directory holding the identity key + known-hosts file (a pinggy/ dir). */
  directory: string
  env: NodeJS.ProcessEnv
  controlHost?: string
  timeoutMs?: number
  /** Called synchronously right after ssh is spawned, before any output. */
  onChild?: (child: SidecarChild) => void
  /** Test seams for the ssh lookup / key generation / process plumbing. */
  deps?: PinggyTunnelDeps
}

/**
 * Start a Pinggy tunnel over the system ssh client. Throws (after killing any
 * spawned process) when ssh is missing, the key cannot be generated, the
 * process cannot be spawned, or no public URL is printed in time.
 */
export async function createPinggyTunnel(options: PinggyTunnelOptions): Promise<TunnelProviderInstance> {
  const deps = options.deps ?? {}
  const sshPath = (deps.resolveSshPath ?? resolveSshPath)()
  if (!sshPath) {
    throw new Error(
      'Pinggy fallback requires the system ssh client, but no ssh executable was found '
      + '(looked it up via `where ssh` / `which ssh` and the usual install paths). Install OpenSSH and retry.',
    )
  }

  const identity = (deps.ensureIdentity ?? ensurePinggyIdentity)(options.directory)
  const plan: SidecarPlan = {
    command: sshPath,
    args: buildPinggySshArgs({
      port: options.port,
      identityPath: identity.identityPath,
      knownHostsPath: identity.knownHostsPath,
      controlHost: options.controlHost,
    }),
    env: options.env,
  }
  const child = (deps.spawnTunnelFn ?? spawnTunnel)(plan)
  options.onChild?.(child)
  const stop = async () => {
    killSidecar(child)
  }

  try {
    const url = await (deps.waitForUrlFn ?? waitForTunnelUrl)(child, {
      regex: PINGGY_URL_RE,
      timeoutMs: options.timeoutMs ?? PINGGY_URL_TIMEOUT_MS,
    })
    return { provider: 'pinggy', url, child, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
