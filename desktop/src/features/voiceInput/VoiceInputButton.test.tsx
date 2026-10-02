import { useEffect, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { undo } from 'prosemirror-history'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { ApiError } from '@/api/client'
import type { VoiceCatalog } from '@/api/voice'
import { getComposerViewForTesting, MentionComposer, type MentionComposerHandle } from '@/components/chat/MentionComposer'
import { translate } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { useSettingsStore } from '@/stores/settingsStore'
import { selectVoiceInputReady, useVoiceInputStore } from '@/stores/voiceInputStore'
import { VoiceRecorderError, type StartRecordingOptions } from './recorder'
import { useComposerDictation } from './useComposerDictation'
import { VoiceInputButton } from './VoiceInputButton'

const mocks = vi.hoisted(() => ({
  transcribe: vi.fn(),
  catalog: vi.fn(),
  startRecording: vi.fn(),
  supported: vi.fn(() => true),
}))

vi.mock('@/api/voice', () => ({
  voiceApi: {
    transcribe: mocks.transcribe,
    catalog: mocks.catalog,
    providerStatus: vi.fn(),
    updatePreferences: vi.fn(),
    prepare: vi.fn(),
    cancelPrepare: vi.fn(),
    removeAssets: vi.fn(),
  },
}))

vi.mock('./recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./recorder')>()),
  startRecording: mocks.startRecording,
  isVoiceCaptureSupported: mocks.supported,
}))

const en = (key: TranslationKey) => translate('en', key)

function catalogFixture(overrides: Partial<VoiceCatalog['preferences']> = {}, phase: 'ready' | 'unprepared' = 'ready'): VoiceCatalog {
  return {
    supported: true,
    providers: [{
      info: { id: 'sensevoice-local', name: 'SenseVoice', location: 'local', languages: ['auto', 'zh', 'en'] },
      preparation: { phase },
    }],
    preferences: { enabled: true, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'auto', ...overrides },
    limits: { maxAudioSeconds: 60, maxAudioBytes: 10_000_000 },
  }
}

type FakeRecording = {
  getLevel: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

function fakeRecording(seconds = 2): FakeRecording {
  return {
    getLevel: vi.fn(() => 0.4),
    stop: vi.fn(async () => ({ wav: new Blob(['wav']), seconds })),
    cancel: vi.fn(),
  }
}

let recording: FakeRecording
let startOptions: StartRecordingOptions
let finishTranscription: (text: string) => void
let failTranscription: (error: unknown) => void
let transcribeSignal: AbortSignal | undefined
let handle: MentionComposerHandle | null

type HarnessProps = { initial?: string; blocked?: boolean; contextKey?: string | null }

function Harness({ initial = '', blocked = false, contextKey = 'session-a' }: HarnessProps) {
  const [input, setInput] = useState(initial)
  const [mentions, setMentions] = useState<never[]>([])
  const ref = useRef<MentionComposerHandle>(null)
  const dictation = useComposerDictation({ composerRef: ref, draft: input, blocked, contextKey })
  useEffect(() => {
    handle = ref.current
  })
  return (
    <div>
      <MentionComposer
        ref={ref}
        value={input}
        mentions={mentions}
        onChange={(text) => { setInput(text); setMentions([]) }}
        onCompositionStart={dictation.compositionHandlers.onCompositionStart}
        onCompositionEnd={dictation.compositionHandlers.onCompositionEnd}
      />
      <VoiceInputButton dictation={dictation} blocked={blocked} />
      <output data-testid="draft">{input}</output>
    </div>
  )
}

function editorView() {
  const editor = document.querySelector<HTMLElement>('[data-composer-editor]')
  const view = getComposerViewForTesting(editor)
  if (!editor || !view) throw new Error('composer not mounted')
  return { editor, view }
}

/** A user edit: goes through the editor exactly like typing does. */
function typeText(text: string, offset: number) {
  const { view } = editorView()
  act(() => {
    view.dispatch(view.state.tr.insertText(text, offset + 1))
  })
}

function focusComposerAt(start: number, end = start) {
  const { view } = editorView()
  vi.spyOn(view, 'hasFocus').mockReturnValue(true)
  act(() => handle!.setSelectionOffsets(start, end))
}

const draft = () => screen.getByTestId('draft').textContent

const startButton = () => screen.getByRole('button', { name: en('voice.composer.start') })
const stopButton = () => screen.getByRole('button', { name: en('voice.composer.stop') })

async function beginRecording() {
  await act(async () => {
    fireEvent.click(startButton())
  })
  await screen.findByRole('button', { name: en('voice.composer.stop') })
}

/** Ends the recording and leaves transcription in flight. */
async function stopRecording() {
  await act(async () => {
    fireEvent.click(stopButton())
  })
  await screen.findByRole('button', { name: en('voice.composer.transcribing') })
}

async function deliver(text: string) {
  await act(async () => {
    finishTranscription(text)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  handle = null
  transcribeSignal = undefined
  recording = fakeRecording()
  mocks.supported.mockReturnValue(true)
  mocks.startRecording.mockImplementation(async (options: StartRecordingOptions) => {
    startOptions = options
    return recording
  })
  mocks.transcribe.mockImplementation((_wav: Blob, options: { signal?: AbortSignal }) => {
    transcribeSignal = options.signal
    return new Promise((resolve, reject) => {
      finishTranscription = (text) => resolve({ text, audioSeconds: 2, inferenceSeconds: 0.1 })
      failTranscription = reject
    })
  })
  useSettingsStore.setState({ locale: 'en' })
  useVoiceInputStore.setState({ catalog: catalogFixture(), loading: false, error: null })
  localStorage.clear()
  // jsdom has no layout. ProseMirror reads Range geometry when a transaction
  // scrolls the new selection into view.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  })
})

afterEach(() => {
  Reflect.deleteProperty(Range.prototype, 'getClientRects')
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('visibility', () => {
  it('renders the dictation button when the service is ready', () => {
    render(<Harness />)
    expect(startButton()).toBeInTheDocument()
  })

  it.each([
    ['dictation is disabled', () => useVoiceInputStore.setState({ catalog: catalogFixture({ enabled: false }) })],
    ['the model is not downloaded', () => useVoiceInputStore.setState({ catalog: catalogFixture({}, 'unprepared') })],
    ['the platform does not support it', () => useVoiceInputStore.setState({ catalog: { ...catalogFixture(), supported: false } })],
    ['the environment cannot capture audio', () => mocks.supported.mockReturnValue(false)],
  ])('renders nothing and takes no space when %s', (_name, arrange) => {
    arrange()
    const { container } = render(<Harness />)
    expect(screen.queryByTestId('voice-input')).toBeNull()
    expect(container.querySelector('[data-testid="voice-input"]')).toBeNull()
  })

  it('loads the catalog when it mounts', async () => {
    useVoiceInputStore.setState({ catalog: null })
    mocks.catalog.mockResolvedValue(catalogFixture())

    render(<Harness />)

    expect(mocks.catalog).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: en('voice.composer.start') })).toBeInTheDocument()
  })

  it('keeps the button mounted mid-recording if the service is switched off meanwhile', async () => {
    render(<Harness />)
    await beginRecording()

    act(() => useVoiceInputStore.setState({ catalog: catalogFixture({ enabled: false }) }))

    expect(stopButton()).toBeInTheDocument()
  })

  it('does not steal focus from the composer on mouse down', () => {
    render(<Harness />)
    // fireEvent returns false when the default action was prevented.
    expect(fireEvent.mouseDown(startButton())).toBe(false)
  })
})

describe('recording and transcription', () => {
  it('records with the remembered microphone and the configured limit, then transcribes with the selected provider and language', async () => {
    localStorage.setItem('cc-haha-voice-input-device', 'usb-1')
    useVoiceInputStore.setState({ catalog: catalogFixture({ language: 'en' }) })
    render(<Harness />)

    await beginRecording()
    expect(startOptions).toMatchObject({ deviceId: 'usb-1', maxSeconds: 60 })
    expect(screen.getByTestId('voice-input-timer')).toBeInTheDocument()

    await stopRecording()
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({
      providerId: 'sensevoice-local',
      language: 'en',
    }))

    await deliver('hello')
    expect(draft()).toBe('hello')
    expect(startButton()).toBeInTheDocument()
  })

  it('cannot start a second recording while one is running or being transcribed', async () => {
    render(<Harness />)
    await beginRecording()
    await stopRecording()

    expect(screen.getByRole('button', { name: en('voice.composer.transcribing') })).toBeDisabled()
    expect(mocks.startRecording).toHaveBeenCalledTimes(1)
  })

  it('does not cancel a recording when the window loses focus', async () => {
    render(<Harness />)
    await beginRecording()

    act(() => {
      window.dispatchEvent(new Event('blur'))
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(recording.cancel).not.toHaveBeenCalled()
    expect(stopButton()).toBeInTheDocument()
  })

  it('stops and transcribes on its own when the recorder reaches its limit', async () => {
    render(<Harness />)
    await beginRecording()

    await act(async () => {
      startOptions.onLimitReached?.()
    })

    expect(recording.stop).toHaveBeenCalledTimes(1)
    await screen.findByRole('button', { name: en('voice.composer.transcribing') })
    await deliver('long dictation')
    expect(draft()).toBe('long dictation')
  })

  it('keeps recordings that are too short away from the server', async () => {
    recording = fakeRecording(0.1)
    render(<Harness />)
    await beginRecording()
    await act(async () => {
      fireEvent.click(stopButton())
    })

    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(en('voice.composer.error.tooShort'))
    expect(draft()).toBe('')
  })

  it.each(['', '   ', '\n'])('reports silence instead of writing %j', async (text) => {
    render(<Harness initial="keep" />)
    await beginRecording()
    await stopRecording()
    await deliver(text)

    expect(screen.getByRole('alert')).toHaveTextContent(en('voice.composer.error.noSpeech'))
    expect(draft()).toBe('keep')
    expect(screen.queryByTestId('voice-input-pending')).toBeNull()
  })
})

describe('button semantics', () => {
  it('is a pressed toggle only while recording; starting and transcribing are busy, not pressed', async () => {
    let grant!: (value: FakeRecording) => void
    mocks.startRecording.mockImplementation((options: StartRecordingOptions) => {
      startOptions = options
      return new Promise(resolve => { grant = resolve as typeof grant })
    })
    render(<Harness />)
    expect(startButton()).not.toHaveAttribute('aria-pressed')

    await act(async () => {
      fireEvent.click(startButton())
    })
    const starting = screen.getByRole('button', { name: en('voice.composer.starting') })
    expect(starting).toHaveAttribute('aria-busy', 'true')
    expect(starting).not.toHaveAttribute('aria-pressed')

    await act(async () => {
      grant(recording)
    })
    expect(stopButton()).toHaveAttribute('aria-pressed', 'true')

    await stopRecording()
    const transcribing = screen.getByRole('button', { name: en('voice.composer.transcribing') })
    expect(transcribing).toHaveAttribute('aria-busy', 'true')
    expect(transcribing).not.toHaveAttribute('aria-pressed')
  })
})

describe('cancellation', () => {
  it('Esc discards the recording without transcribing', async () => {
    render(<Harness />)
    await beginRecording()

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(recording.cancel).toHaveBeenCalledTimes(1)
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(startButton()).toBeInTheDocument()
  })

  it('Esc during recognition aborts the request and ignores a late answer', async () => {
    render(<Harness />)
    await beginRecording()
    await stopRecording()

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(transcribeSignal?.aborted).toBe(true)
    await deliver('too late')

    expect(draft()).toBe('')
    expect(screen.queryByTestId('voice-input-pending')).toBeNull()
  })

  it('Esc is left alone when nothing is being recorded', async () => {
    render(<Harness />)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('cancels a live recording when the composer unmounts', async () => {
    const { unmount } = render(<Harness />)
    await beginRecording()
    unmount()
    expect(recording.cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels the microphone that arrives after the composer unmounted', async () => {
    let grant!: (value: FakeRecording) => void
    mocks.startRecording.mockImplementation((options: StartRecordingOptions) => {
      startOptions = options
      return new Promise(resolve => { grant = resolve as typeof grant })
    })
    const { unmount } = render(<Harness />)
    await act(async () => {
      fireEvent.click(startButton())
    })

    unmount()
    expect(startOptions.signal?.aborted).toBe(true)
    await act(async () => {
      grant(recording)
    })

    expect(recording.cancel).toHaveBeenCalledTimes(1)
  })

  it('a second click while the permission prompt is open cancels the attempt', async () => {
    let grant!: (value: FakeRecording) => void
    mocks.startRecording.mockImplementation((options: StartRecordingOptions) => {
      startOptions = options
      return new Promise(resolve => { grant = resolve as typeof grant })
    })
    render(<Harness />)
    await act(async () => {
      fireEvent.click(startButton())
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en('voice.composer.starting') }))
    })
    await act(async () => {
      grant(recording)
    })

    expect(recording.cancel).toHaveBeenCalledTimes(1)
    expect(startButton()).toBeInTheDocument()
  })

  it('abandons the recording and any held text when the session changes', async () => {
    const { rerender } = render(<Harness initial="abc" />)
    await beginRecording()

    rerender(<Harness initial="abc" contextKey="session-b" />)

    expect(recording.cancel).toHaveBeenCalledTimes(1)
    expect(startButton()).toBeInTheDocument()
  })

  it('drops a held result when the session changes', async () => {
    const { rerender } = render(<Harness />)
    await beginRecording()
    await stopRecording()
    typeText('x', 0)
    await deliver('held')
    expect(screen.getByTestId('voice-input-pending')).toBeInTheDocument()

    rerender(<Harness contextKey="session-b" />)

    expect(screen.queryByTestId('voice-input-pending')).toBeNull()
  })

  it('abandons dictation when the composer is hidden (contextKey null)', async () => {
    const { rerender } = render(<Harness />)
    await beginRecording()
    rerender(<Harness contextKey={null} />)
    expect(recording.cancel).toHaveBeenCalledTimes(1)
  })
})

describe('write-back position', () => {
  it('appends to the draft when the composer had no focus', async () => {
    render(<Harness initial="你好" />)
    await beginRecording()
    await stopRecording()
    await deliver('世界')
    expect(draft()).toBe('你好世界')
  })

  it('writes at the caret captured when recording began, not where it is now', async () => {
    render(<Harness initial="hello world" />)
    focusComposerAt(5)
    await beginRecording()
    await stopRecording()
    // The caret moves while the model is thinking; the text still belongs to
    // the spot the user was speaking into.
    act(() => handle!.setSelectionOffsets(11))
    await deliver('big')

    expect(draft()).toBe('hello big world')
  })

  it('replaces a selection that was active when recording began', async () => {
    render(<Harness initial="fix the FOO now" />)
    focusComposerAt(8, 11)
    await beginRecording()
    await stopRecording()
    await deliver('bar')

    expect(draft()).toBe('fix the bar now')
  })

  it('leaves the caret after the inserted text', async () => {
    render(<Harness initial="ab" />)
    focusComposerAt(1)
    await beginRecording()
    await stopRecording()
    await deliver('你')

    expect(handle!.getSelectionOffsets()).toEqual({ start: 2, end: 2 })
  })

  it('is one undoable editor step', async () => {
    render(<Harness initial="keep" />)
    await beginRecording()
    await stopRecording()
    await deliver('added')
    expect(draft()).toBe('keep added')

    const { view } = editorView()
    act(() => {
      undo(view.state, view.dispatch)
    })

    expect(draft()).toBe('keep')
  })

  it('never submits: writing text leaves the draft for the user to send', async () => {
    const onSubmit = vi.fn()
    render(<div onKeyDown={onSubmit}><Harness /></div>)
    await beginRecording()
    await stopRecording()
    await deliver('hello')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(draft()).toBe('hello')
  })
})

describe('draft changed during recognition', () => {
  it('keeps the text aside instead of overwriting the edit', async () => {
    render(<Harness initial="hello" />)
    await beginRecording()
    await stopRecording()
    typeText(' typed', 5)
    await deliver('dictated')

    expect(draft()).toBe('hello typed')
    expect(screen.getByTestId('voice-input-pending-text')).toHaveTextContent('dictated')
  })

  it('treats an edit that was typed and deleted again as a change', async () => {
    render(<Harness initial="hello" />)
    await beginRecording()
    typeText('x', 5)
    const { view } = editorView()
    act(() => {
      view.dispatch(view.state.tr.delete(6, 7))
    })
    expect(draft()).toBe('hello')
    await stopRecording()
    await deliver('dictated')

    expect(draft()).toBe('hello')
    expect(screen.getByTestId('voice-input-pending')).toBeInTheDocument()
  })

  it('offers an insert button that writes at the caret the user has now', async () => {
    render(<Harness initial="hello" />)
    await beginRecording()
    await stopRecording()
    typeText(' typed', 5)
    await deliver('dictated')

    focusComposerAt(0)
    fireEvent.click(screen.getByRole('button', { name: en('voice.composer.insertText') }))

    // "dictated" is followed by "hello" without a space, so latin words are
    // kept apart.
    expect(draft()).toBe('dictated hello typed')
    expect(screen.queryByTestId('voice-input-pending')).toBeNull()
  })

  it('lets the user discard the held text', async () => {
    render(<Harness initial="hello" />)
    await beginRecording()
    await stopRecording()
    typeText('!', 5)
    await deliver('dictated')

    fireEvent.click(screen.getByRole('button', { name: en('voice.composer.discard') }))

    expect(screen.queryByTestId('voice-input-pending')).toBeNull()
    expect(draft()).toBe('hello!')
  })

  it('discards stale held text when a new recording starts', async () => {
    render(<Harness initial="hello" />)
    await beginRecording()
    await stopRecording()
    typeText('!', 5)
    await deliver('first')
    expect(screen.getByTestId('voice-input-pending')).toBeInTheDocument()

    await beginRecording()

    expect(screen.queryByTestId('voice-input-pending')).toBeNull()
  })
})

describe('composer blocked while a message is being sent', () => {
  it('holds the result and only enables insertion once the composer frees up', async () => {
    const { rerender } = render(<Harness initial="hello" />)
    await beginRecording()
    await stopRecording()
    rerender(<Harness initial="hello" blocked />)
    await deliver('dictated')

    expect(draft()).toBe('hello')
    const insert = screen.getByRole('button', { name: en('voice.composer.insertText') })
    expect(insert).toBeDisabled()

    rerender(<Harness initial="hello" />)
    expect(screen.getByRole('button', { name: en('voice.composer.insertText') })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: en('voice.composer.insertText') }))

    expect(draft()).toBe('hello dictated')
  })
})

describe('IME composition', () => {
  it('holds a result that arrives mid-composition and never writes it on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<Harness initial="hello" />)
    await beginRecording()
    await stopRecording()

    const { editor } = editorView()
    fireEvent.compositionStart(editor)
    await deliver('你好')
    expect(draft()).toBe('hello')
    expect(screen.getByTestId('voice-input-pending-text')).toHaveTextContent('你好')

    // Ending the composition does not release it: the user chooses.
    fireEvent.compositionEnd(editor)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(draft()).toBe('hello')
    expect(screen.getByTestId('voice-input-pending')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: en('voice.composer.insertText') }))
    expect(draft()).toBe('hello你好')
  })
})

describe('errors', () => {
  it.each<[string, VoiceRecorderError['code'], TranslationKey]>([
    ['permission', 'permission', 'voice.composer.error.permission'],
    ['no device', 'no-device', 'voice.composer.error.noDevice'],
    ['device busy', 'device-busy', 'voice.composer.error.deviceBusy'],
    ['unavailable', 'unavailable', 'voice.composer.error.unavailable'],
    ['failed', 'failed', 'voice.composer.error.failed'],
  ])('shows a specific message when the microphone fails to open (%s)', async (_label, code, key) => {
    mocks.startRecording.mockRejectedValue(new VoiceRecorderError(code))
    render(<Harness />)
    await act(async () => {
      fireEvent.click(startButton())
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(en(key))
    expect(startButton()).toBeInTheDocument()
  })

  it('shows a message when the microphone drops out mid-recording', async () => {
    render(<Harness />)
    await beginRecording()

    act(() => {
      startOptions.onInterrupted?.(new VoiceRecorderError('interrupted'))
    })

    expect(screen.getByRole('alert')).toHaveTextContent(en('voice.composer.error.interrupted'))
    expect(startButton()).toBeInTheDocument()
  })

  it.each<[string, unknown, TranslationKey]>([
    ['not-ready body', new ApiError(409, { error: 'voice/not-ready', message: 'x' }), 'voice.composer.error.notReady'],
    ['invalid-audio body', new ApiError(400, { error: 'voice/invalid-audio', message: 'x' }), 'voice.composer.error.invalidAudio'],
    ['unknown-provider body', new ApiError(404, { error: 'voice/unknown-provider', message: 'x' }), 'voice.composer.error.unknownProvider'],
    ['failed body', new ApiError(500, { error: 'voice/failed', message: 'x' }), 'voice.composer.error.failed'],
    ['bare 409', new ApiError(409, 'conflict'), 'voice.composer.error.notReady'],
    ['network error', new TypeError('Failed to fetch'), 'voice.composer.error.failed'],
  ])('maps a server response to a message (%s)', async (_label, error, key) => {
    render(<Harness />)
    await beginRecording()
    await stopRecording()
    await act(async () => {
      failTranscription(error)
    })

    expect(screen.getByRole('alert')).toHaveTextContent(en(key))
    expect(startButton()).toBeInTheDocument()
  })

  it('refreshes the catalog when the server says the model is not ready, so a deleted model stops offering the button', async () => {
    mocks.catalog.mockResolvedValue(catalogFixture({}, 'unprepared'))
    render(<Harness />)
    await beginRecording()
    await stopRecording()
    await act(async () => {
      failTranscription(new ApiError(409, { error: 'voice/not-ready', message: 'x' }))
    })

    expect(mocks.catalog).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(selectVoiceInputReady(useVoiceInputStore.getState())).toBe(false))
  })

  it('does not refetch the catalog for other failures', async () => {
    render(<Harness />)
    await beginRecording()
    await stopRecording()
    await act(async () => {
      failTranscription(new ApiError(500, { error: 'voice/failed', message: 'x' }))
    })

    expect(mocks.catalog).not.toHaveBeenCalled()
  })

  it('can be dismissed, and clears itself after a while', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.startRecording.mockRejectedValue(new VoiceRecorderError('no-device'))
    render(<Harness />)
    await act(async () => {
      fireEvent.click(startButton())
    })
    fireEvent.click(screen.getByRole('button', { name: en('voice.composer.dismiss') }))
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => {
      fireEvent.click(startButton())
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
