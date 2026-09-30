import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { spawnSync } from 'node:child_process'

vi.mock('node:https', () => ({ default: { get: vi.fn() } }))

import https from 'node:https'
import { CLOUDFLARED_VERSION, ensureCloudflaredBinary, resolveAssetSpec } from './cloudflaredBinary'

const httpsGet = https.get as unknown as ReturnType<typeof vi.fn>
const directories: string[] = []

afterEach(() => {
  httpsGet.mockReset()
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function tempCache(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloudflared-binary-'))
  directories.push(directory)
  return directory
}

/**
 * Minimal IncomingMessage stand-in. It is a real PassThrough (so pipeline()
 * reads and destroys it correctly) augmented with the status/headers a
 * node:https response would carry.
 */
type FakeResponse = IncomingMessage & PassThrough

function fakeResponse(statusCode: number, headers: Record<string, string> = {}): FakeResponse {
  const stream = new PassThrough()
  return Object.assign(stream, { statusCode, headers }) as unknown as FakeResponse
}

type FakeRequest = EventEmitter & { setTimeout: ReturnType<typeof vi.fn>, destroy: (error?: Error) => void, end: () => void }

function fakeRequest(): FakeRequest {
  const request = new EventEmitter() as FakeRequest
  request.setTimeout = vi.fn()
  request.destroy = (error?: Error) => {
    if (error) request.emit('error', error)
  }
  request.end = () => {}
  return request
}

function specFor(platform: NodeJS.Platform, arch: string) {
  const spec = resolveAssetSpec(platform, arch)
  if (!spec) throw new Error(`missing spec for ${platform}-${arch}`)
  return spec
}

function baseOptions(cacheDir: string, platform: NodeJS.Platform, arch: string) {
  return {
    cacheDir,
    platform,
    arch,
    // Never resolve a real installed cloudflared during tests.
    env: {} as NodeJS.ProcessEnv,
    spawnSyncFn: vi.fn(() => ({ status: 1 })) as unknown as typeof spawnSync,
    sleepFn: vi.fn(async () => {}),
  }
}

describe('resolveAssetSpec', () => {
  it('maps the six supported platform/arch combinations', () => {
    expect(resolveAssetSpec('win32', 'x64')).toEqual({ asset: 'cloudflared-windows-amd64.exe', isTarGz: false, sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2' })
    expect(resolveAssetSpec('win32', 'arm64')).toEqual({ asset: 'cloudflared-windows-amd64.exe', isTarGz: false, sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2' })
    expect(resolveAssetSpec('darwin', 'x64')).toEqual({ asset: 'cloudflared-darwin-amd64.tgz', isTarGz: true, sha256: 'd1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977' })
    expect(resolveAssetSpec('darwin', 'arm64')).toEqual({ asset: 'cloudflared-darwin-arm64.tgz', isTarGz: true, sha256: '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095' })
    expect(resolveAssetSpec('linux', 'x64')).toEqual({ asset: 'cloudflared-linux-amd64', isTarGz: false, sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2' })
    expect(resolveAssetSpec('linux', 'arm64')).toEqual({ asset: 'cloudflared-linux-arm64', isTarGz: false, sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d' })
  })

  it('normalizes amd64 to x64', () => {
    expect(resolveAssetSpec('linux', 'amd64')).toEqual(resolveAssetSpec('linux', 'x64'))
    expect(resolveAssetSpec('win32', 'amd64')).toEqual(resolveAssetSpec('win32', 'x64'))
    expect(resolveAssetSpec('darwin', 'amd64')).toEqual(resolveAssetSpec('darwin', 'x64'))
  })

  it('returns null for unsupported platforms and architectures', () => {
    expect(resolveAssetSpec('freebsd', 'x64')).toBeNull()
    expect(resolveAssetSpec('linux', 'riscv64')).toBeNull()
    expect(resolveAssetSpec('linux', 'arm')).toBeNull()
  })
})

describe('ensureCloudflaredBinary download pipeline', () => {
  it('writes the binary, verifies sha256, and returns the versioned path', async () => {
    const cacheDir = tempCache()
    const payload = Buffer.from('cloudflared-linux-amd64-binary')
    const spec = specFor('linux', 'x64')
    const options = baseOptions(cacheDir, 'linux', 'x64')
    const seenProgress: number[] = []
    await ensureCloudflaredBinary({
      ...options,
      onProgress: progress => seenProgress.push(progress.receivedBytes),
      downloadFn: async (_url, dest, onProgress) => {
        onProgress?.({ receivedBytes: 4, totalBytes: payload.length })
        writeFileSync(dest, payload)
        onProgress?.({ receivedBytes: payload.length, totalBytes: payload.length })
      },
      hashFn: () => spec.sha256,
    })
    const target = path.join(cacheDir, 'cloudflared', CLOUDFLARED_VERSION, 'cloudflared')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target)).toEqual(payload)
    expect(seenProgress).toEqual([4, payload.length])
  })

  it('deletes the temp file and throws on checksum mismatch', async () => {
    const cacheDir = tempCache()
    await expect(
      ensureCloudflaredBinary({
        ...baseOptions(cacheDir, 'linux', 'x64'),
        downloadFn: async (_url, dest) => writeFileSync(dest, 'wrong bytes'),
        hashFn: () => 'deadbeef',
      }),
    ).rejects.toThrow(/checksum mismatch/)
    const versionDir = path.join(cacheDir, 'cloudflared', CLOUDFLARED_VERSION)
    expect(readdirSync(versionDir)).toEqual([])
  })

  it('skips download when the versioned cache already has the binary', async () => {
    const cacheDir = tempCache()
    const versionDir = path.join(cacheDir, 'cloudflared', CLOUDFLARED_VERSION)
    mkdirSync(versionDir, { recursive: true })
    const target = path.join(versionDir, 'cloudflared')
    writeFileSync(target, 'cached')
    const downloadFn = vi.fn()
    const result = await ensureCloudflaredBinary({ ...baseOptions(cacheDir, 'linux', 'x64'), downloadFn })
    expect(result).toBe(target)
    expect(downloadFn).not.toHaveBeenCalled()
  })

  it('treats a stale version directory as a miss and downloads again', async () => {
    const cacheDir = tempCache()
    const staleDir = path.join(cacheDir, 'cloudflared', '2020.1.1')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(path.join(staleDir, 'cloudflared'), 'old')
    const spec = specFor('linux', 'x64')
    const downloadFn = vi.fn(async (_url: string, dest: string) => writeFileSync(dest, 'new'))
    const result = await ensureCloudflaredBinary({
      ...baseOptions(cacheDir, 'linux', 'x64'),
      downloadFn,
      hashFn: () => spec.sha256,
    })
    expect(downloadFn).toHaveBeenCalledTimes(1)
    expect(result).toBe(path.join(cacheDir, 'cloudflared', CLOUDFLARED_VERSION, 'cloudflared'))
  })

  it('sweeps stale .download-* files before downloading', async () => {
    const cacheDir = tempCache()
    const versionDir = path.join(cacheDir, 'cloudflared', CLOUDFLARED_VERSION)
    mkdirSync(versionDir, { recursive: true })
    const stale = path.join(versionDir, 'cloudflared.download-deadbeef')
    writeFileSync(stale, 'partial')
    const spec = specFor('linux', 'x64')
    await ensureCloudflaredBinary({
      ...baseOptions(cacheDir, 'linux', 'x64'),
      downloadFn: async (_url, dest) => writeFileSync(dest, 'fresh'),
      hashFn: () => spec.sha256,
    })
    expect(existsSync(stale)).toBe(false)
  })

  it('extracts darwin archives with a relative name and cwd (GNU tar drive-colon bug)', async () => {
    const cacheDir = tempCache()
    const spec = specFor('darwin', 'x64')
    const versionDir = path.join(cacheDir, 'cloudflared', CLOUDFLARED_VERSION)
    const spawnSyncMock = vi.fn((_command: string, args: string[], options: { cwd?: string }) => {
      // The PATH probe must miss so we reach the download path.
      if (args.includes('--version')) return { status: 1 }
      // Simulate `tar -xzf <archive>` dropping the binary into the cwd.
      writeFileSync(path.join(options.cwd ?? '.', 'cloudflared'), 'extracted')
      return { status: 0 }
    })

    const result = await ensureCloudflaredBinary({
      ...baseOptions(cacheDir, 'darwin', 'x64'),
      spawnSyncFn: spawnSyncMock as unknown as typeof spawnSync,
      downloadFn: async (_url, dest) => writeFileSync(dest, 'tgz-bytes'),
      hashFn: () => spec.sha256,
    })

    expect(result).toBe(path.join(versionDir, 'cloudflared'))
    const tarCall = spawnSyncMock.mock.calls.find(call => call[0] === 'tar')
    expect(tarCall?.[1]?.[0]).toBe('-xzf')
    // Archive argument must be relative (no drive colon), with cwd set to the target dir.
    expect(path.isAbsolute(tarCall?.[1]?.[1] as string)).toBe(false)
    expect((tarCall?.[2] as { cwd?: string })?.cwd).toBe(versionDir)
    expect(existsSync(result)).toBe(true)
  })

  it('honors CLOUDFLARED_PATH when the override exists', async () => {
    const cacheDir = tempCache()
    const override = path.join(cacheDir, 'custom-cloudflared')
    writeFileSync(override, 'x')
    const downloadFn = vi.fn()
    const result = await ensureCloudflaredBinary({
      ...baseOptions(cacheDir, 'linux', 'x64'),
      env: { CLOUDFLARED_PATH: override } as NodeJS.ProcessEnv,
      downloadFn,
    })
    expect(result).toBe(override)
    expect(downloadFn).not.toHaveBeenCalled()
  })

  it('builds the download URL from CC_HAHA_CLOUDFLARED_BASE_URL', async () => {
    const cacheDir = tempCache()
    const spec = specFor('linux', 'x64')
    let requestedUrl = ''
    await ensureCloudflaredBinary({
      ...baseOptions(cacheDir, 'linux', 'x64'),
      env: { CC_HAHA_CLOUDFLARED_BASE_URL: 'https://mirror.example.com/cloudflared/' } as NodeJS.ProcessEnv,
      downloadFn: async (url, dest) => {
        requestedUrl = url
        writeFileSync(dest, 'x')
      },
      hashFn: () => spec.sha256,
    })
    expect(requestedUrl).toBe(`https://mirror.example.com/cloudflared/${spec.asset}`)
  })
})

describe('ensureCloudflaredBinary network behaviour', () => {
  it('does not hang when the connection is reset after the 200 headers', async () => {
    const cacheDir = tempCache()
    httpsGet.mockImplementation((_url: string, _options: unknown, callback: (r: IncomingMessage) => void) => {
      const response = fakeResponse(200, { 'content-length': '100' })
      const request = fakeRequest()
      callback(response)
      // Deliver a partial body, then simulate a reset: Node emits 'aborted' on
      // the response and 'error' on the stream without ever completing.
      setTimeout(() => {
        response.push(Buffer.alloc(10))
        response.emit('aborted')
        response.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
      }, 0)
      return request
    })

    const promise = ensureCloudflaredBinary({ ...baseOptions(cacheDir, 'linux', 'x64'), sleepFn: async () => {} })
    await expect(promise).rejects.toThrow(/aborted/)
    const versionDir = path.join(cacheDir, 'cloudflared', CLOUDFLARED_VERSION)
    expect(readdirSync(versionDir)).toEqual([])
  })

  it('retries retryable errors and eventually succeeds', async () => {
    const cacheDir = tempCache()
    const spec = specFor('linux', 'x64')
    let attempts = 0
    const response = fakeResponse(200, { 'content-length': String(spec.sha256.length) })
    const request = fakeRequest()
    httpsGet.mockImplementation((_url: string, _options: unknown, callback: (r: IncomingMessage) => void) => {
      attempts += 1
      if (attempts === 1) {
        const failing = fakeRequest()
        setTimeout(() => failing.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })), 0)
        return failing
      }
      callback(response)
      setTimeout(() => {
        // Provide bytes whose hash we do not control; hashFn seam validates it.
        response.push(Buffer.from('ok'))
        response.end()
      }, 0)
      return request
    })
    const result = await ensureCloudflaredBinary({ ...baseOptions(cacheDir, 'linux', 'x64'), hashFn: () => spec.sha256 })
    expect(attempts).toBe(2)
    expect(existsSync(result)).toBe(true)
  })

  it('does not retry non-retryable errors', async () => {
    const cacheDir = tempCache()
    let attempts = 0
    httpsGet.mockImplementation(() => {
      attempts += 1
      const failing = fakeRequest()
      setTimeout(() => failing.emit('error', Object.assign(new Error('bad certificate'), { code: 'CERT_HAS_EXPIRED' })), 0)
      return failing
    })
    await expect(ensureCloudflaredBinary({ ...baseOptions(cacheDir, 'linux', 'x64') })).rejects.toThrow(/bad certificate/)
    expect(attempts).toBe(1)
  })

  it('follows redirects up to the limit', async () => {
    const cacheDir = tempCache()
    const spec = specFor('linux', 'x64')
    let calls = 0
    httpsGet.mockImplementation((_url: string, _options: unknown, callback: (r: IncomingMessage) => void) => {
      calls += 1
      if (calls <= 2) {
        const redirect = fakeResponse(302, { location: `https://objects.githubusercontent.com/step-${calls}` })
        setTimeout(() => callback(redirect), 0)
        return fakeRequest()
      }
      const response = fakeResponse(200, { 'content-length': '1' })
      setTimeout(() => {
        callback(response)
        response.push(Buffer.from('x'))
        response.end()
      }, 0)
      return fakeRequest()
    })
    const result = await ensureCloudflaredBinary({ ...baseOptions(cacheDir, 'linux', 'x64'), hashFn: () => spec.sha256 })
    expect(calls).toBe(3)
    expect(existsSync(result)).toBe(true)
  })

  it('times out a stalled request by destroying it', async () => {
    const cacheDir = tempCache()
    const requests: FakeRequest[] = []
    httpsGet.mockImplementation(() => {
      let timeoutCallback: (() => void) | null = null
      const request = fakeRequest()
      request.setTimeout = vi.fn((_ms: number, callback: () => void) => {
        timeoutCallback = callback
      })
      request.destroy = vi.fn((error?: Error) => {
        if (error) request.emit('error', error)
      })
      requests.push(request)
      setTimeout(() => timeoutCallback?.(), 0)
      return request
    })
    await expect(ensureCloudflaredBinary({ ...baseOptions(cacheDir, 'linux', 'x64') })).rejects.toThrow(/timed out/)
    expect(requests[0]?.destroy).toHaveBeenCalled()
  })
})
