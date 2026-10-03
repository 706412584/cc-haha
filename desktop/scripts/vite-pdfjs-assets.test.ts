// @vitest-environment node
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Plugin } from 'vite'
import { createPdfEngine } from '../src/components/workspace/surfaces/document/pdfEngine'
import {
  PDFJS_ASSET_DIRS,
  PDFJS_ASSET_FOLDERS,
  pdfjsAssetsPrefix,
} from '../src/components/workspace/surfaces/document/pdfAssets'
import { listPdfjsAssets, pdfjsAssets } from './vite-pdfjs-assets'

const realPackageDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const realVersion = (JSON.parse(fs.readFileSync(path.join(realPackageDir, 'package.json'), 'utf8')) as { version: string }).version

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A stand-in pdfjs-dist with a file or two in each data folder. */
function fakePackage(options: { omit?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfjs-assets-'))
  tempDirs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pdfjs-dist', version: '9.8.7' }))
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'not a data file')
  for (const folder of PDFJS_ASSET_DIRS) {
    if (folder === options.omit) continue
    fs.mkdirSync(path.join(dir, folder))
    fs.writeFileSync(path.join(dir, folder, `${folder}-one.bin`), `${folder} one`)
    fs.writeFileSync(path.join(dir, folder, 'LICENSE'), `${folder} licence`)
  }
  fs.writeFileSync(path.join(dir, 'wasm', 'quickjs-eval.wasm'), 'scripting sandbox')
  fs.writeFileSync(path.join(dir, 'wasm', 'quickjs-eval.js'), 'scripting sandbox')
  fs.writeFileSync(path.join(dir, 'wasm', 'decoder.wasm'), 'a decoder')
  return dir
}

type Emitted = { type: string; fileName: string; source: Buffer }

function build(plugin: Plugin): Emitted[] {
  const emitted: Emitted[] = []
  const generateBundle = plugin.generateBundle as (this: unknown, ...args: unknown[]) => void
  generateBundle.call({ emitFile: (file: Emitted) => emitted.push(file) }, {}, {}, false)
  return emitted
}

type Middleware = (request: { url?: string }, response: unknown, next: () => void) => void

function devServer(plugin: Plugin) {
  const mounted: Array<{ at: string; handler: Middleware }> = []
  const configureServer = plugin.configureServer as (server: unknown) => void
  configureServer({ middlewares: { use: (at: string, handler: Middleware) => mounted.push({ at, handler }) } })
  return mounted
}

/** Ask the dev middleware for `url`; resolves with what it sent, or `null` if it passed the request on. */
async function request(plugin: Plugin, url: string) {
  const [middleware] = devServer(plugin)
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  const response = Object.assign(new PassThrough(), {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value },
  })
  response.on('data', (chunk: Buffer) => chunks.push(chunk))
  return new Promise<{ body: Buffer; headers: Record<string, string> } | null>((resolve) => {
    response.on('end', () => resolve({ body: Buffer.concat(chunks), headers }))
    middleware!.handler({ url }, response, () => resolve(null))
  })
}

describe('listPdfjsAssets', () => {
  it('lists the four data folders, licences included', () => {
    const files = listPdfjsAssets(fakePackage()).sort()

    expect(files).toEqual([
      'cmaps/LICENSE',
      'cmaps/cmaps-one.bin',
      'iccs/LICENSE',
      'iccs/iccs-one.bin',
      'standard_fonts/LICENSE',
      'standard_fonts/standard_fonts-one.bin',
      'wasm/LICENSE',
      'wasm/decoder.wasm',
      'wasm/wasm-one.bin',
    ])
  })

  it('leaves out the scripting sandbox, which a read-only preview never runs', () => {
    const files = listPdfjsAssets(fakePackage())

    expect(files.filter((file) => file.includes('quickjs'))).toEqual([])
    expect(files).toContain('wasm/decoder.wasm')
  })

  it('does not ship anything else in the package', () => {
    expect(listPdfjsAssets(fakePackage()).some((file) => file.includes('secret') || file.includes('package.json'))).toBe(false)
  })

  it('fails the build by naming the missing folder, rather than shipping a viewer that cannot read Chinese', () => {
    expect(() => listPdfjsAssets(fakePackage({ omit: 'cmaps' }))).toThrow(/no "cmaps" folder/)
  })

  it('finds what a real pdfjs-dist ships: CJK CMaps, the standard fonts, the JPEG 2000 decoder, and their licences', () => {
    const files = listPdfjsAssets(realPackageDir)

    expect(files).toEqual(expect.arrayContaining([
      'cmaps/UniGB-UCS2-H.bcmap',
      'cmaps/Adobe-GB1-UCS2.bcmap',
      'standard_fonts/LiberationSans-Regular.ttf',
      'standard_fonts/FoxitSerif.pfb',
      'standard_fonts/LICENSE_FOXIT',
      'standard_fonts/LICENSE_LIBERATION',
      'wasm/openjpeg.wasm',
      'wasm/qcms_bg.wasm',
      'wasm/LICENSE_OPENJPEG',
      'iccs/CGATS001Compat-v2-micro.icc',
    ]))
    expect(files.some((file) => file.includes('quickjs-eval'))).toBe(false)
  })
})

describe('the build', () => {
  it('emits every file under a folder named for the installed version, with fixed names', () => {
    const dir = fakePackage()

    const emitted = build(pdfjsAssets({ packageDir: dir }))

    expect(emitted.every((file) => file.type === 'asset')).toBe(true)
    expect(emitted.map((file) => file.fileName).sort()).toEqual(
      listPdfjsAssets(dir).map((file) => `assets/pdfjs-9.8.7/${file}`).sort(),
    )
  })

  it('ships the bytes of the files, unchanged', () => {
    const dir = fakePackage()

    const emitted = build(pdfjsAssets({ packageDir: dir }))

    expect(emitted.find((file) => file.fileName === 'assets/pdfjs-9.8.7/wasm/decoder.wasm')!.source.toString()).toBe('a decoder')
  })

  it('names the folder for the version that is installed, so an upgrade cannot be served stale data', () => {
    const emitted = build(pdfjsAssets())

    expect(emitted.length).toBeGreaterThan(100)
    expect(emitted.every((file) => file.fileName.startsWith(`assets/pdfjs-${realVersion}/`))).toBe(true)
  })

  it('uses the same version string the engine builds its URLs from at run time', async () => {
    const { version } = await import('pdfjs-dist/legacy/build/pdf.mjs')

    expect(version).toBe(realVersion)
  })
})

describe('the dev server', () => {
  it('serves the data at the URL the app will use once built', () => {
    const [middleware] = devServer(pdfjsAssets({ packageDir: fakePackage() }))

    expect(middleware!.at).toBe(`/${pdfjsAssetsPrefix('9.8.7')}`)
  })

  it('serves a data file, uncached', async () => {
    const plugin = pdfjsAssets({ packageDir: fakePackage() })

    const served = await request(plugin, '/cmaps/cmaps-one.bin')

    expect(served!.body.toString()).toBe('cmaps one')
    expect(served!.headers['content-type']).toBe('application/octet-stream')
    expect(served!.headers['cache-control']).toBe('no-cache')
  })

  it('serves wasm as wasm, which streaming compilation insists on', async () => {
    const served = await request(pdfjsAssets({ packageDir: fakePackage() }), '/wasm/decoder.wasm')

    expect(served!.headers['content-type']).toBe('application/wasm')
  })

  it('ignores a query string', async () => {
    const served = await request(pdfjsAssets({ packageDir: fakePackage() }), '/iccs/iccs-one.bin?v=1')

    expect(served!.body.toString()).toBe('iccs one')
  })

  // Every way out here leads to a file that exists, so that it is the guard that stops
  // it, not the file's absence.
  it.each([
    ['a file outside the data folders', () => '/package.json'],
    ['a sibling file, by way of the data folder', () => '/cmaps/../secret.txt'],
    ['an encoded slash way out', () => '/cmaps/..%2fsecret.txt'],
    ['an encoded way out and back in again', (dir: string) => `/%2e%2e/${path.basename(dir)}/secret.txt`],
    ['a way out and back in again', (dir: string) => `/../${path.basename(dir)}/secret.txt`],
    ['a file that does not exist', () => '/cmaps/nothing.bin'],
    ['the scripting sandbox', () => '/wasm/quickjs-eval.wasm'],
    ['a folder', () => '/cmaps'],
    ['the root', () => '/'],
    ['a malformed escape', () => '/cmaps/%E0%A4%A'],
  ])('passes on %s', async (_label, urlFor) => {
    const dir = fakePackage()

    const served = await request(pdfjsAssets({ packageDir: dir }), urlFor(dir))

    expect(served).toBeNull()
  })
})

describe('the engine and the plugin agree on where the data is', () => {
  it('asks for exactly the folders that are shipped, under the prefix that is served', async () => {
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({ numPages: 1 }),
      destroy: async () => undefined,
    }))
    const pdfjs = { version: '9.8.7', getDocument } as never
    const base = `http://app.test/${pdfjsAssetsPrefix('9.8.7')}`
    const engine = createPdfEngine({ loadPdfjs: async () => pdfjs, assetBaseUrl: () => base })

    await engine.open(new Uint8Array([1]))

    const options = getDocument.mock.calls[0]![0] as unknown as Record<string, string>
    const requested = Object.keys(PDFJS_ASSET_FOLDERS).map((option) => options[option]!)
    expect(requested.sort()).toEqual([...PDFJS_ASSET_DIRS].map((dir) => `${base}${dir}/`).sort())
    // pdf.js ships CMaps compressed; without this it fetches names that do not exist.
    expect(options.cMapPacked).toBe(true)
  })

  it('ships every folder that the engine can ask for', () => {
    const shipped = new Set(listPdfjsAssets(realPackageDir).map((file) => file.split('/')[0]))

    expect([...shipped].sort()).toEqual([...PDFJS_ASSET_DIRS].sort())
  })
})
