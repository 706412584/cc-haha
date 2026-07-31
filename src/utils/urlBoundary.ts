/**
 * Where a bare URL ends when it sits in Chinese prose.
 *
 * GFM's autolink extension — and therefore marked's built-in `url` tokenizer —
 * only trims ASCII trailing punctuation. In Chinese text a URL followed by a
 * full-width mark or a Han character swallows the rest of the sentence, so
 * `开发服务器已启动：http://localhost:3000。` produced a hyperlink whose target
 * carried the trailing 。 and resolved to nothing.
 *
 * Two structural rules recover the real boundary:
 *
 *  1. After the authority a URL can only continue with `/`, `?` or `#`. A Han
 *     character there means the sentence resumed, so `http://localhost:3000上运行`
 *     has to end at the port. The host class is `[\w-]`, and JS `\w` is always
 *     ASCII, so CJK can never leak into a hostname.
 *  2. Inside the path/query/fragment CJK *letters* are legal — `/文档.html` is a
 *     real path — but CJK *punctuation* ends the URL.
 *
 * Mirrored in `desktop/src/lib/urlBoundary.ts`. The two packages build
 * separately, so the rules live twice on purpose; keep the case tables in sync.
 */

/**
 * Full-width / CJK marks that end a URL instead of belonging to it.
 *
 * Interpolated straight into character classes below, so this string must never
 * contain `\`, `]`, `^` or `-`.
 */
const CJK_TERMINATORS = '，。；、！？：）】》」』（【《「『“”‘’…'

const PATH_STOP_CHARS = `\\s<>"'\`${CJK_TERMINATORS}`

const BARE_URL_SOURCE = `https?:\\/\\/[\\w-]+(?:\\.[\\w-]+)*(?::\\d{1,5})?(?:[\\/?#][^${PATH_STOP_CHARS}]*)?`

const ANCHORED_BARE_URL_RE = new RegExp(`^${BARE_URL_SOURCE}`, 'i')

const SCHEME_SCAN_RE = /https?:\/\//gi

const TRAILING_PUNCTUATION_RE = new RegExp(
  `[\`'")\\]}>,.;!?${CJK_TERMINATORS}]+$`,
)

/**
 * Strip sentence punctuation that trails a URL. Covers both ASCII and
 * full-width marks.
 */
export function trimTrailingPunctuation(value: string): string {
  return value.replace(TRAILING_PUNCTUATION_RE, '')
}

/**
 * Match a bare `http(s)://` URL anchored at the start of `src`, returning it
 * with sentence punctuation trimmed — or null when `src` does not open with one.
 *
 * A trailing `)` is kept when the URL has an unbalanced `(` before it, so
 * `https://en.wikipedia.org/wiki/Foo_(bar)` survives.
 *
 * IPv6 literals (`http://[::1]:8080`) are deliberately not matched: marked's
 * `cleanUrl` percent-encodes the brackets, which turns a working address into a
 * dead one. Leaving them to the built-in tokenizer keeps them plain text.
 */
export function matchBareUrl(src: string): string | null {
  const match = ANCHORED_BARE_URL_RE.exec(src)
  if (!match) return null

  const raw = match[0]
  let url = trimTrailingPunctuation(raw)

  const opened = (url.match(/\(/g) ?? []).length
  const closed = (url.match(/\)/g) ?? []).length
  if (opened > closed && raw.charAt(url.length) === ')') {
    url += ')'
  }

  return url || null
}

export type PlainTextSegment =
  | { type: 'text'; value: string }
  | { type: 'url'; value: string }

/**
 * Split plain text into text and bare-URL segments. Used where the content never
 * reaches the markdown lexer — raw tool output, for instance.
 */
export function splitTextByUrls(text: string): PlainTextSegment[] {
  const segments: PlainTextSegment[] = []
  let cursor = 0

  SCHEME_SCAN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SCHEME_SCAN_RE.exec(text)) !== null) {
    const start = match.index
    if (start < cursor) {
      SCHEME_SCAN_RE.lastIndex = cursor
      continue
    }

    const url = matchBareUrl(text.slice(start))
    if (!url) {
      SCHEME_SCAN_RE.lastIndex = start + match[0].length
      continue
    }

    if (start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, start) })
    }
    segments.push({ type: 'url', value: url })
    cursor = start + url.length
    SCHEME_SCAN_RE.lastIndex = cursor
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) })
  }

  return segments
}

/** True when `value` is nothing but a single bare URL (used for inline code). */
export function isBareUrlOnly(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  return matchBareUrl(trimmed) === trimmed
}
