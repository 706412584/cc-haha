import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SidecarChild, SidecarPlan } from './sidecarManager'
import {
  buildPinggySshArgs,
  createCloudflareTunnel,
  createPinggyTunnel,
  ensurePinggyIdentity,
  extractPinggyUrl,
  PINGGY_IDENTITY_FILENAME,
  PINGGY_KNOWN_HOSTS_FILENAME,
  resolveSshPath,
} from './tunnelProvider'

function fakeChild() {
  // No pid: killSidecar then terminates directly via child.kill() on every
  // platform, instead of shelling out to Windows taskkill.
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  }) as unknown as SidecarChild & { kill: ReturnType<typeof vi.fn> }
}

describe('buildPinggySshArgs', () => {
  it('builds the documented reverse-tunnel argv with an isolated known-hosts file', () => {
    const args = buildPinggySshArgs({
      port: 28670,
      identityPath: '/home/u/.claude/pinggy/id_ed25519',
      knownHostsPath: '/home/u/.claude/pinggy/known_hosts',
    })

    expect(args).toEqual([
      '-p', '443',
      '-R', '0:127.0.0.1:28670',
      '-i', '/home/u/.claude/pinggy/id_ed25519',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'UserKnownHostsFile=/home/u/.claude/pinggy/known_hosts',
      'free.pinggy.io',
    ])
  })

  it('never pins a third-party username and uses the caller known-hosts path', () => {
    const args = buildPinggySshArgs({
      port: 8000,
      identityPath: '/k/id',
      knownHostsPath: '/k/known_hosts',
    })
    expect(args.join(' ')).not.toMatch(/-o User=/)
    expect(args).not.toContain('dsh')
    expect(args).toContain('UserKnownHostsFile=/k/known_hosts')
  })

  it('honors an explicit host, remote port, and control host', () => {
    const args = buildPinggySshArgs({
      port: 1234,
      identityPath: '/k/id',
      knownHostsPath: '/k/known_hosts',
      controlHost: 'localhost',
      host: 'example.pinggy.io',
      remotePort: 22,
    })
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('22')
    expect(args).toContain('0:localhost:1234')
    expect(args.at(-1)).toBe('example.pinggy.io')
  })
})

describe('extractPinggyUrl', () => {
  it.each([
    ['https://rnabv-1-2-3-4.a.free.pinggy.link', 'https://rnabv-1-2-3-4.a.free.pinggy.link'],
    ['https://abc-1-2-3-4.pinggy-free.link', 'https://abc-1-2-3-4.pinggy-free.link'],
    ['https://xyz-1-2-3-4.pinggy.online', 'https://xyz-1-2-3-4.pinggy.online'],
  ])('extracts the Pinggy URL from ssh output (%s)', (output, expected) => {
    expect(extractPinggyUrl(`Warning: Permanently added...\n${output}\n`)).toBe(expected)
  })

  it('returns the first URL when several appear', () => {
    const output = 'https://first-1.a.free.pinggy.link then https://second-2.pinggy.online'
    expect(extractPinggyUrl(output)).toBe('https://first-1.a.free.pinggy.link')
  })

  it('returns null when no Pinggy URL is present', () => {
    expect(extractPinggyUrl('Permission denied (publickey).')).toBeNull()
    expect(extractPinggyUrl('https://not-pinggy.example.com')).toBeNull()
    expect(extractPinggyUrl('')).toBeNull()
  })
})

describe('resolveSshPath', () => {
  it('returns the ssh path reported by the platform locator', () => {
    const spawnSyncFn = vi.fn(() => ({ status: 0, stdout: '/usr/bin/ssh\n' }))
    expect(resolveSshPath({
      platform: 'linux',
      spawnSyncFn: spawnSyncFn as never,
      existsSyncFn: (() => false) as never,
    })).toBe('/usr/bin/ssh')
    expect(spawnSyncFn).toHaveBeenCalledWith('which', ['ssh'], expect.objectContaining({ encoding: 'utf-8' }))
  })

  it('uses `where ssh` on Windows', () => {
    const spawnSyncFn = vi.fn(() => ({ status: 0, stdout: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe\r\n' }))
    expect(resolveSshPath({
      platform: 'win32',
      spawnSyncFn: spawnSyncFn as never,
      existsSyncFn: (() => false) as never,
    })).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe')
    expect(spawnSyncFn).toHaveBeenCalledWith('where', ['ssh'], expect.anything())
  })

  it('falls back to well-known install locations when the locator misses', () => {
    expect(resolveSshPath({
      platform: 'linux',
      spawnSyncFn: (() => ({ status: 1, stdout: '' })) as never,
      existsSyncFn: ((p: string) => p === '/usr/bin/ssh') as never,
    })).toBe('/usr/bin/ssh')
  })

  it('returns null when no ssh can be found', () => {
    expect(resolveSshPath({
      platform: 'linux',
      spawnSyncFn: (() => ({ status: 1, stdout: '' })) as never,
      existsSyncFn: (() => false) as never,
    })).toBeNull()
  })
})

describe('ensurePinggyIdentity', () => {
  it('reuses an existing identity key without shelling out', () => {
    const spawnSyncFn = vi.fn()
    const identity = ensurePinggyIdentity('/cache/pinggy', {
      existsSyncFn: ((p: string) => p.endsWith(PINGGY_IDENTITY_FILENAME)) as never,
      spawnSyncFn: spawnSyncFn as never,
    })
    expect(identity.generated).toBe(false)
    expect(identity.identityPath).toContain(PINGGY_IDENTITY_FILENAME)
    expect(identity.knownHostsPath).toContain(PINGGY_KNOWN_HOSTS_FILENAME)
    expect(spawnSyncFn).not.toHaveBeenCalled()
  })

  it('generates an ed25519 key with ssh-keygen on first use', () => {
    const spawnSyncFn = vi.fn((..._args: unknown[]) => ({ status: 0 }))
    let generated = false
    const identity = ensurePinggyIdentity('/cache/pinggy', {
      existsSyncFn: ((p: string) => generated && p.endsWith(PINGGY_IDENTITY_FILENAME)) as never,
      spawnSyncFn: ((command: string, args: string[], options: unknown) => {
        generated = true
        return spawnSyncFn(command, args, options)
      }) as never,
    })
    expect(identity.generated).toBe(true)
    expect(spawnSyncFn).toHaveBeenCalledWith(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-q', '-f', expect.stringContaining(PINGGY_IDENTITY_FILENAME)],
      expect.objectContaining({ stdio: 'ignore' }),
    )
  })

  it('raises a clear error when ssh-keygen fails', () => {
    expect(() => ensurePinggyIdentity('/cache/pinggy', {
      existsSyncFn: (() => false) as never,
      spawnSyncFn: (() => ({ status: 1 })) as never,
    })).toThrow(/ssh-keygen exited with code 1/)
  })
})

describe('createPinggyTunnel', () => {
  const identity = { identityPath: '/cache/pinggy/id_ed25519', knownHostsPath: '/cache/pinggy/known_hosts', generated: false }

  it('spawns ssh with the built args and resolves the public URL', async () => {
    const child = fakeChild()
    const plans: SidecarPlan[] = []
    const instance = await createPinggyTunnel({
      port: 28670,
      directory: '/cache/pinggy',
      env: {},
      deps: {
        resolveSshPath: (() => '/usr/bin/ssh') as never,
        ensureIdentity: (() => identity) as never,
        spawnTunnelFn: ((plan: SidecarPlan) => {
          plans.push(plan)
          return child
        }) as never,
        waitForUrlFn: (async () => 'https://abc-1-2-3-4.a.free.pinggy.link') as never,
      },
    })

    expect(instance.provider).toBe('pinggy')
    expect(instance.url).toBe('https://abc-1-2-3-4.a.free.pinggy.link')
    expect(instance.child).toBe(child)
    expect(plans[0]!.command).toBe('/usr/bin/ssh')
    expect(plans[0]!.args).toContain('0:127.0.0.1:28670')
    expect(plans[0]!.args.at(-1)).toBe('free.pinggy.io')
  })

  it('calls onChild synchronously at spawn time, before the URL resolves', async () => {
    const child = fakeChild()
    const seen: SidecarChild[] = []
    const instance = await createPinggyTunnel({
      port: 28670,
      directory: '/cache/pinggy',
      env: {},
      onChild: (spawned) => seen.push(spawned),
      deps: {
        resolveSshPath: (() => '/usr/bin/ssh') as never,
        ensureIdentity: (() => identity) as never,
        spawnTunnelFn: (() => child) as never,
        waitForUrlFn: (async () => 'https://abc-1-2-3-4.a.free.pinggy.link') as never,
      },
    })
    expect(seen).toEqual([child])
    expect(instance.child).toBe(child)
  })

  it('throws a clear error when no ssh client is available', async () => {
    await expect(createPinggyTunnel({
      port: 28670,
      directory: '/cache/pinggy',
      env: {},
      deps: { resolveSshPath: (() => null) as never },
    })).rejects.toThrow(/requires the system ssh client/i)
  })

  it('kills the ssh process when no URL is produced', async () => {
    const child = fakeChild()
    await expect(createPinggyTunnel({
      port: 28670,
      directory: '/cache/pinggy',
      env: {},
      deps: {
        resolveSshPath: (() => '/usr/bin/ssh') as never,
        ensureIdentity: (() => identity) as never,
        spawnTunnelFn: (() => child) as never,
        waitForUrlFn: (async () => { throw new Error('Timed out') }) as never,
      },
    })).rejects.toThrow('Timed out')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})

describe('createCloudflareTunnel', () => {
  it('resolves the binary before spawning and returns the scraped URL', async () => {
    const child = fakeChild()
    const resolveBinary = vi.fn(async () => '/cache/cloudflared/2026.9.3/cloudflared')
    const spawnTunnelFn = vi.fn(() => child)
    const instance = await createCloudflareTunnel({
      port: 28670,
      mode: 'quick',
      env: {},
      resolveBinary,
      spawnTunnelFn: spawnTunnelFn as never,
      waitForUrlFn: (async () => 'https://random-words.trycloudflare.com') as never,
    })

    expect(resolveBinary).toHaveBeenCalledTimes(1)
    expect(spawnTunnelFn).toHaveBeenCalledTimes(1)
    expect(instance.provider).toBe('cloudflare')
    expect(instance.url).toBe('https://random-words.trycloudflare.com')
  })

  it('calls onChild at spawn time so the caller can capture logs', async () => {
    const child = fakeChild()
    const seen: SidecarChild[] = []
    await createCloudflareTunnel({
      port: 28670,
      mode: 'quick',
      env: {},
      onChild: (spawned) => seen.push(spawned),
      resolveBinary: async () => '/cache/cloudflared',
      spawnTunnelFn: (() => child) as never,
      waitForUrlFn: (async () => 'https://random-words.trycloudflare.com') as never,
    })
    expect(seen).toEqual([child])
  })

  it('propagates a binary resolution failure without spawning', async () => {
    const spawnTunnelFn = vi.fn()
    await expect(createCloudflareTunnel({
      port: 28670,
      mode: 'quick',
      env: {},
      resolveBinary: async () => { throw new Error('download failed') },
      spawnTunnelFn: spawnTunnelFn as never,
    })).rejects.toThrow('download failed')
    expect(spawnTunnelFn).not.toHaveBeenCalled()
  })

  it('uses the bound domain for a named tunnel instead of waiting for output', async () => {
    const child = fakeChild()
    const waitForUrlFn = vi.fn()
    const instance = await createCloudflareTunnel({
      port: 28670,
      mode: 'named',
      token: 'cf-token',
      namedUrl: 'https://chat.example.com',
      env: {},
      resolveBinary: async () => '/cache/cloudflared',
      spawnTunnelFn: (() => child) as never,
      waitForUrlFn: waitForUrlFn as never,
    })
    expect(instance.url).toBe('https://chat.example.com')
    expect(waitForUrlFn).not.toHaveBeenCalled()
  })

  it('kills the process when a named tunnel is missing its bound domain', async () => {
    const child = fakeChild()
    await expect(createCloudflareTunnel({
      port: 28670,
      mode: 'named',
      token: 'cf-token',
      namedUrl: null,
      env: {},
      resolveBinary: async () => '/cache/cloudflared',
      spawnTunnelFn: (() => child) as never,
    })).rejects.toThrow(/bound domain/i)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
