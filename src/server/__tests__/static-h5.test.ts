import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleStaticH5Request } from '../staticH5.js'

let distDir: string
const savedEnv = {
  CLAUDE_H5_DIST_DIR: process.env.CLAUDE_H5_DIST_DIR,
  CLAUDE_APP_ROOT: process.env.CLAUDE_APP_ROOT,
}

beforeEach(async () => {
  distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-h5-'))
  await fs.mkdir(path.join(distDir, 'assets', 'pdfjs-0.0.0', 'cmaps'), { recursive: true })
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>app</title>')
  await fs.writeFile(path.join(distDir, 'assets', 'worker.mjs'), 'export {}')
  await fs.writeFile(path.join(distDir, 'assets', 'decoder.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]))
  await fs.writeFile(path.join(distDir, 'assets', 'pdfjs-0.0.0', 'cmaps', 'UniGB-UCS2-H.bcmap'), Buffer.from([0x01]))
  process.env.CLAUDE_H5_DIST_DIR = distDir
  delete process.env.CLAUDE_APP_ROOT
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(distDir, { recursive: true, force: true })
})

async function get(pathname: string): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1${pathname}`)
  return handleStaticH5Request(new Request(url), url)
}

describe('handleStaticH5Request media types', () => {
  it('serves .mjs as a JavaScript module, which browsers require of module scripts and workers', async () => {
    const res = await get('/assets/worker.mjs')

    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  })

  it('serves .wasm as application/wasm, which instantiateStreaming requires', async () => {
    const res = await get('/assets/decoder.wasm')

    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('application/wasm')
  })

  it('leaves binary data files such as cMaps as octet-stream', async () => {
    const res = await get('/assets/pdfjs-0.0.0/cmaps/UniGB-UCS2-H.bcmap')

    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('caches hashed assets immutably and never caches the entry document', async () => {
    expect((await get('/assets/worker.mjs'))?.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect((await get('/index.html'))?.headers.get('cache-control')).toBe('no-store')
  })

  it('does not serve a path that escapes the dist directory', async () => {
    expect(await get('/..%2f..%2fetc/passwd')).toBeNull()
  })
})
