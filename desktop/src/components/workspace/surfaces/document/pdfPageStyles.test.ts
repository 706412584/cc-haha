// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `pdfPage.css` is the part of pdf.js' viewer stylesheet that a canvas and a
 * `TextLayer` need, copied so the app does not carry the other six thousand lines.
 * A copy can go stale silently: if a pdf.js upgrade changes how the text layer is
 * positioned, every selection lands a few pixels off and nothing else notices.
 *
 * This compares the copy with the installed stylesheet rule by rule, in both
 * directions. The upstream file uses native CSS nesting, so its rules are
 * flattened to plain selectors first.
 */

type Block = { selector: string; declarations: Map<string, string>; children: Block[] }
type Rule = { selector: string; declarations: Map<string, string> }

/** Split at the top level only: `:is(span, br)` is one selector, not two. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Parse CSS, nested or not, into a tree of blocks. Strings and parentheses (`url(a;b)`) hide their contents. */
function parseBlocks(source: string): Block[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const root: Block = { selector: '', declarations: new Map(), children: [] }
  const stack: Block[] = [root]
  let buffer = ''
  let quote: string | null = null
  let parens = 0

  const declare = () => {
    const text = buffer.trim()
    buffer = ''
    const colon = text.indexOf(':')
    if (!text || colon < 0) return
    stack[stack.length - 1]!.declarations.set(squash(text.slice(0, colon)), squash(text.slice(colon + 1)))
  }

  for (const char of css) {
    if (quote) {
      buffer += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      buffer += char
    } else if (char === '(') {
      parens += 1
      buffer += char
    } else if (char === ')') {
      parens -= 1
      buffer += char
    } else if (parens > 0) {
      buffer += char
    } else if (char === '{') {
      const block: Block = { selector: squash(buffer), declarations: new Map(), children: [] }
      buffer = ''
      stack[stack.length - 1]!.children.push(block)
      stack.push(block)
    } else if (char === ';') {
      declare()
    } else if (char === '}') {
      declare()
      stack.pop()
    } else {
      buffer += char
    }
  }
  return root.children
}

/** Resolve nesting: a child is a descendant of its parent unless it says where the parent goes with `&`. */
function flatten(blocks: Block[], parents: string[] = ['']): Rule[] {
  const rules: Rule[] = []
  for (const block of blocks) {
    if (block.selector.startsWith('@')) continue // media and supports queries: none apply to text placement
    const selectors = splitTopLevel(block.selector, ',').flatMap((part) =>
      parents.map((parent) => {
        if (part.includes('&')) return squash(part.replaceAll('&', parent))
        return squash(parent ? `${parent} ${part}` : part)
      }),
    )
    for (const selector of selectors) {
      if (block.declarations.size > 0) rules.push({ selector, declarations: block.declarations })
    }
    rules.push(...flatten(block.children, selectors))
  }
  return rules
}

/** The rules of `blocks` that hang off `.textLayer`, one entry per selector, with duplicates merged. */
function textLayerRules(blocks: Block[], scope: string): Map<string, Map<string, string>> {
  const merged = new Map<string, Map<string, string>>()
  for (const rule of flatten(blocks)) {
    // The scope is only where our copy is applied; upstream has none.
    const selector = scope && rule.selector.startsWith(`${scope} `) ? rule.selector.slice(scope.length + 1) : rule.selector
    if (!selector.startsWith('.textLayer')) continue
    const existing = merged.get(selector) ?? new Map<string, string>()
    for (const [property, value] of rule.declarations) existing.set(property, value)
    merged.set(selector, existing)
  }
  return merged
}

const upstreamPath = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'web', 'pdf_viewer.css')
const ours = readFileSync(path.join(import.meta.dirname, 'pdfPage.css'), 'utf8')
const upstream = textLayerRules(parseBlocks(readFileSync(upstreamPath, 'utf8')), '')
const copy = textLayerRules(parseBlocks(ours), '.cc-pdf-page')

/**
 * Upstream text-layer rules for features this app does not have. Each entry says
 * why it may be missing from the copy; a rule that is in neither list is new, and
 * someone should look at what it does.
 */
const NOT_NEEDED: Array<[pattern: RegExp, reason: string]> = [
  [/highlighting/, 'the annotation editor\'s free-highlight tool'],
  [/^\.textLayerImages/, 'the images the annotation editor keeps beside the text layer'],
  [/annotationLayer/, 'the annotation layer, which the viewer does not draw'],
  [/\.highlight\b/, 'find-in-page highlighting, which the viewer does not have'],
  [/span\[role="img"\]/, 'images embedded in the text layer by the annotation editor'],
  [/selectionRendering/, 'the viewer\'s own text-rendering mode for annotation editing'],
  [/\.editToolbar/, 'the annotation editor\'s toolbar'],
  [/-moz-/, 'Firefox-only pseudo-elements; the app runs in Chromium and WebKit'],
]

/** Where the copy deliberately differs from upstream. */
const DIFFERENCES: Record<string, Record<string, string>> = {
  // Upstream paints the browser's accent colour through `color-mix()`, which the Safari 15 WebView
  // the app supports cannot parse; the copy uses a translucent token of the app's own accent.
  // Translucent is the point: the words being selected are drawn on the canvas beneath.
  '.textLayer ::selection': { background: 'var(--color-document-selection)' },
}

const ignoredUpstream = (selector: string) => NOT_NEEDED.find(([pattern]) => pattern.test(selector))

describe('the text-layer styles copied from pdf.js', () => {
  it('finds the rules it is meant to compare, in both stylesheets', () => {
    // The parser reading nothing would make every comparison below pass.
    expect(upstream.get('.textLayer')?.get('position')).toBe('absolute')
    expect(upstream.get('.textLayer.selecting .endOfContent')?.get('top')).toBe('0')
    expect(copy.get('.textLayer')?.get('position')).toBe('absolute')
    expect(copy.size).toBeGreaterThanOrEqual(7)
  })

  it('has no rule that upstream does not', () => {
    const invented = [...copy.keys()].filter((selector) => !upstream.has(selector))

    expect(invented).toEqual([])
  })

  it('has every upstream text-layer rule, except those for features this app does not have', () => {
    const missing = [...upstream.keys()].filter((selector) => !copy.has(selector) && !ignoredUpstream(selector))

    // A new rule in a pdf.js upgrade: decide whether the copy needs it, and add it
    // here or to NOT_NEEDED with the reason.
    expect(missing).toEqual([])
  })

  it.each([...copy.keys()])('%s: declares what upstream declares, with the same values', (selector) => {
    const wanted = upstream.get(selector)!
    const declared = copy.get(selector)!

    for (const [property, value] of declared) {
      const difference = DIFFERENCES[selector]?.[property]
      if (difference === undefined) {
        expect(wanted.get(property), `${selector} { ${property} }`).toBe(value)
      } else {
        // A listed difference: the copy has exactly what the list says, and upstream still has the property.
        expect(value, `${selector} { ${property} }`).toBe(difference)
        expect(wanted.has(property), `${selector} { ${property} } exists upstream`).toBe(true)
      }
    }
  })

  it.each([...copy.keys()])('%s: leaves out nothing that upstream declares', (selector) => {
    const declared = copy.get(selector)!
    const missing = [...upstream.get(selector)!.keys()].filter(
      (property) => !declared.has(property) && !property.startsWith('-moz-'),
    )

    expect(missing).toEqual([])
  })

  it('paints a selection translucent, because the words it covers are drawn on the canvas beneath', () => {
    // The text being selected is transparent and sits over the canvas. An opaque
    // highlight hides the very words it marks: it turns a sentence into a coloured bar.
    const globals = readFileSync(path.join(import.meta.dirname, '../../../../theme/globals.css'), 'utf8')
    const declared = /--color-document-selection:\s*([^;]+);/.exec(globals)?.[1]
    // `rgba(var(--cc-ac-rgb), 0.3)`: the alpha is the last argument.
    const alpha = declared && /,\s*([0-9.]+)\s*\)$/.exec(declared.trim())?.[1]

    expect(copy.get('.textLayer ::selection')?.get('background')).toBe('var(--color-document-selection)')
    expect(alpha).toBeDefined()
    expect(Number(alpha)).toBeGreaterThan(0)
    expect(Number(alpha)).toBeLessThan(0.6)
  })

  it('keeps the licence notice that goes with copied code', () => {
    expect(ours).toContain('Apache-2.0')
    expect(ours).toContain('Mozilla Foundation')
  })
})
