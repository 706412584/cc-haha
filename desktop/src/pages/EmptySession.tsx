import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDismissable } from '@/hooks/useDismissable'
import { BrandSeal } from '@/components/composite/BrandSeal'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ApiError } from '../api/client'
import { agentsApi } from '../api/agents'
import { skillsApi } from '../api/skills'
import { projectsApi } from '../api/projects'
import { wsManager } from '../api/websocket'
import { useTranslation } from '../i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { usePluginStore } from '../stores/pluginStore'
import { useProviderStore } from '../stores/providerStore'
import { useSessionRuntimeStore, DRAFT_RUNTIME_SELECTION_KEY } from '../stores/sessionRuntimeStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { RepositoryLaunchControls } from '@/components/chat/RepositoryLaunchControls'
import { PermissionModeSelector } from '../components/controls/PermissionModeSelector'
import { ModelSelector, type ModelSelectorHandle } from '../components/controls/ModelSelector'
import { AttachmentGallery } from '../components/chat/AttachmentGallery'
import { ImageAnnotationModal } from '../components/chat/ImageAnnotationModal'
import { ComposerDropOverlay } from '../components/chat/ComposerDropOverlay'
import { ContextUsageIndicator } from '../components/chat/ContextUsageIndicator'
import { FileSearchMenu, type FileSearchMenuHandle } from '../components/chat/FileSearchMenu'
import { LocalSlashCommandPanel, type LocalSlashCommandName } from '../components/chat/LocalSlashCommandPanel'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { isDesktopRuntime } from '../lib/desktopRuntime'
import { resolveActiveProviderRuntimeSelection } from '../lib/runtimeSelection'
import {
  composerAttachmentToPayload,
  filesToComposerAttachments,
  getDataTransferFiles,
  type ComposerAttachment,
} from '../lib/composerAttachments'
import { useComposerFileDrop } from '../components/chat/useComposerFileDrop'
import { shouldSubmitOnEnter } from '../components/chat/sendShortcut'
import {
  appendAgentSlashCommands,
  buildAgentSlashCommands,
  getLocalizedFallbackCommands,
  filterSlashCommands,
  findSlashToken,
  insertSlashTrigger,
  mergeSlashCommands,
  replaceSlashCommand,
  resolveSlashUiAction,
} from '../components/chat/composerUtils'
import type { AttachmentRef, DisplayAttachmentRef } from '../types/chat'
import type { PermissionMode } from '../types/settings'
import type { SlashCommandOption } from '../components/chat/composerUtils'
import { WelcomeTaskCards, type WelcomeTaskCard } from '../components/welcome/WelcomeTaskCards'
import { RecentActivityCard } from '../components/welcome/RecentActivityCard'
import { pickReusableEmptySession } from '../lib/sessionReuse'

type Attachment = ComposerAttachment

type Translate = ReturnType<typeof useTranslation>

function getApiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body
  if (!body || typeof body !== 'object' || !('error' in body)) return null
  return typeof body.error === 'string' ? body.error : null
}

function resolveCreateSessionErrorMessage(error: unknown, t: Translate): string {
  const code = getApiErrorCode(error)
  switch (code) {
    case 'WORKDIR_MISSING':
    case 'WORKDIR_NOT_DIRECTORY':
      return t('empty.createError.workdirMissing')
    case 'REPOSITORY_NOT_GIT':
      return t('empty.createError.notGit')
    case 'REPOSITORY_BRANCH_NOT_FOUND':
      return t('empty.createError.branchNotFound')
    case 'REPOSITORY_DIRTY_WORKTREE':
      return t('empty.createError.dirtyWorktree')
    case 'REPOSITORY_BRANCH_CHECKED_OUT':
      return t('empty.createError.branchCheckedOut')
    case 'REPOSITORY_WORKTREE_CREATE_FAILED':
      return t('empty.createError.worktreeCreateFailed', {
        detail: error instanceof Error ? error.message : t('empty.failedToCreate'),
      })
    case 'REPOSITORY_SWITCH_FAILED':
      return t('empty.createError.switchFailed', {
        detail: error instanceof Error ? error.message : t('empty.failedToCreate'),
      })
    case 'REPOSITORY_CONTEXT_ERROR':
      return t('empty.createError.contextFailed')
    default:
      return error instanceof Error ? error.message : t('empty.failedToCreate')
  }
}

export function EmptySession() {
  const t = useTranslation()
  const [input, setInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [workDir, setWorkDir] = useState('')
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  const [repositoryLaunchReady, setRepositoryLaunchReady] = useState(true)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [annotationTarget, setAnnotationTarget] = useState<Attachment | null>(null)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  // Tracks whether a welcome-screen task card requested orchestration mode for
  // the not-yet-created session. Applied right after createSession() resolves
  // and before connectToSession() so the WS replay carries it.
  const [draftOrchestrate, setDraftOrchestrate] = useState(false)
  const [fileSearchOpen, setFileSearchOpen] = useState(false)
  const [localSlashPanel, setLocalSlashPanel] = useState<LocalSlashCommandName | null>(null)
  const [atFilter, setAtFilter] = useState('')
  const [atCursorPos, setAtCursorPos] = useState(-1)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>([])
  const [agentSlashCommands, setAgentSlashCommands] = useState<SlashCommandOption[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelSelectorRef = useRef<ModelSelectorHandle>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const fileSearchRef = useRef<FileSearchMenuHandle>(null)
  const slashItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const createSession = useSessionStore((state) => state.createSession)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const connectToSession = useChatStore((state) => state.connectToSession)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const addToast = useUIStore((state) => state.addToast)
  const currentModel = useSettingsStore((state) => state.currentModel)
  const activeProviderName = useSettingsStore((state) => state.activeProviderName)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const defaultPermissionMode = useSettingsStore((state) => state.permissionMode)
  const providers = useProviderStore((state) => state.providers)
  const activeProviderId = useProviderStore((state) => state.activeId)
  const [draftPermissionMode, setDraftPermissionMode] = useState<PermissionMode>(defaultPermissionMode)
  const lastPluginReloadSummary = usePluginStore((state) => state.lastReloadSummary)
  const draftRuntimeSelection = useSessionRuntimeStore((state) => state.selections[DRAFT_RUNTIME_SELECTION_KEY])
  const draftRuntimeSelectionKey = draftRuntimeSelection
    ? `${draftRuntimeSelection.providerId ?? 'official'}:${draftRuntimeSelection.modelId}:${draftRuntimeSelection.effortLevel ?? 'auto'}`
    : undefined
  const draftModelLabel = draftRuntimeSelection?.modelId ?? currentModel?.name ?? currentModel?.id
  const isMobileComposer = useMobileViewport() && !isDesktopRuntime()

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useDismissable({
    open: plusMenuOpen,
    refs: [plusMenuRef],
    onDismiss: () => setPlusMenuOpen(false),
  })

  useDismissable({
    open: slashMenuOpen,
    refs: [slashMenuRef, textareaRef],
    onDismiss: () => setSlashMenuOpen(false),
  })

  useDismissable({
    open: !!localSlashPanel,
    refs: [slashMenuRef, textareaRef],
    onDismiss: () => setLocalSlashPanel(null),
  })

  useDismissable({
    open: fileSearchOpen,
    refs: [textareaRef],
    onDismiss: () => setFileSearchOpen(false),
    // See ChatInput: this menu is found by id, and its absence used to mean
    // "ignore the press".
    isExempt: (target) => {
      const menu = document.getElementById('file-search-menu')
      if (!menu) return true
      return target instanceof Node && menu.contains(target)
    },
  })

  useEffect(() => {
    let cancelled = false

    const cwd = workDir || undefined

    skillsApi.list(cwd)
      .then(({ skills }) => {
        if (cancelled) return
        setSlashCommands(
          skills
            .filter((skill) => skill.userInvocable)
            .map((skill) => ({
              name: skill.name,
              description: skill.description,
            })),
        )
      })
      .catch(() => {
        if (!cancelled) {
          setSlashCommands([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [workDir, lastPluginReloadSummary])

  useEffect(() => {
    let cancelled = false
    const cwd = workDir || undefined

    agentsApi.list(cwd)
      .then(({ activeAgents }) => {
        if (cancelled) return
        setAgentSlashCommands(buildAgentSlashCommands(activeAgents))
      })
      .catch(() => {
        if (!cancelled) {
          setAgentSlashCommands([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [workDir, lastPluginReloadSummary])

  const allSlashCommands = useMemo(
    () => appendAgentSlashCommands(
      mergeSlashCommands(slashCommands, getLocalizedFallbackCommands(t)),
      agentSlashCommands,
    ),
    [agentSlashCommands, slashCommands, t],
  )

  const handleWorkDirChange = (newWorkDir: string) => {
    setWorkDir(newWorkDir)
    setSelectedBranch(null)
    setUseWorktree(false)
    setRepositoryLaunchReady(!newWorkDir)
  }

  const filteredCommands = useMemo(() => {
    return filterSlashCommands(allSlashCommands, slashFilter)
  }, [allSlashCommands, slashFilter])

  const exactSlashCommand = useMemo(() => {
    const normalized = slashFilter.trim().toLowerCase()
    if (!normalized) return null
    return filteredCommands.find((command) => command.name.toLowerCase() === normalized) ?? null
  }, [filteredCommands, slashFilter])
  const canSubmit = (
    input.trim().length > 0 ||
    attachments.length > 0 ||
    !!workDir
  ) && !isSubmitting && repositoryLaunchReady

  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [slashFilter])

  useEffect(() => {
    const activeItem = slashMenuOpen ? slashItemRefs.current[slashSelectedIndex] : null
    if (activeItem && typeof activeItem.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ block: 'nearest' })
    }
  }, [slashMenuOpen, slashSelectedIndex])

  const handleSubmit = async () => {
    const text = input.trim()
    if (!canSubmit) return

    const slashUiAction = text.startsWith('/') ? resolveSlashUiAction(text.slice(1)) : null
    if (slashUiAction?.type === 'panel') {
      setLocalSlashPanel(slashUiAction.command as LocalSlashCommandName)
      setInput('')
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (slashUiAction?.type === 'settings') {
      useUIStore.getState().setPendingSettingsTab(slashUiAction.tab)
      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
      setInput('')
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (slashUiAction?.type === 'model') {
      modelSelectorRef.current?.open()
      setInput('')
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    setIsSubmitting(true)
    try {
      const runtimeStore = useSessionRuntimeStore.getState()
      const explicitDraftSelection = runtimeStore.selections[DRAFT_RUNTIME_SELECTION_KEY]
      const defaultActiveProviderSelection = explicitDraftSelection
        ? null
        : resolveActiveProviderRuntimeSelection(
          activeProviderId,
          activeProviderName,
          providers,
          currentModel,
          useSettingsStore.getState().effortLevel,
        )
      const runtimeSelection = explicitDraftSelection ?? defaultActiveProviderSelection ?? undefined
      const sessionId = await createSession(
        workDir || undefined,
        {
          ...(selectedBranch
            ? { repository: { branch: selectedBranch, worktree: useWorktree } }
            : {}),
          permissionMode: draftPermissionMode,
        },
      )
      if (runtimeSelection) {
        runtimeStore.setSelection(sessionId, runtimeSelection)
        if (explicitDraftSelection) {
          runtimeStore.clearSelection(DRAFT_RUNTIME_SELECTION_KEY)
        }
      }
      setActiveView('code')
      useTabStore.getState().openTab(sessionId, 'New Session')
      // If a welcome-screen card requested orchestration, persist it for this
      // sessionId before the WS connects. chatStore.connectToSession will
      // replay the persisted flag as a `set_coordinator_mode` message.
      if (draftOrchestrate) {
        useChatStore.getState().setSessionCoordinatorMode(sessionId, true)
      }
      connectToSession(sessionId)
      const attachmentPayload: AttachmentRef[] = attachments.some(
        (attachment) => attachment.sourceFile,
      )
        ? await Promise.all(attachments.map(composerAttachmentToPayload))
        : attachments.map((attachment) => ({
            type: attachment.type,
            name: attachment.name,
            path: attachment.path,
            data: attachment.data,
            mimeType: attachment.mimeType,
          }))
      const displayAttachmentPayload: DisplayAttachmentRef[] = attachments.map((attachment) => ({
        type: attachment.type,
        name: attachment.name,
        path: attachment.path,
        data: attachment.data,
        previewUrl: attachment.previewUrl,
        mimeType: attachment.mimeType,
      }))
      if (text || attachmentPayload.length > 0) {
        sendMessage(sessionId, text, attachmentPayload, { displayAttachments: displayAttachmentPayload })
      }
      setInput('')
      setAttachments([])
      setDraftOrchestrate(false)
    } catch (error) {
      addToast({
        type: 'error',
        message: resolveCreateSessionErrorMessage(error, t),
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleInputChange = (value: string, cursorPos: number) => {
    setInput(value)
    const token = findSlashToken(value, cursorPos)
    if (!token) {
      setSlashMenuOpen(false)
    } else {
      setSlashFilter(token.filter)
      setSlashMenuOpen(true)
    }

    // Detect @ trigger for file search
    const textBeforeCursor = value.slice(0, cursorPos)
    let pos = -1
    for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
      const ch = textBeforeCursor[i]!
      if (ch === '@') {
        if (i === 0 || /\s/.test(textBeforeCursor[i - 1]!)) {
          pos = i
          break
        }
        break
      }
      if (/\s/.test(ch)) {
        break
      }
    }
    if (pos < 0) {
      setFileSearchOpen(false)
      setAtFilter('')
      setAtCursorPos(-1)
    } else {
      setAtFilter(textBeforeCursor.slice(pos + 1))
      setAtCursorPos(pos)
      setSlashMenuOpen(false)
      setFileSearchOpen(true)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // Ignore key events during IME composition (e.g. Chinese input method)
    if (event.nativeEvent.isComposing) return

    // Route file search navigation keys to FileSearchMenu
    if (fileSearchOpen) {
      const key = event.key
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === 'Tab' || key === 'Escape') {
        event.preventDefault()
        if (key === 'Escape') {
          setFileSearchOpen(false)
          setAtFilter('')
          setAtCursorPos(-1)
          return
        }
        fileSearchRef.current?.handleKeyDown(event.nativeEvent)
        return
      }
      return
    }

    if (slashMenuOpen && filteredCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const selected = filteredCommands[slashSelectedIndex]
        if (
          event.key === 'Enter' &&
          exactSlashCommand &&
          selected?.name.toLowerCase() === exactSlashCommand.name.toLowerCase() &&
          slashFilter.trim().toLowerCase() === exactSlashCommand.name.toLowerCase() &&
          shouldSubmitOnEnter(event, chatSendBehavior)
        ) {
          event.preventDefault()
          void handleSubmit()
          return
        }
        event.preventDefault()
        if (selected) selectSlashCommand(selected.name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashMenuOpen(false)
        return
      }
    }

    if (shouldSubmitOnEnter(event, chatSendBehavior)) {
      event.preventDefault()
      handleSubmit()
    }
  }

  const handlePaste = (event: React.ClipboardEvent) => {
    const files = getDataTransferFiles(event.clipboardData)
    if (files.length === 0) return

    event.preventDefault()
    void filesToComposerAttachments(files)
      .then((nextAttachments) => {
        if (nextAttachments.length === 0) return
        setAttachments((prev) => [...prev, ...nextAttachments])
      })
      .catch((error) => {
        console.warn('[attachments] Failed to read pasted files', error)
      })
  }

  const appendFiles = useCallback((files: FileList | File[]) => {
    void filesToComposerAttachments(files)
      .then((nextAttachments) => {
        if (nextAttachments.length === 0) return
        setAttachments((prev) => [...prev, ...nextAttachments])
      })
      .catch((error) => {
        console.warn('[attachments] Failed to read selected files', error)
      })
  }, [])

  const appendAttachments = useCallback((nextAttachments: Attachment[]) => {
    if (nextAttachments.length === 0) return
    setAttachments((prev) => [...prev, ...nextAttachments])
  }, [])

  const { isDragActive, dragHandlers } = useComposerFileDrop({
    panelRef,
    onAttachments: appendAttachments,
    onError: (error) => {
      console.warn('[attachments] Failed to read dropped files', error)
    },
  })

  const openAttachmentPicker = useCallback(() => {
    setPlusMenuOpen(false)
    fileInputRef.current?.click()
  }, [])

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files) return

    appendFiles(files)
    event.target.value = ''
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
    if (annotationTarget?.id === id) setAnnotationTarget(null)
  }

  const saveAnnotatedImage = (dataUrl: string) => {
    if (!annotationTarget?.id) return
    setAttachments((prev) => prev.map((attachment) => {
      if (attachment.id !== annotationTarget.id) return attachment
      return {
        ...attachment,
        name: attachment.name.replace(/(\.[^.]+)?$/, '-annotated.png'),
        path: undefined,
        data: dataUrl,
        previewUrl: dataUrl,
        mimeType: 'image/png',
      }
    }))
    setAnnotationTarget(null)
  }

  const selectSlashCommand = (command: string) => {
    const el = textareaRef.current
    if (!el) return
    const cursorPos = el.selectionStart ?? input.length
    const replacement = replaceSlashCommand(input, cursorPos, command)
    if (!replacement) return
    setInput(replacement.value)
    setSlashMenuOpen(false)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(replacement.cursorPos, replacement.cursorPos)
    })
  }

  const insertSlashCommand = () => {
    const el = textareaRef.current
    const cursorPos = el?.selectionStart ?? input.length
    const replacement = insertSlashTrigger(input, cursorPos)
    setInput(replacement.value)
    setPlusMenuOpen(false)
    setSlashFilter('')
    setSlashMenuOpen(true)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(replacement.cursorPos, replacement.cursorPos)
    })
  }

  const applyTaskCard = (card: WelcomeTaskCard, promptText: string) => {
    setInput(promptText)
    setDraftOrchestrate(card.orchestrate)
    setSlashMenuOpen(false)
    setFileSearchOpen(false)
    setPlusMenuOpen(false)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const len = el.value.length
      el.setSelectionRange(len, len)
    })
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className={`brand-seal-glow flex flex-1 flex-col items-center justify-center ${
        isMobileComposer ? 'px-6 pb-[230px] pt-10' : 'p-8 pb-32'
      }`}>
        <div className={`flex flex-col items-center text-center ${
          isMobileComposer ? 'max-w-[300px] gap-3' : 'max-w-[420px] gap-[13px]'
        }`}>
          <BrandSeal size={isMobileComposer ? 'lg' : 'xl'} />
          <h1
            className={`font-bold tracking-tight text-[var(--color-text-primary)] ${
              isMobileComposer ? 'text-2xl' : 'text-[27px]'
            }`}
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {t('empty.title')}
          </h1>
          <p
            className={`mx-auto -mt-1 text-[var(--color-text-secondary)] ${
              isMobileComposer ? 'max-w-[280px] text-sm leading-6' : 'text-[15px] leading-[1.7]'
            }`}
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {t('empty.subtitle')}
          </p>
        </div>
        {!isMobileComposer && workDir && (
          <RecentActivityCard
            workDir={workDir}
            onContinueSession={(sessionId) => {
              setActiveView('code')
              useTabStore.getState().openTab(sessionId, 'New Session')
              connectToSession(sessionId)
            }}
            onAutoHandoff={async (previousSessionId, previousSessionTitle, fallbackText, setStage, options) => {
              // 1. Resolve summary: tries cache first (fast), falls back to
              //    LLM generation on miss. Returns null on any failure so
              //    we can degrade to the zero-token textarea path without
              //    surprising the user with errors.
              setStage('reading-cache')
              let summary = null
              try {
                const cached = await projectsApi.getSessionSummary(previousSessionId)
                summary = cached.summary
              } catch {
                // GET error → fall through to generation path below.
              }
              if (!summary) {
                setStage('generating-summary')
                try {
                  const fresh = await projectsApi.generateSessionSummary(previousSessionId)
                  summary = fresh.summary
                } catch {
                  summary = null
                }
              }

              if (!summary) {
                // Provider down / generation failed → fall back to the old
                // zero-token textarea-prefill path. User gets the visible
                // hand-off paragraph and decides what to send.
                setInput(fallbackText)
                requestAnimationFrame(() => {
                  const el = textareaRef.current
                  if (!el) return
                  el.focus()
                  const len = el.value.length
                  el.setSelectionRange(len, len)
                })
                return
              }

              setStage('starting-session')

              // 2. Resolve the target sessionId. Prefer reusing an
              //    existing empty session in the same workDir (the
              //    classic stray-tab case where the user clicked
              //    "New session in X" earlier, closed the tab, then
              //    landed back on this welcome screen). Falls back to
              //    creating a fresh session.
              try {
                const reuseSessionId = workDir
                  ? pickReusableEmptySession(
                      useSessionStore.getState().sessions,
                      workDir,
                      previousSessionId,
                    )
                  : null
                const sessionId = reuseSessionId
                  ?? (await createSession(
                    workDir || undefined,
                    selectedBranch
                      ? { repository: { branch: selectedBranch, worktree: useWorktree }, permissionMode: draftPermissionMode }
                      : { permissionMode: draftPermissionMode },
                  ))
                setActiveView('code')
                useTabStore.getState().openTab(sessionId, 'New Session')
                connectToSession(sessionId)

                // Stash hand-off info on this new session so the chat
                // header can render a "↗ continued from..." chip and the
                // user knows the AI started with prior context.
                useSessionRuntimeStore.getState().setHandoffInfo(sessionId, {
                  previousSessionId,
                  previousSessionTitle,
                  approxTokens: Math.ceil(
                    (summary.main.length + summary.recent.length) / 4,
                  ),
                  generatedAt: summary.generatedAt,
                })

                // 3. Stage the hand-off summary on this new session and
                //    auto-send a short "continue" trigger message. The CLI
                //    starts (or restarts) with --append-system-prompt
                //    carrying the summary, so the AI begins with full
                //    context without seeing a prefilled user message.
                //
                //    Race-condition note: wsManager.send tolerates a
                //    not-yet-OPEN socket — it queues the message in
                //    `pendingMessages` and flushes onopen. So this works
                //    even when connectToSession() above hasn't completed
                //    its WS upgrade yet. Don't change to gate on
                //    isConnected() without re-checking that contract.
                wsManager.send(sessionId, {
                  type: 'set_handoff_summary',
                  previousSessionId,
                  ...(options?.deep ? { deep: true } : {}),
                })
                sendMessage(sessionId, t('empty.recentActivity.continueTriggerMessage'))
                setInput('')
              } catch (err) {
                addToast({
                  type: 'error',
                  message: resolveCreateSessionErrorMessage(err, t),
                })
              }
            }}
          />
        )}
        {!isMobileComposer && (
          <WelcomeTaskCards workDir={workDir || undefined} onApplyTask={applyTaskCard} />
        )}
      </div>

      <div
        data-testid="empty-session-composer-shell"
        className={`absolute left-0 right-0 z-[var(--z-nav)] flex justify-center ${
        isMobileComposer
          ? 'bottom-0 px-3 pb-[calc(env(safe-area-inset-bottom)+10px)]'
          : 'bottom-4 px-8'
      }`}
      >
        <div className={`flex w-full flex-col ${isMobileComposer ? 'max-w-none' : 'max-w-3xl'}`}>
          <div
            ref={panelRef}
            data-testid="empty-session-composer-panel"
            className={`glass-panel glass-panel--composer relative flex flex-col gap-3 overflow-visible rounded-[var(--radius-2xl)] ${
              isMobileComposer ? 'p-3' : 'p-0'
            } ${isDragActive ? 'composer-drop-target-active' : ''}`}
            {...dragHandlers}
          >
            {isDragActive && (
              <ComposerDropOverlay
                testId="empty-session-drop-overlay"
                title={t('chat.dropFilesTitle')}
                description={t('chat.dropFilesHint')}
              />
            )}

            <div className={isMobileComposer ? 'contents' : 'flex flex-col gap-3 p-4'}>
              {fileSearchOpen && (
                <FileSearchMenu
                  ref={fileSearchRef}
                  cwd={workDir || ''}
                  filter={atFilter}
                  onNavigate={(relativePath) => {
                    if (atCursorPos < 0) return
                    const replacement = `@${relativePath}`
                    const tokenEnd = atCursorPos + 1 + atFilter.length
                    const newValue = `${input.slice(0, atCursorPos)}${replacement}${input.slice(tokenEnd)}`
                    const newCursorPos = atCursorPos + replacement.length
                    setInput(newValue)
                    setAtFilter(relativePath)
                    requestAnimationFrame(() => {
                      textareaRef.current?.focus()
                      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos)
                    })
                  }}
                  onSelect={(path, name) => {
                    if (atCursorPos >= 0) {
                      const attachmentName = name.split('/').filter(Boolean).pop() ?? name
                      const tokenEnd = atCursorPos + 1 + atFilter.length
                      const beforeToken = input.slice(0, atCursorPos)
                      const afterToken = beforeToken ? input.slice(tokenEnd) : input.slice(tokenEnd).replace(/^\s+/, '')
                      const spacer = beforeToken && afterToken && !/\s$/.test(beforeToken) && !/^\s/.test(afterToken) ? ' ' : ''
                      const newValue = `${beforeToken}${spacer}${afterToken}`
                      const newCursorPos = atCursorPos + spacer.length
                      setAttachments((prev) => [
                        ...prev,
                        {
                          id: `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                          name: attachmentName,
                          type: 'file',
                          path,
                        },
                      ])
                      setInput(newValue)
                      setFileSearchOpen(false)
                      setAtFilter('')
                      setAtCursorPos(-1)
                      void textareaRef.current?.focus()
                      requestAnimationFrame(() => {
                        textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos)
                      })
                    }
                  }}
                />
              )}

              {localSlashPanel && (
                <div ref={slashMenuRef}>
                  <LocalSlashCommandPanel
                    command={localSlashPanel}
                    cwd={workDir || undefined}
                    commands={allSlashCommands}
                    onClose={() => setLocalSlashPanel(null)}
                  />
                </div>
              )}

              {slashMenuOpen && filteredCommands.length > 0 && (
                <div
                  ref={slashMenuRef}
                  className="absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]"
                >
                  <div className="max-h-[260px] overflow-y-auto py-1">
                    {filteredCommands.map((command, index) => (
                      <button
                        key={command.name}
                        ref={(el) => { slashItemRefs.current[index] = el }}
                        onClick={() => selectSlashCommand(command.name)}
                        onMouseEnter={() => setSlashSelectedIndex(index)}
                        className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          index === slashSelectedIndex ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'
                        }`}
                      >
                        <span className="flex min-w-0 max-w-[52%] shrink-0 items-baseline gap-1.5">
                          <span className="shrink-0 text-sm font-semibold text-[var(--color-text-primary)]">/{command.name}</span>
                          {command.argumentHint ? (
                            <span className="min-w-0 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
                              {command.argumentHint}
                            </span>
                          ) : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-tertiary)]">{command.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {attachments.length > 0 && (
                <AttachmentGallery
                  attachments={attachments}
                  variant="composer"
                  onRemove={removeAttachment}
                  onAnnotate={(attachment) => setAnnotationTarget(attachment as Attachment)}
                />
              )}

              <div className="flex items-start gap-3">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(event) => handleInputChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  className={`flex-1 resize-none border-none bg-transparent leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] ${
                    isMobileComposer ? 'max-h-[132px] min-h-[72px] py-1.5 text-base' : 'py-2'
                  }`}
                  style={{ fontFamily: 'var(--font-body)' }}
                  placeholder={t('empty.placeholder')}
                  rows={2}
                />
              </div>

              <div className={`border-t border-[var(--color-border-separator)] pt-3 ${
                isMobileComposer ? 'flex flex-wrap items-center gap-2' : 'flex items-center justify-between'
              }`}>
                <div className="flex min-w-0 shrink items-center gap-2">
                  <div ref={plusMenuRef} className="relative shrink-0">
                    <IconButton
                      icon="add"
                      label={t('chat.composerTools')}
                      showTooltip={false}
                      tone="secondary"
                      size={isMobileComposer ? 'xl' : 'md'}
                      className={isMobileComposer ? 'h-11 w-11' : undefined}
                      aria-expanded={plusMenuOpen}
                      onClick={() => setPlusMenuOpen((prev) => !prev)}
                    />

                    {plusMenuOpen && (
                      <div className={`absolute bottom-full left-0 mb-2 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 shadow-[var(--shadow-dropdown)] ${
                        isMobileComposer ? 'w-[min(240px,calc(100vw-32px))]' : 'w-[240px]'
                      }`}>
                        <button
                          onClick={openAttachmentPicker}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
                        >
                          <span className="material-symbols-outlined text-[18px] text-[var(--color-text-secondary)]">attach_file</span>
                          {t('empty.addFiles')}
                        </button>
                        <button
                          onClick={insertSlashCommand}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
                        >
                          <span className="w-5 text-center text-[18px] font-bold text-[var(--color-text-secondary)]">/</span>
                          {t('empty.slashCommands')}
                        </button>
                      </div>
                    )}
                  </div>

                  <PermissionModeSelector
                    workDir={workDir}
                    compact={isMobileComposer}
                    value={draftPermissionMode}
                    onChange={setDraftPermissionMode}
                  />

                  {!isMobileComposer && (
                    <RepositoryLaunchControls
                      workDir={workDir}
                      onWorkDirChange={handleWorkDirChange}
                      branch={selectedBranch}
                      onBranchChange={setSelectedBranch}
                      useWorktree={useWorktree}
                      onUseWorktreeChange={setUseWorktree}
                      onLaunchReadyChange={setRepositoryLaunchReady}
                      disabled={isSubmitting}
                      placement="toolbar"
                    />
                  )}
                </div>

                <div className={`${isMobileComposer ? 'flex min-w-0 flex-1 items-center justify-end gap-2' : 'flex shrink-0 items-center gap-3'}`}>
                  <ContextUsageIndicator
                    chatState="idle"
                    messageCount={0}
                    runtimeSelectionKey={draftRuntimeSelectionKey}
                    fallbackModelLabel={draftModelLabel}
                    draft
                    compact={isMobileComposer}
                  />
                  <ModelSelector ref={modelSelectorRef} runtimeKey={DRAFT_RUNTIME_SELECTION_KEY} disabled={isSubmitting} compact={isMobileComposer} />
                  <Button
                    variant="primary"
                    size="base"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    aria-label={t('common.run')}
                    title={isMobileComposer ? t('common.run') : undefined}
                    className={`shrink-0 ${isMobileComposer ? 'h-11 w-11' : 'w-[112px]'}`}
                    icon={<span className="material-symbols-outlined text-[14px]">arrow_forward</span>}
                    iconPosition="end"
                  >
                    {!isMobileComposer && t('common.run')}
                  </Button>
                </div>
              </div>
            </div>

          </div>

          {isMobileComposer && (
            <RepositoryLaunchControls
              workDir={workDir}
              onWorkDirChange={handleWorkDirChange}
              branch={selectedBranch}
              onBranchChange={setSelectedBranch}
              useWorktree={useWorktree}
              onUseWorktreeChange={setUseWorktree}
              onLaunchReadyChange={setRepositoryLaunchReady}
              disabled={isSubmitting}
            />
          )}
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
      <ImageAnnotationModal
        open={!!annotationTarget}
        image={annotationTarget ? { src: annotationTarget.previewUrl || annotationTarget.data || '', name: annotationTarget.name } : null}
        onClose={() => setAnnotationTarget(null)}
        onSave={saveAnnotatedImage}
      />
    </div>
  )
}
