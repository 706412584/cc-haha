/**
 * Frontmatter splitting for skill markdown shown in the desktop UI.
 *
 * SKILL.md carries its metadata as YAML frontmatter. Feeding that raw text to
 * the markdown renderer turns `key: value` lines into a setext heading (the
 * closing `---` promotes everything above it to an `<h2>`), which is why the
 * detail view used to open with a wall of bold text. We split the block out
 * here so the UI can render it as structured metadata instead.
 *
 * This is a deliberately small YAML subset — scalars, inline/block sequences,
 * and block scalars — because skill frontmatter is flat by convention. Anything
 * more nested is kept as its raw YAML text so no information is lost.
 */

export type FrontmatterScalar = string | number | boolean | null
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[]
/**
 * Widened to `unknown` on purpose: the same panel also renders frontmatter that
 * the server already parsed with a full YAML library, which can hold nested
 * objects. `toFrontmatterEntries` normalizes whatever comes in.
 */
export type SkillFrontmatter = Record<string, unknown>

export type SplitMarkdown = {
  /** Parsed frontmatter, or null when the document has none. */
  frontmatter: SkillFrontmatter | null
  /** The document with its frontmatter block removed. */
  body: string
}

/** A `---` (or `...`) line that closes the block. Must sit at column zero. */
const CLOSING_DELIMITER = /^(?:---|\.\.\.)[\t ]*$/
/** Top-level `key:` or `key: value`. Indented lines belong to the value above. */
const KEY_LINE = /^([A-Za-z0-9_$][\w.$-]*)[\t ]*:(?:[\t ]+(.*))?$/
const BLOCK_SCALAR = /^([|>])([-+]?)(\d*)$/

function stripQuotes(raw: string): { value: string; quoted: boolean } {
  if (raw.length >= 2) {
    const first = raw[0]
    const last = raw[raw.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = raw.slice(1, -1)
      return {
        value: first === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'"),
        quoted: true,
      }
    }
  }
  return { value: raw, quoted: false }
}

/** Drop a trailing ` # comment`, but only when it is outside quotes. */
function stripComment(raw: string): string {
  let quote: string | null = null
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i)
    }
  }
  return raw
}

function coerceScalar(raw: string): FrontmatterScalar {
  const trimmed = raw.trim()
  if (trimmed === '') return ''

  const { value, quoted } = stripQuotes(trimmed)
  // Quoted values stay strings — `version: "1.7.0"` must not become 1.7.
  if (quoted) return value

  const lower = value.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (lower === 'null' || lower === '~') return null
  // Plain integers/decimals only. Leading zeros stay strings so ids survive.
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

/** Split `[a, "b, c", d]` on top-level commas only. */
function splitInlineSequence(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  let depth = 0

  for (const char of inner) {
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') depth++
    if (char === ']' || char === '}') depth--
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)

  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

function indentWidth(line: string): number {
  let width = 0
  for (const char of line) {
    if (char === ' ') width++
    else if (char === '\t') width += 2
    else break
  }
  return width
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

/**
 * Extract the YAML block between the leading `---` and its closing delimiter.
 * Returns null when the document does not open with a frontmatter fence.
 */
function extractBlock(markdown: string): { yaml: string; body: string } | null {
  // A BOM ahead of the fence is common in files authored on Windows.
  const source = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown
  const lines = source.split('\n')
  const first = lines[0]
  if (first === undefined || !/^---[\t ]*\r?$|^---[\t ]*$/.test(first)) return null

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '')
    if (CLOSING_DELIMITER.test(line)) {
      return {
        yaml: lines
          .slice(1, i)
          .map((l) => l.replace(/\r$/, ''))
          .join('\n'),
        body: lines
          .slice(i + 1)
          .join('\n')
          .replace(/^\n+/, ''),
      }
    }
  }
  // Unterminated fence — treat the whole document as body rather than eating it.
  return null
}

function parseYamlSubset(yaml: string): Record<string, FrontmatterValue> {
  const lines = yaml.split('\n')
  const result: Record<string, FrontmatterValue> = {}
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!
    if (isBlank(line) || line.trimStart().startsWith('#') || indentWidth(line) > 0) {
      index++
      continue
    }

    const match = KEY_LINE.exec(line)
    if (!match) {
      index++
      continue
    }

    const key = match[1]!
    const inlineRaw = match[2] ?? ''
    index++

    const blockScalar = BLOCK_SCALAR.exec(inlineRaw.trim())
    if (blockScalar) {
      const collected: string[] = []
      while (index < lines.length) {
        const next = lines[index]!
        if (!isBlank(next) && indentWidth(next) === 0) break
        collected.push(next)
        index++
      }
      while (collected.length > 0 && isBlank(collected[collected.length - 1]!)) collected.pop()
      const margin = collected.reduce(
        (min, l) => (isBlank(l) ? min : Math.min(min, indentWidth(l))),
        Number.MAX_SAFE_INTEGER,
      )
      const dedented = collected.map((l) => (isBlank(l) ? '' : l.slice(margin === Number.MAX_SAFE_INTEGER ? 0 : margin)))
      // `>` folds lines into a paragraph; `|` keeps them.
      result[key] = blockScalar[1] === '>' ? dedented.join(' ').replace(/\s+/g, ' ').trim() : dedented.join('\n')
      continue
    }

    const inline = stripComment(inlineRaw).trim()
    if (inline !== '') {
      if (inline.startsWith('[') && inline.endsWith(']')) {
        result[key] = splitInlineSequence(inline.slice(1, -1)).map(coerceScalar)
      } else {
        result[key] = coerceScalar(inline)
      }
      continue
    }

    // Empty inline value: the payload is either an indented sequence, an
    // indented mapping, or nothing at all.
    const childLines: string[] = []
    while (index < lines.length) {
      const next = lines[index]!
      if (!isBlank(next) && indentWidth(next) === 0) break
      childLines.push(next)
      index++
    }
    while (childLines.length > 0 && isBlank(childLines[childLines.length - 1]!)) childLines.pop()

    const meaningful = childLines.filter((l) => !isBlank(l) && !l.trimStart().startsWith('#'))
    if (meaningful.length === 0) {
      result[key] = null
      continue
    }

    if (meaningful.every((l) => l.trimStart().startsWith('- '))) {
      result[key] = meaningful.map((l) => coerceScalar(stripComment(l.trimStart().slice(2))))
      continue
    }

    // Nested mapping — keep the raw YAML so nothing is silently dropped.
    const margin = meaningful.reduce((min, l) => Math.min(min, indentWidth(l)), Number.MAX_SAFE_INTEGER)
    result[key] = childLines
      .map((l) => (isBlank(l) ? '' : l.slice(margin)))
      .join('\n')
      .trim()
  }

  return result
}

/**
 * Split YAML frontmatter off a markdown document.
 *
 * Never throws: a malformed or unterminated block yields
 * `{ frontmatter: null, body: markdown }` so the caller can still render.
 */
export function splitFrontmatter(markdown: string): SplitMarkdown {
  if (!markdown) return { frontmatter: null, body: markdown ?? '' }

  const block = extractBlock(markdown)
  if (!block) return { frontmatter: null, body: markdown }

  let frontmatter: Record<string, FrontmatterValue>
  try {
    frontmatter = parseYamlSubset(block.yaml)
  } catch {
    return { frontmatter: null, body: markdown }
  }

  if (Object.keys(frontmatter).length === 0) {
    // An empty block carries nothing worth showing; just drop it from the body.
    return { frontmatter: null, body: block.body }
  }

  return { frontmatter, body: block.body }
}

/** Keys already shown in the detail header — repeating them is noise. */
const HEADER_KEYS = new Set(['name', 'displayname', 'display_name', 'description', 'version', 'title'])

export type FrontmatterEntry = {
  key: string
  value: FrontmatterValue
  /** Long text or multi-line values render stacked instead of inline. */
  block: boolean
}

/** Order the well-known operational fields first, then everything else A→Z. */
const KEY_PRIORITY = [
  'when_to_use',
  'when-to-use',
  'argument-hint',
  'allowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'paths',
  'user-invocable',
  'license',
  'author',
  'homepage',
  'repository',
  'tags',
  'keywords',
  'category',
]

const INLINE_VALUE_MAX = 48

function isEmptyValue(value: FrontmatterValue): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Coerce an arbitrary parsed-YAML value into something the panel can render.
 * Nested structures become pretty-printed JSON rather than `[object Object]`.
 */
function normalizeValue(value: unknown): FrontmatterValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
        ? (item as FrontmatterScalar)
        : safeStringify(item),
    )
  }
  return safeStringify(value)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Turn parsed frontmatter into display entries: drop what the header already
 * shows, drop empties, sort by usefulness, and flag values that need their own
 * row instead of sitting next to the label.
 */
export function toFrontmatterEntries(
  frontmatter: SkillFrontmatter | null | undefined,
  options: { skipKeys?: Iterable<string> } = {},
): FrontmatterEntry[] {
  if (!frontmatter) return []

  const skip = new Set(HEADER_KEYS)
  for (const key of options.skipKeys ?? []) skip.add(key.toLowerCase())

  return Object.entries(frontmatter)
    .map(([key, value]) => [key, normalizeValue(value)] as const)
    .filter(([key, value]) => !skip.has(key.toLowerCase()) && !isEmptyValue(value))
    .sort(([a], [b]) => {
      const aIndex = KEY_PRIORITY.indexOf(a.toLowerCase())
      const bIndex = KEY_PRIORITY.indexOf(b.toLowerCase())
      const normalizedA = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex
      const normalizedB = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex
      return normalizedA - normalizedB || a.localeCompare(b)
    })
    .map(([key, value]) => ({
      key,
      value,
      block: typeof value === 'string' && (value.includes('\n') || value.length > INLINE_VALUE_MAX),
    }))
}
