import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalExecutable = process.execPath
const originalEmbeddedFiles = Bun.embeddedFiles
const directories: string[] = []

afterEach(async () => {
  Object.defineProperty(process, 'execPath', { value: originalExecutable })
  Bun.embeddedFiles = originalEmbeddedFiles
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('image processor module loading', () => {
  test('processes and creates images with the source-install sharp dependency', async () => {
    const sourceModule = './imageProcessor.js?source-test'
    const { getImageCreator, getImageProcessor } = await import(sourceModule)
    const creator = await getImageCreator()
    const processor = await getImageProcessor()
    const buffer = await creator({ create: {
      width: 4, height: 3, channels: 3, background: { r: 20, g: 40, b: 60 },
    } }).png().toBuffer()
    expect(await processor(buffer).metadata()).toMatchObject({ width: 4, height: 3, format: 'png' })
    expect(await getImageCreator()).toBe(creator)
    expect(await getImageProcessor()).toBe(processor)
  })

  test('loads both bundled image APIs from the executable installation instead of the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-image-module-'))
    directories.push(root)
    const moduleDirectory = join(root, 'app.asar.unpacked', 'node_modules', 'sharp')
    const executable = join(root, 'app.asar.unpacked', 'src-tauri', 'binaries', 'claude-sidecar')
    await mkdir(moduleDirectory, { recursive: true })
    await mkdir(join(root, 'app.asar.unpacked', 'src-tauri', 'binaries'), { recursive: true })
    await writeFile(join(moduleDirectory, 'package.json'), JSON.stringify({ name: 'sharp', main: 'index.cjs' }))
    await writeFile(join(moduleDirectory, 'index.cjs'), "module.exports = () => 'packaged-sharp-fixture'\n")
    Object.defineProperty(process, 'execPath', { value: executable })
    Bun.embeddedFiles = [new Blob(['compiled fixture'])] as typeof Bun.embeddedFiles

    const bundledModule = './imageProcessor.js?bundled-test'
    const { getImageCreator, getImageProcessor } = await import(bundledModule)
    const processor = await getImageProcessor()
    const creator = await getImageCreator()
    expect(processor(Buffer.alloc(0))).toBe('packaged-sharp-fixture')
    expect(creator({ create: {
      width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 },
    } })).toBe('packaged-sharp-fixture')
  })
})

async function runIsolated(script: string) {
  const proc = Bun.spawn(['bun', '-e', script], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('getImageProcessor', () => {
  test('falls back to sharp with a warning in bundled mode when native processor is unavailable', async () => {
    const result = await runIsolated(String.raw`
      import { mock } from 'bun:test'

      mock.module('./src/utils/bundledMode.js', () => ({
        isInBundledMode: () => true,
        isRunningWithBun: () => true,
      }))

      mock.module('image-processor-napi', () => {
        throw new Error('native module missing')
      })

      const modulePath = './src/tools/FileReadTool/' + 'imageProcessor.js'
      const { getImageProcessor, resetImageProcessorForTests } = await import(modulePath)
      resetImageProcessorForTests()

      // The native path fails, so the fallback must resolve to a usable sharp
      // function (the source-install dependency under test) instead of throwing.
      const processor = await getImageProcessor()
      if (typeof processor !== 'function') {
        throw new Error('expected fallback sharp function')
      }
    `)

    expect(result.exitCode).toBe(0)
    // The fallback must not be silent: the warning documents that the native
    // path failed and the bundled sharp copy took over.
    expect(result.stderr).toContain('Native image processor not available')
    expect(result.stderr).toContain('falling back to sharp')
  })
})
