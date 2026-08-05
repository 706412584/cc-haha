import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(__dirname, 'index.html'), 'utf-8')

describe('desktop index startup diagnostics', () => {
  it('uses the Code Council document title', () => {
    expect(html).toContain('<title>Code Council</title>')
  })

  it('installs a non-module startup watchdog before the app module loads', () => {
    const watchdogIndex = html.indexOf('__CC_HAHA_SHOW_STARTUP_ERROR__')
    const moduleIndex = html.indexOf('type="module"')

    expect(watchdogIndex).toBeGreaterThan(0)
    expect(moduleIndex).toBeGreaterThan(watchdogIndex)
    expect(html).toContain('__CC_HAHA_BOOTSTRAPPED__')
    expect(html).toContain('Desktop startup failed')
  })

  it('diagnoses module resource failures and boot timeouts outside React', () => {
    expect(html).toContain('Startup resource failed to load:')
    expect(html).toContain('Desktop app did not finish bootstrapping within')
  })

  // A composer attachment dragged in from outside the workspace is previewed from
  // `URL.createObjectURL(file)`, and the annotation editor has to `fetch()` that same
  // blob URL to get pixels onto its canvas. `img-src blob:` alone let the thumbnail
  // render while CSP silently blocked the fetch, so the editor opened black.
  // Both directives must stay in sync.
  it('allows blob: in every directive that reads an attachment preview', () => {
    const csp = html.match(/Content-Security-Policy"\s*\n?\s*content="([^"]+)"/)?.[1]
    expect(csp).toBeDefined()

    for (const directive of ['img-src', 'connect-src']) {
      const value = csp!
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${directive} `))
      expect(value, `${directive} missing from CSP`).toBeDefined()
      expect(value, `${directive} must allow blob:`).toContain('blob:')
    }
  })
})
