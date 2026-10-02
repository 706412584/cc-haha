/**
 * Where a Word document is drawn: a frame that can do nothing.
 *
 * A .docx is untrusted input rendered to HTML, and this app's own policy allows inline
 * script (`script-src 'unsafe-inline'`), so the page's policy is not the boundary. The
 * boundary is this frame: sandboxed with no `allow-scripts`, so nothing in it runs
 * whatever the document managed to put there — a `<script>`, an `onerror=`, a
 * `javascript:` link. `allow-same-origin` is what lets the page draw into the frame and
 * listen to it; it is safe here for the same reason, since there is no script inside to
 * take advantage of it.
 *
 * The policy `<meta>` inside the frame comes first in its document and only ever adds
 * to the page's: it closes the two ways a stylesheet or an image in the document could
 * reach out over the network.
 */

/** Exactly this. Never `allow-scripts`, never `allow-top-navigation`, never `allow-popups`. */
export const FRAME_SANDBOX = 'allow-same-origin'

export const INNER_CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"

export type FrameColorScheme = 'light' | 'dark'

/**
 * The document the frame starts with. The color scheme has to match the page's: a frame
 * whose scheme differs from the element embedding it gets an opaque canvas, and the
 * surround around the pages — which belongs to the page's theme — would be painted over.
 */
export function frameSrcdoc(colorScheme: FrameColorScheme | null): string {
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${INNER_CSP}">`,
    '<meta charset="utf-8">',
    colorScheme ? `<meta name="color-scheme" content="${colorScheme}">` : '',
    '<style>html,body{margin:0;padding:0;background:transparent}</style>',
    '</head><body></body></html>',
  ].join('')
}

export function currentColorScheme(): FrameColorScheme | null {
  const scheme = getComputedStyle(document.documentElement).colorScheme
  if (scheme === 'dark') return 'dark'
  if (scheme === 'light') return 'light'
  return null
}

const FRAME_LOAD_TIMEOUT_MS = 10_000

/** Add a frame to `host` and resolve with its document once that has loaded. */
export function createDocxFrame(
  host: HTMLElement,
  colorScheme: FrameColorScheme | null,
): { frame: HTMLIFrameElement; ready: Promise<Document> } {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', FRAME_SANDBOX)
  frame.setAttribute('title', '')
  frame.setAttribute('tabindex', '-1')
  frame.style.cssText = 'border:0;display:block;width:100%;height:0'

  const ready = new Promise<Document>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The document frame did not load')), FRAME_LOAD_TIMEOUT_MS)
    frame.addEventListener('load', () => {
      clearTimeout(timer)
      const doc = frame.contentDocument
      if (doc) resolve(doc)
      else reject(new Error('The document frame is not reachable'))
    }, { once: true })
  })
  frame.srcdoc = frameSrcdoc(colorScheme)
  host.append(frame)
  return { frame, ready }
}

// ---- links ----

export type LinkAction =
  | { kind: 'anchor'; id: string }
  | { kind: 'external'; url: string }
  | { kind: 'inert' }

/**
 * Where a link may lead. Only http(s) and mail links leave the frame, and they leave
 * through the host application, not by navigating the frame; `#bookmarks` scroll inside
 * it; everything else — `javascript:`, `file:`, `data:`, `blob:`, a relative path that
 * would resolve against the app — goes nowhere.
 */
export function classifyHref(href: string): LinkAction {
  if (href.startsWith('#')) {
    try {
      return { kind: 'anchor', id: decodeURIComponent(href.slice(1)) }
    } catch {
      return { kind: 'inert' }
    }
  }
  try {
    const url = new URL(href)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return { kind: 'external', url: url.href }
    }
  } catch {
    // Relative, or not a URL at all.
  }
  return { kind: 'inert' }
}

/**
 * Take the `href` off every link that leads nowhere. The click handler already keeps such
 * a link from doing anything, but a link is also reachable without a plain click — a
 * middle click, a drag, the context menu — and one with no `href` is not a link there.
 */
export function neutraliseLinks(root: ParentNode): void {
  for (const anchor of root.querySelectorAll('a')) {
    const href = anchor.getAttribute('href')
    if (href === null) continue
    if (classifyHref(href).kind === 'inert') anchor.removeAttribute('href')
    anchor.removeAttribute('target')
    anchor.setAttribute('rel', 'noopener noreferrer')
  }
}

function escapeAttributeValue(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

export type FrameHandlers = {
  /** A link that leaves the document: hand it to the application, do not navigate. */
  onExternalLink: (url: string) => void
  /** Ctrl/⌘ + wheel over the document, with the pointer's place in the frame. */
  onWheelZoom: (deltaY: number, at: { x: number; y: number }) => void
  /** A zoom key pressed while the frame has the keyboard. */
  onZoomKey: (key: string) => void
}

/**
 * Listen to a frame from the page. The frame has no script of its own, so anything the
 * reader does in it — a click, a wheel, a key — is reported here or not at all.
 */
export function attachFrameListeners(doc: Document, handlers: FrameHandlers): () => void {
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest?.('a')
    if (!anchor) return
    // The frame must never navigate itself.
    event.preventDefault()
    const action = classifyHref(anchor.getAttribute('href') ?? '')
    if (action.kind === 'anchor') {
      const target = doc.getElementById(action.id) ?? doc.querySelector(`[name="${escapeAttributeValue(action.id)}"]`)
      target?.scrollIntoView?.()
    } else if (action.kind === 'external') {
      handlers.onExternalLink(action.url)
    }
  }
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    // Ctrl+wheel is also a trackpad pinch: zoom the document, not the whole page.
    event.preventDefault()
    handlers.onWheelZoom(event.deltaY, { x: event.clientX, y: event.clientY })
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (['+', '=', '-', '_', '0', '1'].includes(event.key)) {
      event.preventDefault()
      handlers.onZoomKey(event.key)
    }
  }
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('wheel', onWheel, { passive: false })
  doc.addEventListener('keydown', onKeyDown)
  return () => {
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('wheel', onWheel)
    doc.removeEventListener('keydown', onKeyDown)
  }
}

// ---- presentation ----

/**
 * The paper's colour as the page's theme defines it (`--color-document-paper`). The frame is a
 * document of its own and cannot read the page's custom properties, so it is handed the value.
 */
export function documentPaperColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-document-paper').trim() || 'white'
}

/**
 * What the page adds to docx-preview's own stylesheet, after it: the surround belongs to the page's
 * theme (it shows through the transparent frame), the paper does not (white in every theme, or a
 * highlighted passage would change its meaning), and the wrapper is what zoom is applied to.
 */
export function presentationCss(paper: string): string {
  return [
    // Zoom is a property of the stylesheet, its value a variable on the wrapper: one place says
    // what zoom does, and a script-less frame has no other way to be told a number.
    '.docx-wrapper{zoom:var(--docx-zoom,1);background:transparent;padding:16px;padding-bottom:4px}',
    `.docx-wrapper>section.docx{background:${paper};box-shadow:0 1px 4px rgb(0 0 0 / 0.25);margin-bottom:12px}`,
  ].join('')
}

export function applyZoom(doc: Document, zoom: number): void {
  doc.querySelector<HTMLElement>('.docx-wrapper')?.style.setProperty('--docx-zoom', String(zoom))
}

function lengthToPixels(value: string): number {
  const number = Number.parseFloat(value)
  if (!Number.isFinite(number)) return 0
  if (value.endsWith('pt')) return (number * 96) / 72
  if (value.endsWith('in')) return number * 96
  if (value.endsWith('cm')) return (number * 96) / 2.54
  if (value.endsWith('mm')) return (number * 96) / 25.4
  return number
}

/**
 * The width of the widest page at 100%, in CSS pixels. Measured before any zoom is applied;
 * read from the page's declared width where the browser has laid nothing out.
 */
export function naturalPageWidth(doc: Document): number {
  let widest = 0
  for (const section of doc.querySelectorAll<HTMLElement>('.docx-wrapper > section.docx')) {
    const laidOut = section.getBoundingClientRect().width
    widest = Math.max(widest, laidOut > 0 ? laidOut : lengthToPixels(section.style.width))
  }
  return widest
}

/** How tall the frame must be to show everything in it. */
export function contentHeight(doc: Document): number {
  return Math.ceil(doc.body.getBoundingClientRect().height)
}
