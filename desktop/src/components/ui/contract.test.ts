import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Enforces what makes `components/ui/` different from every other component
 * directory. `shared/` and `controls/` were created in the same commit with the
 * distinction living only in their authors' heads; within a year both held a
 * mix of pure primitives and store-coupled feature widgets, and nobody could
 * tell from the outside which was which.
 *
 * These rules are the difference, written down where CI can check them.
 */

const UI_DIR = join(process.cwd(), 'src/components/ui')

/**
 * Doc comments in these files quote the very patterns being banned (that is
 * what makes them useful), so the rules below run against code only.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const sources = readdirSync(UI_DIR)
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => ({ file, code: stripComments(readFileSync(join(UI_DIR, file), 'utf8')) }))

describe('components/ui contract', () => {
  it('contains at least one component', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it.each(sources)('$file imports no store', ({ code }) => {
    // A primitive that reads a store cannot be reused anywhere the store is not
    // mounted, and cannot be rendered twice with different data.
    expect(code).not.toMatch(/from\s+['"][^'"]*stores\//)
  })

  it.each(sources)('$file imports no api client', ({ code }) => {
    expect(code).not.toMatch(/from\s+['"][^'"]*\bapi\//)
  })

  it.each(sources)('$file imports no feature directory', ({ code }) => {
    // Pulling from a sibling feature directory is the layering inversion that
    // put `CopyButton` — a base primitive — behind `../chat/clipboard`.
    expect(code).not.toMatch(/from\s+['"][^'"]*components\/(?!ui\/)[a-z]/)
    expect(code).not.toMatch(/from\s+['"]\.\.\/(?!\.)/)
  })

  it.each(sources)('$file hardcodes no hex color', ({ code }) => {
    // Every color must come from a theme token, or the component renders the
    // same under all three themes — the bug that locked the embedded terminal
    // to a single dark palette.
    const hexes = code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hexes).toEqual([])
  })

  it.each(sources)('$file uses the radius scale rather than Tailwind radii', ({ code }) => {
    // `rounded-lg` (8px) and `rounded-[var(--radius-lg)]` (12px) are different
    // values under the same name. Mixing them is why 21 corner radii shipped.
    expect(code).not.toMatch(/\brounded-(?:sm|md|lg|xl|2xl|3xl)\b/)
  })
})
