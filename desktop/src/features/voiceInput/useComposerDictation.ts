import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ApiError } from '@/api/client'
import { voiceApi } from '@/api/voice'
import { useVoiceInputStore } from '@/stores/voiceInputStore'
import type { MentionComposerHandle } from '@/components/chat/MentionComposer'
import { getPreferredMicrophoneId } from './devicePreference'
import {
  normalizeDictationText,
  placeDictationResult,
  withDictationSpacing,
  type InsertionPoint,
} from './insertion'
import {
  startRecording,
  VoiceRecorderError,
  type ActiveRecording,
  type VoiceRecorderErrorCode,
} from './recorder'

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

/** Doubles as the suffix of the `voice.composer.error.*` translation keys. */
export type DictationIssue =
  | 'permission'
  | 'noDevice'
  | 'deviceBusy'
  | 'unavailable'
  | 'interrupted'
  | 'notReady'
  | 'invalidAudio'
  | 'unknownProvider'
  | 'failed'
  | 'noSpeech'
  | 'tooShort'

type Run = {
  controller: AbortController
  recording: ActiveRecording | null
  revisionAtStart: number
  point: InsertionPoint
  stopping: boolean
}

type ComposerDictationOptions = {
  composerRef: RefObject<MentionComposerHandle | null>
  /** The composer's current projected text; every distinct value is one revision. */
  draft: string
  /** The composer cannot take text right now (disabled, or a message is being sent). */
  blocked: boolean
  /** Identifies what the composer is editing; a change abandons any dictation. */
  contextKey: string | null | undefined
}

/** Recordings shorter than this are a mis-tap, not speech. */
const MIN_SECONDS = 0.4
const ISSUE_TIMEOUT_MS = 8_000

function issueFromRecorder(code: VoiceRecorderErrorCode): DictationIssue {
  switch (code) {
    case 'permission': return 'permission'
    case 'no-device': return 'noDevice'
    case 'device-busy': return 'deviceBusy'
    case 'unavailable': return 'unavailable'
    case 'interrupted': return 'interrupted'
    default: return 'failed'
  }
}

function issueFromError(error: unknown): DictationIssue {
  if (error instanceof VoiceRecorderError) return issueFromRecorder(error.code)
  if (error instanceof ApiError) {
    const code = typeof error.body === 'object' && error.body !== null && 'error' in error.body
      ? (error.body as { error: unknown }).error
      : undefined
    if (code === 'voice/not-ready') return 'notReady'
    if (code === 'voice/invalid-audio') return 'invalidAudio'
    if (code === 'voice/unknown-provider') return 'unknownProvider'
    if (code === 'voice/failed') return 'failed'
    if (error.status === 409) return 'notReady'
    if (error.status === 400) return 'invalidAudio'
    if (error.status === 404) return 'unknownProvider'
  }
  return 'failed'
}

/**
 * Dictation for a ProseMirror composer: record, transcribe, and write the text
 * into the draft without ever overwriting what the user did meanwhile.
 *
 * Shared by both composers (ChatInput and EmptySession) so the write-back rules
 * cannot drift between them.
 */
export function useComposerDictation({ composerRef, draft, blocked, contextKey }: ComposerDictationOptions) {
  const providerId = useVoiceInputStore(state => state.catalog?.preferences.providerId)
  const language = useVoiceInputStore(state => state.catalog?.preferences.language)
  const maxSeconds = useVoiceInputStore(state => state.catalog?.limits.maxAudioSeconds)

  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [issue, setIssue] = useState<DictationIssue | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState(0)

  const activeRef = useRef<Run | null>(null)
  const draftRef = useRef(draft)
  const revisionRef = useRef(0)
  const blockedRef = useRef(blocked)
  const settingsRef = useRef({ providerId, language, maxSeconds })
  const composingRef = useRef(false)
  const pendingRef = useRef<string | null>(null)
  const previousContextRef = useRef(contextKey)

  blockedRef.current = blocked
  settingsRef.current = { providerId, language, maxSeconds }

  useEffect(() => {
    if (draftRef.current !== draft) {
      draftRef.current = draft
      revisionRef.current += 1
    }
  }, [draft])

  const setPending = useCallback((text: string | null) => {
    pendingRef.current = text
    setPendingText(text)
  }, [])

  const capturePoint = useCallback((): InsertionPoint => {
    const composer = composerRef.current
    if (composer?.hasFocus()) {
      const { start, end } = composer.getSelectionOffsets()
      return { start, end }
    }
    const length = draftRef.current.length
    return { start: length, end: length }
  }, [composerRef])

  const writeText = useCallback((text: string, point: InsertionPoint) => {
    const composer = composerRef.current
    if (!composer) return
    const current = draftRef.current
    const start = Math.min(point.start, current.length)
    const end = Math.min(Math.max(point.end, start), current.length)
    composer.insertTextAtOffsets(start, end, withDictationSpacing(current.slice(0, start), text, current.slice(end)))
  }, [composerRef])

  const cancel = useCallback(() => {
    const run = activeRef.current
    activeRef.current = null
    if (run) {
      run.controller.abort()
      run.recording?.cancel()
    }
    setPhase('idle')
  }, [])

  const abandon = useCallback(() => {
    cancel()
    setPending(null)
    setIssue(null)
  }, [cancel, setPending])

  const deliver = useCallback((run: Run, rawText: string) => {
    const text = normalizeDictationText(rawText)
    if (!text) {
      setIssue('noSpeech')
      return
    }
    const placement = placeDictationResult({
      revisionAtStart: run.revisionAtStart,
      revisionNow: revisionRef.current,
      blocked: blockedRef.current,
      composing: composingRef.current,
    })
    if (placement === 'insert') {
      writeText(text, run.point)
      return
    }
    setPending(text)
  }, [setPending, writeText])

  const finish = useCallback(async (run: Run) => {
    if (activeRef.current !== run || !run.recording || run.stopping) return
    run.stopping = true
    setPhase('transcribing')
    const fail = (next: DictationIssue) => {
      activeRef.current = null
      setPhase('idle')
      setIssue(next)
    }
    try {
      const { wav, seconds } = await run.recording.stop()
      if (activeRef.current !== run) return
      if (seconds < MIN_SECONDS) {
        fail('tooShort')
        return
      }
      const { providerId: provider, language: lang } = settingsRef.current
      if (!provider || !lang) {
        fail('notReady')
        return
      }
      const transcript = await voiceApi.transcribe(wav, {
        providerId: provider,
        language: lang,
        signal: run.controller.signal,
      })
      if (activeRef.current !== run) return
      activeRef.current = null
      setPhase('idle')
      deliver(run, transcript.text)
    } catch (error) {
      if (activeRef.current !== run) return
      const next = issueFromError(error)
      // The server disagrees with our cached catalog (the model was deleted
      // behind our back); refresh it so the button stops being offered.
      if (next === 'notReady') void useVoiceInputStore.getState().loadCatalog({ force: true })
      fail(next)
    }
  }, [deliver])

  const start = useCallback(async () => {
    const settings = settingsRef.current
    if (activeRef.current || !settings.providerId || !settings.maxSeconds) return
    const run: Run = {
      controller: new AbortController(),
      recording: null,
      revisionAtStart: revisionRef.current,
      point: capturePoint(),
      stopping: false,
    }
    activeRef.current = run
    // Starting over is a deliberate choice; the previous held text goes.
    setPending(null)
    setIssue(null)
    setPhase('starting')

    let recording: ActiveRecording
    try {
      recording = await startRecording({
        deviceId: getPreferredMicrophoneId(),
        maxSeconds: settings.maxSeconds,
        signal: run.controller.signal,
        onLimitReached: () => { void finish(run) },
        onInterrupted: (error) => {
          if (activeRef.current !== run) return
          activeRef.current = null
          setPhase('idle')
          setIssue(issueFromRecorder(error.code))
        },
      })
    } catch (error) {
      if (activeRef.current !== run) return
      activeRef.current = null
      setPhase('idle')
      setIssue(issueFromError(error))
      return
    }
    // Cancelled while the permission prompt was open, or another run took over.
    if (activeRef.current !== run) {
      recording.cancel()
      return
    }
    run.recording = recording
    setStartedAt(Date.now())
    setPhase('recording')
  }, [capturePoint, finish, setPending])

  const toggle = useCallback(() => {
    const run = activeRef.current
    if (!run) {
      void start()
    } else if (run.recording) {
      void finish(run)
    } else {
      cancel()
    }
  }, [cancel, finish, start])

  const insertPending = useCallback(() => {
    const text = pendingRef.current
    if (text === null || blockedRef.current) return
    writeText(text, capturePoint())
    setPending(null)
    composerRef.current?.focus()
  }, [capturePoint, composerRef, setPending, writeText])

  const dismissPending = useCallback(() => setPending(null), [setPending])

  const dismissIssue = useCallback(() => setIssue(null), [])

  const onCompositionStart = useCallback(() => {
    composingRef.current = true
  }, [])

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false
  }, [])

  // Esc backs out of a recording or an in-flight recognition. Captured ahead of
  // the composer so it does not also close a menu or interrupt a turn.
  useEffect(() => {
    if (phase === 'idle') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [cancel, phase])

  useEffect(() => {
    if (!issue) return
    const timer = setTimeout(() => setIssue(null), ISSUE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [issue])

  // A different session means a different draft: nothing recorded or held for
  // the old one belongs here.
  useEffect(() => {
    if (previousContextRef.current === contextKey) return
    previousContextRef.current = contextKey
    abandon()
  }, [abandon, contextKey])

  useEffect(() => abandon, [abandon])

  const getLevel = useCallback(() => activeRef.current?.recording?.getLevel() ?? 0, [])

  return useMemo(() => ({
    phase,
    issue,
    pendingText,
    startedAt,
    toggle,
    cancel,
    insertPending,
    dismissPending,
    dismissIssue,
    getLevel,
    compositionHandlers: { onCompositionStart, onCompositionEnd },
  }), [
    phase,
    issue,
    pendingText,
    startedAt,
    toggle,
    cancel,
    insertPending,
    dismissPending,
    dismissIssue,
    getLevel,
    onCompositionStart,
    onCompositionEnd,
  ])
}

export type ComposerDictation = ReturnType<typeof useComposerDictation>
