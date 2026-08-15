/**
 * The `ultracode` keyword trigger.
 *
 * Typing `ultracode` in a prompt opts that turn into multi-agent orchestration.
 * The matcher has to be conservative: the word appears in file paths, code
 * fences, and quoted prose far more often than it appears as an instruction,
 * and a false positive silently turns a one-line question into a run that
 * spawns dozens of agents.
 */

export const WORKFLOW_KEYWORD = 'ultracode'

export type KeywordRange = {
  word: string
  start: number
  end: number
}

/** Spans a match must not fall inside — quoted text, code, and bracketed args. */
const SPAN_DELIMITERS: Record<string, string> = {
  '`': '`',
  '"': '"',
  '<': '>',
  '{': '}',
  '[': ']',
  '(': ')',
  "'": "'",
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

/**
 * Spans of `text` that should be treated as opaque.
 *
 * `<` only opens a span when it looks like a tag, and `'` only when it is not
 * an apostrophe inside a word — otherwise "don't" would swallow the rest of
 * the sentence and hide a real keyword behind it.
 */
function findOpaqueSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let open: string | null = null
  let openIndex = 0

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (open !== null) {
      if (char !== SPAN_DELIMITERS[open]) continue
      if (open === "'" && isWordChar(text[i + 1])) continue
      spans.push({ start: openIndex, end: i + 1 })
      open = null
      continue
    }
    const opensTag = char === '<' && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!)
    const opensQuote = char === "'" && !isWordChar(text[i - 1])
    const opensOther = char !== '<' && char !== "'" && char in SPAN_DELIMITERS
    if (opensTag || opensQuote || opensOther) {
      open = char
      openIndex = i
    }
  }
  return spans
}

/**
 * Every place `keyword` appears as a standalone word the user meant.
 *
 * Returned as ranges, not a boolean, because the composer highlights the word
 * so the user can see the turn was opted in before they send it.
 */
export function findKeywordRanges(
  text: string,
  keyword: string = WORKFLOW_KEYWORD,
): KeywordRange[] {
  const opaque = findOpaqueSpans(text)
  const matches: KeywordRange[] = []
  for (const match of text.matchAll(new RegExp(`\\b${keyword}\\b`, 'gi'))) {
    if (match.index === undefined) continue
    const start = match.index
    const end = start + match[0].length
    if (opaque.some(span => start >= span.start && start < span.end)) continue
    const before = text[start - 1]
    const after = text[end]
    // Path- and flag-like neighbours: `--ultracode`, `foo/ultracode`,
    // `ultracode-runner`, `ultracode?`.
    if (before === '/' || before === '\\' || before === '-') continue
    if (after === '/' || after === '\\' || after === '-' || after === '?') continue
    // `ultracode.js` — a filename, not an instruction.
    if (after === '.' && isWordChar(text[end + 1])) continue
    matches.push({ word: match[0], start, end })
  }
  return matches
}

export function hasWorkflowKeyword(text: string | null | undefined): boolean {
  if (!text) return false
  return findKeywordRanges(text).length > 0
}
