/** Tiny stand-ins for the runtime tarballs and model files, served from loopback fixtures. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { InstallItem } from '../assets.js'
import { makeContent, startFixture, type Fixture, type FixtureBehavior } from '../../download/httpFixture.testUtil.js'

const run = promisify(execFile)

/** Builds an npm-style tarball (everything under `package/`). */
export async function makeTarball(files: Record<string, string>): Promise<Buffer> {
  const work = await mkdtemp(join(tmpdir(), 'voice-tarball-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(work, 'package', name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
    await run('tar', ['-czf', 'out.tgz', 'package'], { cwd: work })
    return await readFile(join(work, 'out.tgz'))
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export interface FakeAsset {
  item: InstallItem
  content: Buffer
  fixture: Fixture
}

export interface FakeAssets {
  items: InstallItem[]
  byTarget: Record<string, FakeAsset>
  totalBytes: number
  close(): Promise<void>
}

export async function startFakeAssets(
  behaviors: Record<string, FixtureBehavior> = {},
  overrides: Record<string, Buffer> = {},
): Promise<FakeAssets> {
  const byTarget: Record<string, FakeAsset> = {}
  const items: InstallItem[] = []

  const add = async (item: Omit<InstallItem, 'asset'>, content: Buffer, algorithm: 'sha256' | 'sha512'): Promise<void> => {
    const served = overrides[item.target] ?? content
    const fixture = await startFixture(served, behaviors[item.target] ?? {})
    const encoding = algorithm === 'sha256' ? 'hex' : 'base64'
    const name = item.kind === 'package' ? `${item.target}-1.13.8.tgz` : item.target
    const full: InstallItem = {
      ...item,
      asset: {
        name,
        bytes: content.length,
        hash: { algorithm, encoding, value: createHash(algorithm).update(content).digest(encoding) },
        urls: [`${fixture.origin}/${name}`],
      },
    }
    items.push(full)
    byTarget[item.target] = { item: full, content, fixture }
  }

  await add(
    { step: 'runtime', kind: 'package', target: 'sherpa-onnx-node', marker: 'sherpa-onnx.js' },
    await makeTarball({ 'sherpa-onnx.js': 'module.exports = {}', 'package.json': '{"name":"sherpa-onnx-node"}' }),
    'sha512',
  )
  await add(
    { step: 'runtime', kind: 'package', target: 'sherpa-onnx-test-arch', marker: 'sherpa-onnx.node' },
    await makeTarball({ 'sherpa-onnx.node': 'native-bytes', 'libonnxruntime.dylib': 'lib' }),
    'sha512',
  )
  await add({ step: 'model', kind: 'file', target: 'model.int8.onnx' }, makeContent(120_000, 1), 'sha256')
  await add({ step: 'model', kind: 'file', target: 'tokens.txt' }, makeContent(2_000, 2), 'sha256')
  await add({ step: 'vad', kind: 'file', target: 'silero_vad.onnx' }, makeContent(30_000, 3), 'sha256')

  return {
    items,
    byTarget,
    totalBytes: items.reduce((sum, item) => sum + item.asset.bytes, 0),
    close: async () => { await Promise.all(Object.values(byTarget).map(asset => asset.fixture.close())) },
  }
}
