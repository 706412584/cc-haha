import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'
import { PDFJS_ASSET_DIRS, pdfjsAssetsPrefix } from '../src/components/workspace/surfaces/document/pdfAssets'

/**
 * Not shipped: pdf.js' scripting sandbox (JavaScript embedded in PDF forms). A
 * read-only preview never runs it, and it is a sizeable wasm the app would carry
 * for nothing.
 */
const EXCLUDED = /^wasm\/quickjs-eval\./

const MIME_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
}

/** Every file to ship, as `dir/name` paths relative to the pdfjs-dist package. */
export function listPdfjsAssets(packageDir: string): string[] {
  return PDFJS_ASSET_DIRS.flatMap((dir) => {
    let names: string[]
    try {
      names = fs.readdirSync(path.join(packageDir, dir))
    } catch (error) {
      throw new Error(
        `pdfjs-dist has no "${dir}" folder at ${packageDir}. This version lays its data out differently; `
        + 'update PDFJS_ASSET_FOLDERS in pdfAssets.ts to match.',
        { cause: error },
      )
    }
    return names.map((name) => `${dir}/${name}`).filter((relative) => !EXCLUDED.test(relative))
  })
}

/**
 * Ships pdf.js' run-time data with the app, and serves it from the dev server at
 * the same URL, so the renderer finds it identically in `vite dev`, in the
 * packaged Electron app (`file://` inside the asar) and on the H5 static host.
 *
 * `packageDir` is for tests; by default the installed pdfjs-dist is used.
 */
export function pdfjsAssets(options: { packageDir?: string } = {}): Plugin {
  const packageDir = options.packageDir
    ?? path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version: string }
  const prefix = pdfjsAssetsPrefix(version)

  return {
    name: 'cc-haha:pdfjs-assets',

    configureServer(server) {
      server.middlewares.use(`/${prefix}`, (request, response, next) => {
        let relative: string
        try {
          relative = decodeURIComponent((request.url ?? '/').split('?')[0]!).replace(/^\/+/, '')
        } catch {
          next() // a malformed escape is not one of our files
          return
        }
        const file = path.resolve(packageDir, relative)
        // Only the data folders: nothing else in the package, and no way out of it.
        const inDataDir = PDFJS_ASSET_DIRS.some((dir) => file.startsWith(path.join(packageDir, dir) + path.sep))
        if (!inDataDir || EXCLUDED.test(path.relative(packageDir, file).split(path.sep).join('/')) || !fs.existsSync(file)) {
          next()
          return
        }
        response.setHeader('Content-Type', MIME_TYPES[path.extname(file)] ?? 'application/octet-stream')
        response.setHeader('Cache-Control', 'no-cache')
        fs.createReadStream(file).pipe(response)
      })
    },

    generateBundle() {
      for (const relative of listPdfjsAssets(packageDir)) {
        this.emitFile({
          type: 'asset',
          // A fixed name, not a content hash: the folder already carries the version.
          fileName: prefix + relative,
          source: fs.readFileSync(path.join(packageDir, relative)),
        })
      }
    },
  }
}
