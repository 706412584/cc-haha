import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { OpenWithMenu } from '@/components/composite/OpenWithMenu'
import { buildOpenWithMenuItemsForHref } from '../../lib/openWithMenuItems'
import { fileRefFromElement } from '../../lib/markdownAutolink'
import type { OpenWithItem } from '../../lib/openWithItems'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'
import { TurnCompletionStamp } from './TurnCompletionStamp'
import type { TurnCompletion } from '../../lib/turnCompletion'
import { InlineImageGallery } from './InlineImageGallery'
import { InlineVideoGallery } from './InlineVideoGallery'
import { AssistantOutputTargetCard } from './AssistantOutputTargetCard'
import { FakeToolUseNotice } from './FakeToolUseNotice'
import { openPreviewLink } from '../../lib/openPreviewLink'
import { extractAssistantOutputTargets } from '../../lib/assistantOutputTargets'
import { extractFakeToolUseBlocks } from '../../lib/fakeToolUseDetection'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useProviderStore } from '../../stores/providerStore'
import { useProviderCompatStore } from '../../stores/providerCompatStore'
import { useTranslation, type TranslationKey } from '../../i18n'

type Props = {
  content: string
  isStreaming?: boolean
  branchAction?: MessageBranchAction
  sessionId?: string
  timestamp?: number
  /** This turn's real changed files (absolute), used to anchor output chips onto
   *  files that were actually written instead of guessing from the prose. */
  turnChangedFiles?: string[]
  /** Set only on the last reply of a finished turn: when it ended and how long it took. */
  turnCompletion?: TurnCompletion
}

const MAX_CARDS = 3

export const AssistantMessage = memo(function AssistantMessage({ content, isStreaming, branchAction, sessionId, timestamp, turnChangedFiles, turnCompletion }: Props) {
  const t = useTranslation()
  const workDir = useWorkspacePanelStore((s) => (sessionId ? s.statusBySession[sessionId]?.workDir : undefined))
  const activeProviderId = useProviderStore((s) => s.activeId)

  // Some providers/gateways relay model output as raw text instead of
  // structured tool_use blocks. The model then emits XML-style fake
  // <tool_use ...> markers that read as garbage in the chat (e.g.
  // `<tool_useid="..."` after HTML whitespace collapsing). Strip those
  // before MarkdownRenderer sees the content, and surface a notice card
  // so the user knows the model attempted a tool call that didn't run.
  const { cleanContent, fakeBlocks } = useMemo(() => {
    const extraction = extractFakeToolUseBlocks(content)
    return { cleanContent: extraction.cleanText, fakeBlocks: extraction.blocks }
  }, [content])

  // Each detected block is a leak attributable to the active provider.
  // Record them on completion so we don't double-count mid-stream while
  // the same opener gets re-extracted on every token. Keyed on the
  // resolved content + isStreaming so identical replays only fire once.
  useEffect(() => {
    if (isStreaming) return
    if (fakeBlocks.length === 0) return
    const recorder = useProviderCompatStore.getState().recordFakeToolUse
    for (const block of fakeBlocks) {
      recorder(activeProviderId, block.name)
    }
    // We intentionally depend on the message's identity (content) rather
    // than the array — a finalized message replays at most once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, isStreaming, activeProviderId])

  const [openWith, setOpenWith] = useState<{ items: OpenWithItem[]; anchor: DOMRect } | null>(null)

  const handleLinkClick = useCallback(
    (href: string, event: ReactMouseEvent<HTMLDivElement>): boolean => {
      if (!sessionId) return false
      const handled = openPreviewLink(href, sessionId)
      if (handled) event.preventDefault()
      return handled
    },
    [sessionId],
  )

  // Right-clicking a reference in the prose opens the same menu the output cards
  // and the file tree use, so "open in VS Code" / "reveal in Finder" / "copy
  // path" are reachable from the place the model actually names the file.
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!sessionId) return
      const target = event.target as HTMLElement | null
      const link = target?.closest<HTMLAnchorElement>('a[data-file-path], a[href]')
      const href = fileRefFromElement(link) ?? link?.getAttribute('href')
      if (!href) return

      event.preventDefault()
      const anchor = link!.getBoundingClientRect()
      void (async () => {
        const items = await buildOpenWithMenuItemsForHref(href, {
          sessionId,
          workDir,
          // Cast t: useTranslation takes TranslationKey, the builder takes string.
          // Every key it looks up is a valid TranslationKey, so this is safe.
          t: (key, vars) => t(key as TranslationKey, vars),
        })
        if (items.length > 0) setOpenWith({ items, anchor })
      })()
    },
    [sessionId, t, workDir],
  )

  const outputTargets = useMemo(
    () =>
      isStreaming || !sessionId
        ? []
        : // Image/video targets render inline (InlineImageGallery/InlineVideoGallery); never also as a card.
          extractAssistantOutputTargets(cleanContent, { workDir, changedFiles: turnChangedFiles }).filter(
            (target) => target.kind !== 'image' && target.kind !== 'video',
          ),
    [cleanContent, isStreaming, sessionId, workDir, turnChangedFiles],
  )

  if (!cleanContent.trim() && fakeBlocks.length === 0) return null

  const documentLayout = shouldUseDocumentLayout(cleanContent)
  const showTurnCompletion = !isStreaming && Boolean(turnCompletion)

  return (
    <div className="mb-5 flex justify-start">
      <div
        data-message-shell="assistant"
        data-layout={documentLayout ? 'document' : 'bubble'}
        className={`group flex min-w-0 flex-col items-start ${
          documentLayout
            ? 'w-full max-w-full'
            : 'max-w-[88%] sm:max-w-[80%] lg:max-w-[720px]'
        }`}
      >
        <div
          onContextMenu={sessionId ? handleContextMenu : undefined}
          className={`rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-[14.5px] text-[var(--color-text-primary)] shadow-[var(--shadow-card)] ${
            documentLayout ? 'w-full' : 'max-w-full'
          }`}
        >
          <FakeToolUseNotice blocks={fakeBlocks} />
          <MarkdownRenderer
            content={cleanContent}
            variant={documentLayout ? 'document' : 'default'}
            streaming={isStreaming}
            onLinkClick={sessionId ? handleLinkClick : undefined}
          />
          {!isStreaming && <InlineImageGallery text={cleanContent} sessionId={sessionId} workDir={workDir} />}
          {!isStreaming && <InlineVideoGallery text={cleanContent} sessionId={sessionId} workDir={workDir} />}
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-shimmer bg-[var(--color-brand)] align-text-bottom" />
          )}
        </div>

        {!isStreaming && sessionId && outputTargets.length > 0 && (
          <div className="mt-1 flex w-full flex-col gap-2">
            {outputTargets.slice(0, MAX_CARDS).map((target) => (
              <AssistantOutputTargetCard key={target.id} target={target} sessionId={sessionId} workDir={workDir} />
            ))}
            {outputTargets.length > MAX_CARDS && (
              <div className="px-1 text-xs text-[var(--color-text-tertiary)]">
                {t('assistantOutputs.moreOutputs', { count: String(outputTargets.length - MAX_CARDS) })}
              </div>
            )}
          </div>
        )}

        {openWith && (
          <OpenWithMenu
            items={openWith.items}
            anchor={openWith.anchor}
            onClose={() => setOpenWith(null)}
          />
        )}

        {showTurnCompletion ? <TurnCompletionStamp completion={turnCompletion!} /> : null}

        <MessageActionBar
          copyText={isStreaming ? undefined : cleanContent}
          copyLabel={t('chat.copyReply')}          branchAction={branchAction}
          align="start"
          // The stamp above already carries this turn's end time; a hover chip
          // repeating it a line below reads as two different times.
          timestamp={showTurnCompletion ? undefined : timestamp}
        />
      </div>
    </div>
  )
})

function shouldUseDocumentLayout(content: string) {
  const normalized = content.trim()
  if (!normalized) return false

  if (/```/.test(normalized)) return true
  if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|.+\|)/m.test(normalized)) return true

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  return paragraphs.length >= 2 || normalized.split('\n').filter((line) => line.trim()).length >= 8
}
