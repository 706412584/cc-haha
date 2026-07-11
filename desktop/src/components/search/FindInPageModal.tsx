import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

// JS-based scoped find-in-page. We walk text nodes in the document body EXCLUDING the
// sidebar (.sidebar-panel) and this find bar ([data-find-bar]), then highlight matches
// with the CSS Custom Highlight API (Range-based, no DOM mutation → React-safe).
// Why not native webContents.findInPage: it scans the whole document incl. the <input>
// value, so the search box matches itself and steals focus/caret. Scoping sidesteps that.

const FIND_DEBOUNCE_MS = 250
const RESULTS_HL = 'cc-find-results'
const ACTIVE_HL = 'cc-find-active'
// Subtrees never searched: sidebar, tab bar, this find bar, non-content tags.
const SKIP_CLOSEST = '.sidebar-panel, [data-testid="tab-bar"], [data-find-bar], script, style, noscript, .material-symbols-outlined'

type Props = {
  open: boolean
  onClose: () => void
}

export function FindInPageModal({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [count, setCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])

  // Focus + reset whenever the bar opens; clear highlights when it closes.
  useEffect(() => {
    if (!open) {
      clearHighlights()
      return
    }
    setQuery('')
    setDebouncedQuery('')
    setCount(0)
    setActiveIndex(0)
    rangesRef.current = []
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Debounce the typed query.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), FIND_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query])

  // Clear highlights on unmount.
  useEffect(() => () => clearHighlights(), [])

  // Run (or clear) the search once the query settles.
  useEffect(() => {
    const q = debouncedQuery.trim()
    if (!q) {
      clearHighlights()
      rangesRef.current = []
      setCount(0)
      setActiveIndex(0)
      return
    }
    const ranges = collectRanges(q)
    rangesRef.current = ranges
    setCount(ranges.length)
    setActiveIndex(0)
    paint(ranges, 0)
  }, [debouncedQuery])

  // Next/previous — immediate, uses live state.
  function step(forward: boolean) {
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    const next = forward ? (activeIndex + 1) % ranges.length : (activeIndex - 1 + ranges.length) % ranges.length
    setActiveIndex(next)
    paint(ranges, next)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(!e.shiftKey) // Enter = next, Shift+Enter = previous
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  return createPortal(
    <div className="fixed right-3 top-3 z-50" data-find-bar>
      <style>{`
        ::highlight(${RESULTS_HL}) { background-color: rgba(250, 204, 21, 0.45); color: inherit; }
        ::highlight(${ACTIVE_HL}) { background-color: rgba(249, 115, 22, 0.9); color: #fff; }
      `}</style>
      <div
        className="glass-panel flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1.5 shadow-lg"
        role="dialog"
        aria-label="Find in page"
      >
        <Search className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find"
          className="w-52 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        />
        <span className="min-w-[48px] shrink-0 px-1 text-center text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          {count > 0 ? `${activeIndex + 1} / ${count}` : (debouncedQuery.trim() ? '0' : '')}
        </span>
        <button
          type="button"
          onClick={() => step(false)}
          disabled={count === 0}
          aria-label="Previous match"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
        >
          <ChevronUp className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => step(true)}
          disabled={count === 0}
          aria-label="Next match"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close find bar"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  )
}

// ---- search core (module scope, no React state) ----

/** Walk visible text nodes outside skipped subtrees; return a Range per case-insensitive match. */
function collectRanges(q: string): Range[] {
  const ranges: Range[] = []
  const needle = q.toLowerCase()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      if (parent.closest(SKIP_CLOSEST)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let textNode = walker.nextNode() as Text | null
  while (textNode) {
    const text = textNode.nodeValue!.toLowerCase()
    let idx = text.indexOf(needle)
    while (idx !== -1) {
      const range = document.createRange()
      range.setStart(textNode, idx)
      range.setEnd(textNode, idx + needle.length)
      ranges.push(range)
      idx = text.indexOf(needle, idx + needle.length)
    }
    textNode = walker.nextNode() as Text | null
  }
  return ranges
}

/** Register CSS highlights for all matches + the active one, and scroll the active into view. */
function paint(ranges: Range[], activeIndex: number) {
  const highlights = (CSS as any).highlights as Map<string, unknown> | undefined
  const HighlightCtor = (globalThis as any).Highlight
  if (highlights && HighlightCtor) {
    const results = new HighlightCtor()
    for (const r of ranges) results.add(r)
    highlights.set(RESULTS_HL, results)
    const active = ranges[activeIndex]
    if (active) {
      const activeHl = new HighlightCtor()
      activeHl.add(active)
      activeHl.priority = 1 // paint over the results highlight
      highlights.set(ACTIVE_HL, activeHl)
    } else {
      highlights.delete(ACTIVE_HL)
    }
  }
  ranges[activeIndex]?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function clearHighlights() {
  const highlights = (CSS as any).highlights as Map<string, unknown> | undefined
  highlights?.delete(RESULTS_HL)
  highlights?.delete(ACTIVE_HL)
}
