import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktopRoot = dirname(fileURLToPath(import.meta.url))

describe('desktop build compatibility', () => {
  it('keeps production bundles loadable in Safari 15 and Android Chrome 81-era WebViews', () => {
    const config = readFileSync(join(desktopRoot, 'vite.config.ts'), 'utf8')

    expect(config).toContain("target: ['es2020', 'chrome81', 'safari15']")
    expect(config).not.toContain("target: ['es2021', 'safari15']")
  })

  it('ships the data pdf.js reads at run time, without which a Chinese PDF is drawn as blanks', async () => {
    // Not a text search: what matters is that the plugin is in the config that is actually used.
    const { default: config } = await import('./vite.config')

    const names = (config.plugins ?? []).flat(Infinity).map((plugin) => (plugin as { name?: string } | null)?.name)

    expect(names).toContain('cc-haha:pdfjs-assets')
  })

  it('does not rely on CSS color-mix for startup-critical shell chrome', () => {
    const css = readFileSync(join(desktopRoot, 'src', 'theme', 'globals.css'), 'utf8')

    expect(css).not.toContain('color-mix(')
    expect(css).toContain('--color-text-secondary-a72')
    expect(css).toContain('--color-outline-a92')
  })

  it('loads xterm base styles before app globals in the desktop entry', () => {
    const main = readFileSync(join(desktopRoot, 'src', 'main.tsx'), 'utf8')

    const xtermImport = main.indexOf("import '@xterm/xterm/css/xterm.css'")
    const globalsImport = main.indexOf("import './theme/globals.css'")

    expect(xtermImport).toBeGreaterThanOrEqual(0)
    expect(globalsImport).toBeGreaterThanOrEqual(0)
    expect(xtermImport).toBeLessThan(globalsImport)
  })
})
