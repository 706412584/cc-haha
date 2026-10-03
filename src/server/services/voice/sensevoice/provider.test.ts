import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { partPathFor } from '../download/index.js'
import { bypassProxyForLoopback, makeContent } from '../download/httpFixture.testUtil.js'
import { VoiceServiceError } from '../errors.js'
import type { VoicePreparationState } from '../types.js'
import { makeWav } from './__fixtures__/wav.js'
import { startFakeAssets, type FakeAssets } from './__fixtures__/fakeAssets.js'
import { installItems, totalDownloadBytes } from './assets.js'
import { createSenseVoiceProvider, type SenseVoiceProvider, type SenseVoiceProviderOptions } from './provider.js'
import { senseVoiceLayout } from './layout.js'
import type { SpawnWorker } from './recognizer.js'

const fakeWorker = fileURLToPath(new URL('./__fixtures__/fakeWorker.mjs', import.meta.url))
const spawnFake: SpawnWorker = ({ env, cwd }) => spawn(process.execPath, [fakeWorker], { env, cwd, stdio: 'pipe' })
const noSleep = async () => {}

let restoreProxyEnv: () => void
let dataRoot: string
let assets: FakeAssets | undefined
let providers: SenseVoiceProvider[]

beforeAll(() => { restoreProxyEnv = bypassProxyForLoopback() })
afterAll(() => { restoreProxyEnv() })

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'voice-provider-'))
  providers = []
})

afterEach(async () => {
  await Promise.all(providers.map(provider => provider.dispose()))
  await assets?.close()
  assets = undefined
  await rm(dataRoot, { recursive: true, force: true })
})

async function setup(
  behaviors: Parameters<typeof startFakeAssets>[0] = {},
  overrides: Partial<SenseVoiceProviderOptions> = {},
  tampered: Parameters<typeof startFakeAssets>[1] = {},
): Promise<SenseVoiceProvider> {
  assets = await startFakeAssets(behaviors, tampered)
  return make(overrides)
}

function make(overrides: Partial<SenseVoiceProviderOptions> = {}): SenseVoiceProvider {
  const provider = createSenseVoiceProvider({
    dataRoot,
    items: assets!.items,
    fetch: (input, init) => fetch(input, init as RequestInit),
    sleep: noSleep,
    spawnWorker: spawnFake,
    download: { maxRetries: 0, progressIntervalMs: 0, probeTimeoutMs: 100 },
    ...overrides,
  })
  providers.push(provider)
  return provider
}

async function prepareCollecting(provider: SenseVoiceProvider, signal = new AbortController().signal) {
  const states: VoicePreparationState[] = []
  const error = await provider.preparation.prepare(signal, state => states.push(state)).then(() => undefined, e => e)
  return { states, error }
}

const exists = (path: string) => stat(path).then(() => true, () => false)

describe('provider info and pinned assets', () => {
  it('describes the local SenseVoice provider with the size of what it downloads', () => {
    const provider = createSenseVoiceProvider({ dataRoot, platform: { platform: 'darwin', arch: 'arm64' } })
    providers.push(provider)
    expect(provider.info).toEqual({
      id: 'sensevoice-local',
      name: 'SenseVoice Small (INT8)',
      location: 'local',
      languages: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
      // sherpa-onnx-node + sherpa-onnx-darwin-arm64 + model.int8.onnx + tokens.txt + silero_vad.onnx
      downloadBytes: 11_954 + 10_047_754 + 239_233_841 + 315_894 + 1_807_522,
    })
  })

  it.each([
    ['darwin', 'arm64', 'sherpa-onnx-darwin-arm64'],
    ['darwin', 'x64', 'sherpa-onnx-darwin-x64'],
    ['linux', 'x64', 'sherpa-onnx-linux-x64'],
    ['linux', 'arm64', 'sherpa-onnx-linux-arm64'],
    ['win32', 'x64', 'sherpa-onnx-win-x64'],
  ] as const)('maps %s/%s to %s and pins every download', (platform, arch, nativePackage) => {
    const provider = createSenseVoiceProvider({ dataRoot, platform: { platform, arch } })
    providers.push(provider)
    const platformKey = nativePackage.replace('sherpa-onnx-', '')
    const items = installItems(platformKey as Parameters<typeof installItems>[0])
    expect(items.map(item => item.target)).toEqual([
      'sherpa-onnx-node', nativePackage, 'model.int8.onnx', 'tokens.txt', 'silero_vad.onnx',
    ])
    expect(provider.info.downloadBytes).toBe(totalDownloadBytes(items))
    for (const { asset } of items) {
      expect(asset.bytes).toBeGreaterThan(0)
      expect(asset.urls.length).toBeGreaterThanOrEqual(2)
      expect(new Set(asset.urls.map(url => new URL(url).origin)).size).toBe(asset.urls.length)
      if (asset.name.endsWith('.tgz')) {
        expect(asset.hash).toMatchObject({ algorithm: 'sha512', encoding: 'base64' })
        expect(asset.hash.value).toMatch(/^[A-Za-z0-9+/]{86}==$/)
        expect(asset.urls[0]).toBe(`https://registry.npmjs.org/${asset.name.replace('-1.13.8.tgz', '')}/-/${asset.name}`)
        expect(asset.urls[1]).toStartWith('https://registry.npmmirror.com/')
      } else {
        expect(asset.hash).toMatchObject({ algorithm: 'sha256', encoding: 'hex' })
        expect(asset.hash.value).toMatch(/^[a-f0-9]{64}$/)
        expect(asset.urls[0]).toStartWith('https://huggingface.co/')
        expect(asset.urls[1]).toStartWith('https://hf-mirror.com/')
      }
    }
  })

  it.each([
    ['auto', ['https://registry.npmjs.org', 'https://registry.npmmirror.com'], ['https://huggingface.co', 'https://hf-mirror.com']],
    ['official', ['https://registry.npmjs.org'], ['https://huggingface.co']],
    ['mirror', ['https://registry.npmmirror.com'], ['https://hf-mirror.com']],
  ] as const)('download source %s selects only its hosts, official first', (source, npmOrigins, modelOrigins) => {
    const items = installItems('win-x64', source)
    const auto = installItems('win-x64')
    // The source only changes where bytes come from, never what is installed.
    expect(items.map(item => [item.target, item.asset.bytes, item.asset.hash])).toEqual(
      auto.map(item => [item.target, item.asset.bytes, item.asset.hash]),
    )
    for (const { asset } of items) {
      const origins = asset.urls.map(url => new URL(url).origin)
      expect(origins).toEqual([...(asset.name.endsWith('.tgz') ? npmOrigins : modelOrigins)])
    }
  })

  it('prepare() contacts only the hosts of the requested download source', async () => {
    const requested: string[] = []
    const provider = createSenseVoiceProvider({
      dataRoot,
      platform: { platform: 'win32', arch: 'x64' },
      fetch: async input => {
        requested.push(new URL(String(input)).origin)
        throw new TypeError('fetch failed')
      },
      sleep: noSleep,
      spawnWorker: spawnFake,
      download: { maxRetries: 0, progressIntervalMs: 0, probeTimeoutMs: 100 },
    })
    providers.push(provider)

    const error = await provider.preparation
      .prepare(new AbortController().signal, () => {}, { downloadSource: 'mirror' })
      .then(() => undefined, e => e)

    expect(error).toBeDefined()
    expect(requested.length).toBeGreaterThan(0)
    expect(new Set(requested)).toEqual(new Set(['https://registry.npmmirror.com']))
  })

  it('reports an unsupported platform instead of pretending it can download', async () => {
    const provider = createSenseVoiceProvider({ dataRoot, platform: { platform: 'freebsd', arch: 'x64' } })
    providers.push(provider)

    expect(await provider.preparation.status()).toMatchObject({ phase: 'failed', error: { reason: 'unsupported-platform' } })
    const states: VoicePreparationState[] = []
    const error = await provider.preparation.prepare(new AbortController().signal, state => states.push(state)).catch(e => e)
    expect(error).toBeInstanceOf(VoiceServiceError)
    expect(states.at(-1)).toMatchObject({ phase: 'failed', error: { reason: 'unsupported-platform' } })
    await expect(provider.transcribe(makeWav(1), { language: 'zh' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'voice/not-ready' })
  })
})

describe('prepare', () => {
  it('installs runtime, model and VAD in order and ends ready', async () => {
    const provider = await setup()
    expect(await provider.preparation.status()).toEqual({ phase: 'unprepared' })

    const { states, error } = await prepareCollecting(provider)

    expect(error).toBeUndefined()
    const sequence = states.map(state => `${state.phase}:${state.step ?? ''}`)
    const firstOf = (marker: string) => sequence.indexOf(marker)
    expect(firstOf('downloading:runtime')).toBeLessThan(firstOf('downloading:model'))
    expect(firstOf('downloading:model')).toBeLessThan(firstOf('downloading:vad'))
    expect(firstOf('downloading:vad')).toBeLessThan(firstOf('verifying:verify'))
    expect(states.at(-1)).toEqual({ phase: 'ready' })

    const downloading = states.filter(state => state.phase === 'downloading')
    expect(downloading.every(state => state.totalBytes === assets!.totalBytes)).toBe(true)
    const completed = downloading.map(state => state.completedBytes!)
    expect([...completed].sort((a, b) => a - b)).toEqual(completed)
    expect(downloading.at(-1)!.completedBytes).toBe(assets!.totalBytes)
    expect(downloading.some(state => state.resource === 'model.int8.onnx' && state.source?.startsWith('http://127.0.0.1'))).toBe(true)

    const layout = senseVoiceLayout(dataRoot)
    expect(await readFile(join(layout.models, 'tokens.txt'))).toEqual(assets!.byTarget['tokens.txt']!.content)
    expect(await readFile(join(layout.runtimeRoot, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'), 'utf8')).toBe('module.exports = {}')
    expect(await readFile(join(layout.runtimeRoot, 'node_modules', 'sherpa-onnx-test-arch', 'sherpa-onnx.node'), 'utf8')).toBe('native-bytes')
    // No tarballs or staging directories are left behind.
    expect(await readdir(layout.downloads)).toEqual([])
    expect(await readdir(layout.staging)).toEqual([])
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })

  it('answers readiness from the verified record without touching the network or rehashing', async () => {
    const provider = await setup()
    await prepareCollecting(provider)
    await assets!.close()

    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
    // A second prepare is a no-op that still ends ready.
    const again = await prepareCollecting(provider)
    expect(again.error).toBeUndefined()
    expect(again.states.at(-1)).toEqual({ phase: 'ready' })
    expect(again.states.some(state => state.phase === 'downloading')).toBe(false)
  })

  it('stays ready when only a file mtime changes (backup, copy or sync tools rewrite it)', async () => {
    const provider = await setup()
    await prepareCollecting(provider)
    const layout = senseVoiceLayout(dataRoot)
    const future = new Date(Date.now() + 60_000)

    await utimes(join(layout.models, 'model.int8.onnx'), future, future)
    await utimes(join(layout.runtimeRoot, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'), future, future)

    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })

  it('treats a truncated, deleted or unrecorded file as not installed and repairs it', async () => {
    const provider = await setup()
    await prepareCollecting(provider)
    const layout = senseVoiceLayout(dataRoot)
    const model = join(layout.models, 'model.int8.onnx')

    await truncate(model, 100)
    expect((await provider.preparation.status()).phase).toBe('unprepared')
    await prepareCollecting(provider)
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
    expect(await readFile(model)).toEqual(assets!.byTarget['model.int8.onnx']!.content)

    await rm(join(layout.models, 'tokens.txt'))
    expect((await provider.preparation.status()).phase).toBe('unprepared')
    await prepareCollecting(provider)
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })

    await rm(layout.manifest)
    expect((await provider.preparation.status()).phase).toBe('unprepared')
    // The files are intact, so re-recording them must not download anything again.
    const gets = assets!.byTarget['model.int8.onnx']!.fixture.gets().length
    await prepareCollecting(provider)
    expect(assets!.byTarget['model.int8.onnx']!.fixture.gets().length).toBe(gets)
  })

  it('keeps progress across an interrupted download and resumes from the partial file', async () => {
    const provider = await setup({ 'model.int8.onnx': { breakAfter: 50_000, chunkDelayMs: 2 } })

    const first = await prepareCollecting(provider)

    expect(first.states.at(-1)).toMatchObject({
      phase: 'failed', step: 'model', resource: 'model.int8.onnx', error: { reason: 'network' },
    })
    expect(first.error).toBeDefined()
    const layout = senseVoiceLayout(dataRoot)
    const partial = (await stat(partPathFor(join(layout.models, 'model.int8.onnx')))).size
    expect(partial).toBeGreaterThan(0)
    // The partial bytes are visible before the user clicks download again.
    const status = await provider.preparation.status()
    expect(status).toMatchObject({ phase: 'unprepared', totalBytes: assets!.totalBytes })
    expect(status.completedBytes).toBeGreaterThan(partial)

    assets!.byTarget['model.int8.onnx']!.fixture.behavior.breakAfter = undefined
    const second = await prepareCollecting(provider)

    expect(second.error).toBeUndefined()
    const resumed = second.states.find(state => state.resumedFromBytes !== undefined)
    const runtimeBytes = assets!.items.slice(0, 2).reduce((sum, item) => sum + item.asset.bytes, 0)
    expect(resumed?.resumedFromBytes).toBe(runtimeBytes + partial)
    expect(assets!.byTarget['model.int8.onnx']!.fixture.gets().at(-1)?.range).toBe(`bytes=${partial}-`)
    expect(await readFile(join(layout.models, 'model.int8.onnx'))).toEqual(assets!.byTarget['model.int8.onnx']!.content)
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })

  it('retries interruptions on its own within one prepare', async () => {
    const provider = await setup(
      { 'model.int8.onnx': { breakAfter: 30_000, breakRequests: 2, chunkDelayMs: 2 } },
      { download: { maxRetries: 3, progressIntervalMs: 0, probeTimeoutMs: 100 } },
    )
    const { states, error } = await prepareCollecting(provider)
    expect(error).toBeUndefined()
    expect(states.at(-1)).toEqual({ phase: 'ready' })
    expect(states.some(state => (state.resumedFromBytes ?? 0) > 0)).toBe(true)
  })

  it('cancels, keeps the partial download, and continues it next time', async () => {
    const provider = await setup({ 'model.int8.onnx': { chunkDelayMs: 5 } })
    const controller = new AbortController()
    const states: VoicePreparationState[] = []

    const error = await provider.preparation.prepare(controller.signal, state => {
      states.push(state)
      if (state.resource === 'model.int8.onnx' && (state.completedBytes ?? 0) > assets!.items[0]!.asset.bytes + assets!.items[1]!.asset.bytes + 40_000) {
        controller.abort()
      }
    }).catch(e => e)

    expect(error).toBeDefined()
    expect(states.at(-1)).toMatchObject({ phase: 'cancelled', totalBytes: assets!.totalBytes })
    const layout = senseVoiceLayout(dataRoot)
    expect(await exists(partPathFor(join(layout.models, 'model.int8.onnx')))).toBe(true)

    const again = await prepareCollecting(provider)
    expect(again.error).toBeUndefined()
    expect(again.states.some(state => state.resumedFromBytes !== undefined)).toBe(true)
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })

  it('reports HTTP failures with the failing resource and status', async () => {
    const provider = await setup({ 'silero_vad.onnx': { status: 404 } })
    const { states, error } = await prepareCollecting(provider)
    expect(error).toBeDefined()
    expect(states.at(-1)).toMatchObject({
      phase: 'failed', step: 'vad', resource: 'silero_vad.onnx',
      error: { reason: 'http', status: 404, resource: 'silero_vad.onnx' },
    })
    // Items that already verified stay installed.
    expect(await exists(join(senseVoiceLayout(dataRoot).models, 'model.int8.onnx'))).toBe(true)
  })

  it('rejects a tampered download and installs nothing from it', async () => {
    const tampered = Buffer.from(makeContent(120_000, 1))
    tampered[10] ^= 1
    const provider = await setup({}, {}, { 'model.int8.onnx': tampered })

    const { states } = await prepareCollecting(provider)

    expect(states.at(-1)).toMatchObject({ phase: 'failed', error: { reason: 'integrity' } })
    const layout = senseVoiceLayout(dataRoot)
    expect(await exists(join(layout.models, 'model.int8.onnx'))).toBe(false)
    expect(await exists(partPathFor(join(layout.models, 'model.int8.onnx')))).toBe(false)
    expect((await provider.preparation.status()).phase).toBe('unprepared')
  })

  it('fails when a runtime package does not contain its entry file', async () => {
    const provider = await setup({}, {
      extract: async ({ cwd, into }) => {
        // Extracts nothing: an archive with an unexpected layout.
        await writeFile(join(cwd, into, 'unrelated.txt'), 'x')
      },
    })
    const { states } = await prepareCollecting(provider)
    expect(states.at(-1)).toMatchObject({ phase: 'failed', step: 'runtime', error: { reason: 'integrity' } })
  })

  it('reports a failed unpack as a storage problem', async () => {
    const provider = await setup({}, {
      extract: async () => { throw Object.assign(new Error('tar exploded'), { code: 'ENOSPC' }) },
    })
    const { states } = await prepareCollecting(provider)
    expect(states.at(-1)).toMatchObject({ phase: 'failed', error: { reason: 'storage' } })
  })

  it('refuses a second concurrent prepare', async () => {
    const provider = await setup({ 'model.int8.onnx': { chunkDelayMs: 20 } })
    const running = prepareCollecting(provider)
    await new Promise(resolve => setTimeout(resolve, 30))
    const second = await provider.preparation.prepare(new AbortController().signal, () => {}).catch(e => e)
    expect(second.message).toContain('already running')
    expect((await running).error).toBeUndefined()
  })
})

describe('remove', () => {
  it('deletes the runtime, models and partial files', async () => {
    const provider = await setup()
    await prepareCollecting(provider)

    await provider.preparation.remove()

    expect(await exists(senseVoiceLayout(dataRoot).base)).toBe(false)
    expect(await provider.preparation.status()).toEqual({ phase: 'unprepared' })
  })

  it('stops a running worker before deleting', async () => {
    const provider = await setup()
    await prepareCollecting(provider)
    await provider.transcribe(makeWav(1), { language: 'zh' }, new AbortController().signal)
    const [pid] = (await readFile(join(senseVoiceLayout(dataRoot).models, 'starts.log'), 'utf8')).split('\n')

    await provider.preparation.remove()

    expect(() => process.kill(Number(pid), 0)).toThrow()
  })
})

describe('transcribe', () => {
  const signal = () => new AbortController().signal

  it('refuses to run before the assets are installed', async () => {
    const provider = await setup()
    const error = await provider.transcribe(makeWav(1), { language: 'zh' }, signal()).catch(e => e)
    expect(error).toBeInstanceOf(VoiceServiceError)
    expect(error.code).toBe('voice/not-ready')
  })

  it('transcribes through the worker once installed', async () => {
    const provider = await setup()
    await prepareCollecting(provider)

    const result = await provider.transcribe(makeWav(1), { language: 'ja' }, signal())

    expect(result).toEqual({ text: 'echo:ja', audioSeconds: 1, inferenceSeconds: 0.01 })
  })

  it('reclaims the idle worker after the configured time', async () => {
    const provider = await setup({}, { idleTimeoutMs: 100 })
    await prepareCollecting(provider)
    await provider.transcribe(makeWav(1), { language: 'zh' }, signal())
    const [pid] = (await readFile(join(senseVoiceLayout(dataRoot).models, 'starts.log'), 'utf8')).split('\n')

    const deadline = Date.now() + 3000
    const alive = () => { try { process.kill(Number(pid), 0); return true } catch { return false } }
    while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(alive()).toBe(false)
  })
})
