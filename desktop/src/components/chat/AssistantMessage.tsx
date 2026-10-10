import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { OpenWithMenu } from '@/components/composite/OpenWithMenu'
import { buildOpenWithMenuItemsForHref } from '../../lib/openWithMenuItems'
import { fileRefFromElement } from '../../lib/markdownAutolink'
import { createAssistantMarkdownImageResolver, localPathFromMarkdownImageUrl } from '../../lib/markdownImages'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { isManagedGeneratedImagePath } from '../../lib/attachmentImages'
import type { OpenWithItem } from '../../lib/openWithItems'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'
import { useMessageActionMenu } from './useMessageActionMenu'
import { TurnCompletionStamp } from './TurnCompletionStamp'
import type { TurnCompletion } from '../../lib/turnCompletion'
import { ImageGalleryModal } from './ImageGalleryModal'
import { InlineImageGallery } from './InlineImageGallery'
import { InlineVideoGallery } from './InlineVideoGallery'
import { AssistantOutputTargetCard } from './AssistantOutputTargetCard'
import { FakeToolUseNotice } from './FakeToolUseNotice'
import { openPreviewLink } from '../../lib/openPreviewLink'
import { extractAssistantOutputTargets, type TurnOutputEvidence } from '../../lib/assistantOutputTargets'
import { extractFakeToolUseBlocks } from '../../lib/fakeToolUseDetection'
import { resolveAssistantFileHref } from '@/lib/assistantFileContext'
import type { MarkdownImageClick } from '../markdown/MarkdownRenderer'
import { useWorkspaceContentStore } from '../../stores/workspaceContentStore'
import { useProviderStore } from '../../stores/providerStore'
import { useProviderCompatStore } from '../../stores/providerCompatStore'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useDiskConfirmedTargets } from '../../hooks/useDiskConfirmedTargets'
import { useTurnWrittenTargets } from '../../hooks/useTurnWrittenTargets'
import { createWorkspaceFileLinkVerifier } from '../../lib/workspaceFileStats'

type Props = {
  content: string
  isStreaming?: boolean
  branchAction?: MessageBranchAction
  sessionId?: string
  /** This turn's real changed files (absolute), used to anchor output chips onto
   *  files that were actually written instead of guessing from the prose. */
  turnChangedFiles?: string[]
  /**
   * What the turn's checkpoint says it could have written. Absent while it is
   * still loading, so no card is shown on a guess that the checkpoint then drops.
   */
  turnOutputEvidence?: TurnOutputEvidence
  /** Only one assistant message per turn owns fallback cards for unmentioned changed files. */
  isTurnOutputOwner?: boolean
  /** Set only on the last reply of a finished turn: when it ended and how long it took. */
  turnCompletion?: TurnCompletion
}

const MAX_CARDS = 3

export const AssistantMessage = memo(function AssistantMessage({
  content,
  isStreaming,
  branchAction,
  sessionId,
  turnChangedFiles,
  turnOutputEvidence,
  isTurnOutputOwner = true,
  turnCompletion,
}: Props) {
  const t = useTranslation()
  const workDir = useWorkspaceContentStore((s) => (sessionId ? s.statusBySession[sessionId]?.workDir : undefined))
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
  const [viewer, setViewer] = useState<{ images: Array<{ src: string; name: string; path?: string }>; index: number } | null>(null)

  const handleLinkClick = useCallback(
    (href: string, event: ReactMouseEvent<HTMLDivElement>): boolean => {
      if (!sessionId) return false
      const handled = openPreviewLink(resolveAssistantFileHref(href, content), sessionId)
      if (handled) event.preventDefault()
      return handled
    },
    [content, sessionId],
  )

  // A reference guessed from a code span or prose links only once its file is
  // known to exist, judged as the click would resolve it — so a name quoted from
  // a commit message never looks openable.
  const fileLinkVerifier = useMemo(
    () => isStreaming || !sessionId
      ? undefined
      : createWorkspaceFileLinkVerifier(sessionId, (path) => resolveAssistantFileHref(path, content)),
    [content, isStreaming, sessionId],
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
        const items = await buildOpenWithMenuItemsForHref(resolveAssistantFileHref(href, content), {
          sessionId,
          workDir,
          // Cast t: useTranslation takes TranslationKey, the builder takes string.
          // Every key it looks up is a valid TranslationKey, so this is safe.
          t: (key, vars) => t(key as TranslationKey, vars),
        })
        if (items.length > 0) setOpenWith({ items, anchor })
      })()
    },
    [content, sessionId, t, workDir],
  )

  const extractedTargets = useMemo(
    () =>
      isStreaming || !sessionId
        ? []
        : // Image/video targets render inline (InlineImageGallery/InlineVideoGallery); never also as a card.
          extractAssistantOutputTargets(cleanContent, {
            workDir,
            changedFiles: turnChangedFiles,
            includeChangedFileFallback: isTurnOutputOwner,
            // Confirmed against the disk by useDiskConfirmedTargets before showing.
            includeUnconfirmedNames: true,
            // A card says the turn produced the file; until the checkpoint says
            // what could have written one, nothing unproven is.
            outputEvidence: { unlistedWrites: turnOutputEvidence?.unlistedWrites ?? false },
          }).filter(
            (target) => target.kind !== 'image' && target.kind !== 'video',
          ),
    [cleanContent, isStreaming, isTurnOutputOwner, sessionId, workDir, turnChangedFiles, turnOutputEvidence?.unlistedWrites],
  )
  // A bare name the text could not bound is settled against the workspace listing,
  // then a file no changed file accounts for must show it was written this turn.
  const settledTargets = useDiskConfirmedTargets(sessionId, extractedTargets)
  const outputTargets = useTurnWrittenTargets(sessionId, settledTargets, turnOutputEvidence?.startedAt)
  const resolveAssistantImageSrc = useMemo(
    () => {
      if (isStreaming || !sessionId) return undefined
      const resolveLocalImage = createAssistantMarkdownImageResolver({
        baseUrl: getServerBaseUrl(),
        sessionId,
        workDir,
      })
      return (src: string) => isManagedGeneratedImagePath(src)
        ? null
        : resolveLocalImage(src)
    },
    [isStreaming, sessionId, workDir],
  )

  // A click on a picture in the prose opens it, and its neighbours in the reply, in
  // the viewer. Each one that is a file on disk carries its path, which is read back
  // from the URL it was served under rather than from anything on the element.
  const handleImageClick = useCallback(
    ({ images, index }: MarkdownImageClick) => {
      const baseUrl = getServerBaseUrl()
      setViewer({
        index,
        images: images.map((image) => {
          const path = localPathFromMarkdownImageUrl(image.src, { baseUrl, workDir }) ?? undefined
          const name = image.alt.trim() || path?.split(/[\\/]/).filter(Boolean).pop() || t('assistantOutputs.kind.image')
          return { src: image.src, name, ...(path ? { path } : {}) }
        }),
      })
    },
    [t, workDir],
  )

  const showTurnCompletion = !isStreaming && Boolean(turnCompletion)
  // On a phone any finished reply can be held for copy and select; branching
  // stays with the reply that closes a turn, as on the desktop bar.
  const actionMenu = useMessageActionMenu({
    copyText: isStreaming ? undefined : cleanContent,
    branchAction: showTurnCompletion ? branchAction : undefined,
  })

  if (!cleanContent.trim() && fakeBlocks.length === 0) return null

  const documentLayout = shouldUseDocumentLayout(cleanContent)

  return (
    <div className="flex justify-start">
      <div
        data-message-shell="assistant"
        data-layout={documentLayout ? 'document' : 'bubble'}
        {...actionMenu.pressProps}
        // Always the full column. A reply that hugs its text turns every short
        // answer into a differently-shaped block, so a scrolled transcript reads
        // as a ragged pile; one width makes the replies a single column the eye
        // can run down. The user bubble stays hugged — that asymmetry is what
        // says which side is speaking, so it does not need width to say it too.
        className={`group flex w-full min-w-0 max-w-full flex-col items-start ${actionMenu.pressClassName}`}
      >
        <div
          onContextMenu={sessionId && !actionMenu.enabled ? handleContextMenu : undefined}
          // No card. Left-aligned, full-column prose against the page is already
          // unmistakably the reply — the hugged, tinted bubble on the right is
          // what says who is speaking (see the note above), so a border here
          // repeats that at the cost of ~50px per reply and makes prose look
          // like the tool rows it sits between. The turn rail groups it now.
          className="w-full text-[var(--color-text-primary)]"
        >
          <FakeToolUseNotice blocks={fakeBlocks} />
          <MarkdownRenderer
            key={`${sessionId ?? ''}|${workDir ?? ''}`}
            className="chat-reading-markdown"
            content={cleanContent}
            variant={documentLayout ? 'document' : 'default'}
            streaming={isStreaming}
            onLinkClick={sessionId ? handleLinkClick : undefined}
            resolveImageSrc={resolveAssistantImageSrc}
            onImageClick={resolveAssistantImageSrc ? handleImageClick : undefined}
            fileLinkVerifier={fileLinkVerifier}
          />
          {!isStreaming && (
            <InlineImageGallery
              text={cleanContent}
              sessionId={sessionId}
              workDir={workDir}
              changedFiles={turnChangedFiles}
              suppressManagedGeneratedImages
            />
          )}
          {!isStreaming && (
            <InlineVideoGallery
              text={cleanContent}
              sessionId={sessionId}
              workDir={workDir}
              changedFiles={turnChangedFiles}
            />
          )}
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

        {viewer && (
          <ImageGalleryModal
            open
            images={viewer.images}
            activeIndex={viewer.index}
            onClose={() => setViewer(null)}
            onSelect={(index) => setViewer((current) => (current ? { ...current, index } : current))}
          />
        )}

        {/* Only the reply that closes a turn or has a branch action gets an action bar.
            Mid-turn replies carry none — reserving 36px for a bar nobody uses on a step
            outweighs the text itself. */}
        {showTurnCompletion && (
          <MessageActionBar
            copyText={actionMenu.enabled ? undefined : cleanContent}
            copyLabel={t('chat.copyReply')}
            branchAction={actionMenu.enabled ? undefined : branchAction}
            align="start"
            alwaysVisible
            metadata={<TurnCompletionStamp completion={turnCompletion!} />}
          />
        )}
        {actionMenu.sheet}
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
