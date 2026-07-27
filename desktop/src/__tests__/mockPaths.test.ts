import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A `vi.mock` whose path does not resolve is not an error — Vitest registers
 * the factory against a specifier nothing imports, the real module loads, and
 * the test keeps passing with its isolation quietly gone.
 *
 * That is exactly what happened when components moved out of `shared/`:
 * `RepositoryLaunchControls.test.tsx` kept mocking `./DirectoryPicker` while
 * the component had moved to `@/components/composite/DirectoryPicker`, so the
 * real picker (and its API calls) rendered in a test that believed it was
 * stubbed.
 */

const SRC = join(process.cwd(), 'src')

function collectTests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collectTests(path, out)
    else if (/\.test\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

/** Mirrors the resolution in vite.config.ts: `@/` maps to `src/`. */
function resolvesToFile(specifier: string, fromFile: string): boolean {
  let base: string
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier)
  else return true // bare package specifier — node_modules, not our concern

  return ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '']
    .some((suffix) => existsSync(base + suffix))
}

describe('vi.mock specifiers', () => {
  it('all resolve to a real module', () => {
    const broken: string[] = []

    for (const file of collectTests(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        const match = line.match(/vi\.mock\(\s*['"]([^'"]+)['"]/)
        if (!match) return
        if (!resolvesToFile(match[1]!, file)) {
          broken.push(`${file.replace(SRC, 'src')}:${index + 1}  vi.mock('${match[1]}')`)
        }
      })
    }

    expect(broken).toEqual([])
  })
})
