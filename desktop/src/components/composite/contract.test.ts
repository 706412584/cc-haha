import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * `composite/` holds components that legitimately reach into stores or the API
 * — the thing `ui/` forbids — but that several features share.
 *
 * The entry price is the one rule below: two or more callers. `shared/` had no
 * such rule and ended up with 35% single-caller components, each of which was
 * really a private part of one feature sitting in a directory that advertised
 * itself as common ground. Anything with one caller belongs next to that
 * caller.
 */

const COMPOSITE_DIR = join(process.cwd(), 'src/components/composite')
const SRC_DIR = join(process.cwd(), 'src')

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collect(path, out)
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

const components = readdirSync(COMPOSITE_DIR)
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => basename(file).replace(/\.tsx?$/, ''))

const allSources = collect(SRC_DIR).map((path) => ({ path, code: readFileSync(path, 'utf8') }))

describe('components/composite contract', () => {
  it.each(components)('%s has at least two callers', (name) => {
    const importers = allSources.filter(({ path, code }) => {
      if (path.includes('/components/composite/')) return false
      if (/\.test\.tsx?$/.test(path)) return false
      return new RegExp(`from\\s+['"][^'"]*${name}['"]`).test(code)
    })

    expect(
      importers.length,
      `${name} has ${importers.length} caller(s): ${importers.map((i) => i.path.replace(SRC_DIR, 'src')).join(', ') || 'none'}. ` +
      'A single-caller component belongs in that caller\'s directory.',
    ).toBeGreaterThanOrEqual(2)
  })
})
