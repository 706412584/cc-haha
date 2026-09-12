import { memo, useState, useEffect, useMemo, useRef } from 'react'
import { Brain } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'

// The whole chat tree re-renders on every streamed delta, so this block has to
// bail out on identical props the way its siblings (AssistantMessage,
// ToolCallBlock, ...) do. The settings it reads are subscribed to internally,
// which is unaffected by the shallow prop comparison.
export const ThinkingBlock = memo(function ThinkingBlock({
  content,
  isActive = false,
}: {
  content: string
  isActive?: boolean
}) {
  const t = useTranslation()
  const thinkingAutoCollapse = useSettingsStore((s) => s.thinkingAutoCollapse)
  const [expanded, setExpanded] = useState(!thinkingAutoCollapse)
  const contentRef = useRef<HTMLDivElement>(null)
  const displayContent = useMemo(() => content.replace(/\r\n?/g, '\n').trimEnd(), [content])
  const hasDisplayContent = displayContent.trim().length > 0
  const preview = useMemo(
    () => thinkingPreview(displayContent, { streaming: isActive }),
    [displayContent, isActive],
  )

  // Auto-collapse when thinking finishes (isActive transitions from true to false)
  useEffect(() => {
    if (!isActive && thinkingAutoCollapse) {
      setExpanded(false)
    }
  }, [isActive, thinkingAutoCollapse])

  // Force expand while actively thinking so user can see the stream
  useEffect(() => {
    if (isActive) {
      setExpanded(true)
    }
  }, [isActive])

  // Pinning the view to the newest reasoning reads `scrollHeight`, which forces
  // a synchronous layout, and `displayContent` changes on every streamed delta.
  // Deferring both the read and the write into a frame collapses a burst of
  // deltas into one scroll per frame; the cleanup drops a frame that a newer
  // delta has already made obsolete.
  //
  // The settle transition needs its own frame: ending the stream re-runs this
  // effect, whose cleanup cancels the pending frame, and a bare `!isActive`
  // guard would leave nothing to replace it — so the last delta would never be
  // scrolled to and the block would sit a line short of the bottom. Scrolling
  // is still confined to the live block plus that one settle, so opening a
  // finished block later does not jump to its end.
  const wasActiveRef = useRef(isActive)
  useEffect(() => {
    const wasActive = wasActiveRef.current
    wasActiveRef.current = isActive
    if (!expanded || !contentRef.current) return
    if (!isActive && !wasActive) return
    const element = contentRef.current
    const frame = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [displayContent, expanded, isActive])

  const label = (
    <>
      {isActive ? t('thinking.label') : t('thinking.labelDone')}
      {isActive && <span className="thinking-dots" />}
    </>
  )

  return (
    <div className="mb-1">
      <style>{thinkingStyles}</style>
      <button
        type="button"
        data-chat-disclosure="true"
        data-thinking-row="true"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-2 rounded-[var(--radius-md)] px-2 py-1 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
      >
        <Brain
          size={13}
          strokeWidth={1.8}
          aria-hidden="true"
          className="mt-[3px] shrink-0 self-start text-[var(--color-text-tertiary)]"
        />
        <span className="shrink-0 text-[12.5px] italic text-[var(--color-text-tertiary)]">
          {label}
        </span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate text-[12.5px] italic leading-[1.7] text-[var(--color-text-tertiary)]">
            {preview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span aria-hidden="true" className="shrink-0 text-[8px] text-[var(--color-text-tertiary)]">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && hasDisplayContent && (
        <div
          ref={contentRef}
          data-thinking-content="expanded"
          className="relative mb-2 mt-1 max-h-[300px] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2.5 text-[11px] text-[var(--color-text-secondary)]"
        >
          {/* While the block streams, `cache={false}` sends every delta through
              a full `marked.parse` + sanitize + innerHTML swap of the entire
              accumulated text — the dominant main-thread cost of a fast model's
              thinking. Plain pre-wrapped text costs nothing and matches the
              settled block on plain prose: same font size, same leading-5, so a
              run of sentences does not move when the stream ends.

              Markdown constructs do give up something for the duration: a
              heading is literal `##`, a fence is literal backticks, and blank
              lines between paragraphs are one empty line here (~20px) rather
              than the compact `prose-p:my-1` gap (~8px). So a thinking block
              that is still open when the stream ends reflows a little. Making
              the streaming branch parse paragraphs too would put per-delta work
              back on the path this changed to remove, for a shift that happens
              once per block — and with `thinkingAutoCollapse` on (the default)
              the block closes at that moment anyway and there is nothing to
              reflow. */}
          {isActive ? (
            <div className="thinking-stream text-xs leading-5 text-[var(--color-text-secondary)]">
              {displayContent}
              <span className="thinking-cursor" />
            </div>
          ) : (
            <MarkdownRenderer
              content={displayContent}
              variant="compact"
              cache
              className="thinking-markdown text-[var(--color-text-secondary)]"
            />
          )}
        </div>
      )}
    </div>
  )
})

const THINKING_PREVIEW_MAX_CHARS = 160
/** A short line ending in a colon is a heading for what comes after it. */
const THINKING_OPENER_MAX_CHARS = 24

function cleanThinkingLines(content: string): string[] {
  const lines: string[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^>\s*/, '')
      .replace(/^\d+\.\s+/, '')
      .trim()
    if (!line || line === '---') continue
    lines.push(line)
  }
  return lines
}

/**
 * One line of reasoning for the collapsed row, stripped of the markdown that
 * would otherwise show as literal `##` / `-` noise. Always a hint — the full
 * block is one click away, so truncating here loses nothing.
 *
 * While the block is still streaming this follows the tail, because the useful
 * question then is "what is it thinking about *now*"; a first line pinned for
 * the thirty seconds a long deliberation takes answers nothing. Once it settles
 * the opening line becomes the summary again — except when that opening is a
 * bare heading like `Diagnosis complete:`, which is the one line in the block
 * that says least, so the substance under it is shown instead.
 */
export function thinkingPreview(content: string, options: { streaming?: boolean } = {}): string {
  const lines = cleanThinkingLines(content)
  if (lines.length === 0) return ''

  const picked = options.streaming
    ? lines[lines.length - 1]!
    : pickSettledPreviewLine(lines)

  return picked.length > THINKING_PREVIEW_MAX_CHARS
    ? `${picked.slice(0, THINKING_PREVIEW_MAX_CHARS)}…`
    : picked
}

function pickSettledPreviewLine(lines: string[]): string {
  const first = lines[0]!
  const isBareHeading = first.length <= THINKING_OPENER_MAX_CHARS && /[:：]$/.test(first)
  return isBareHeading ? lines[1] ?? first : first
}

const thinkingStyles = `
@keyframes thinking-cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
@keyframes thinking-dots {
  0%, 20% { content: ''; }
  40% { content: '.'; }
  60% { content: '..'; }
  80%, 100% { content: '...'; }
}
.thinking-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--color-text-tertiary);
  vertical-align: middle;
  margin-left: 1px;
  animation: thinking-cursor-blink 1s step-end infinite;
}
.thinking-dots::after {
  content: '';
  animation: thinking-dots 1.4s steps(1, end) infinite;
}
/* Plain-text streaming body: keep the source's newlines and wrap long lines.
   Size/leading come from the caller's text-xs / leading-5, matching compact
   Markdown prose. Markdown-specific spacing settles once when streaming ends. */
.thinking-stream {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.thinking-markdown > :first-child,
.thinking-markdown > :first-child > :first-child {
  margin-top: 0;
}
.thinking-markdown > :last-child,
.thinking-markdown > :last-child > :last-child {
  margin-bottom: 0;
}
`
