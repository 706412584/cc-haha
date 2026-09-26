import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useOrchestrationPromptStore } from './orchestrationPromptStore'

const { orchestrationPromptsApiMock } = vi.hoisted(() => ({
  orchestrationPromptsApiMock: {
    get: vi.fn(),
    save: vi.fn(),
    reset: vi.fn(),
  },
}))

vi.mock('../api/orchestrationPrompts', () => ({
  orchestrationPromptsApi: orchestrationPromptsApiMock,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function response(effective: string, maxChars = 200_000) {
  return {
    maxChars,
    prompts: {
      coordinator: {
        default: effective,
        custom: null,
        effective,
        isCustom: false,
      },
      solo: { default: 'Solo', custom: null, effective: 'Solo', isCustom: false },
      re: { default: 'RE', custom: null, effective: 'RE', isCustom: false },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useOrchestrationPromptStore.setState({
    prompts: null,
    selectedMode: 'coordinator',
    draft: '',
    maxChars: 200_000,
    isLoading: false,
    isSaving: false,
    error: null,
    lastSavedAt: null,
  })
})

describe('orchestrationPromptStore request ownership', () => {
  it('keeps the newest fetch response when two loads finish out of order', async () => {
    const first = deferred<ReturnType<typeof response>>()
    const second = deferred<ReturnType<typeof response>>()
    orchestrationPromptsApiMock.get
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstFetch = useOrchestrationPromptStore.getState().fetch()
    const secondFetch = useOrchestrationPromptStore.getState().fetch()

    second.resolve(response('second'))
    await secondFetch
    first.resolve(response('first'))
    await firstFetch

    expect(useOrchestrationPromptStore.getState().draft).toBe('second')
    expect(useOrchestrationPromptStore.getState().isLoading).toBe(false)
  })

  it('lands a save on the mode that was saved even after the user switched modes', async () => {
    const save = deferred<{ ok: true; mode: 'coordinator'; isCustom: true }>()
    orchestrationPromptsApiMock.get.mockResolvedValue(response('coordinator default'))
    orchestrationPromptsApiMock.save.mockReturnValue(save.promise)

    await useOrchestrationPromptStore.getState().fetch()
    useOrchestrationPromptStore.getState().updateDraft('edited coordinator')
    const pendingSave = useOrchestrationPromptStore.getState().save()

    useOrchestrationPromptStore.getState().selectMode('solo')
    save.resolve({ ok: true, mode: 'coordinator', isCustom: true })

    await expect(pendingSave).resolves.toBe(true)
    const state = useOrchestrationPromptStore.getState()
    // The write landed, so the badge has to say so — and the switch to Solo must
    // not have been rewritten to coordinator's text.
    expect(state.prompts?.coordinator.isCustom).toBe(true)
    expect(state.prompts?.coordinator.effective).toBe('edited coordinator')
    expect(state.selectedMode).toBe('solo')
    expect(state.draft).toBe('Solo')
    expect(state.isSaving).toBe(false)
  })

  it('serializes saves so a second click cannot race the first request', async () => {
    const save = deferred<{ ok: true; mode: 'coordinator'; isCustom: true }>()
    orchestrationPromptsApiMock.get.mockResolvedValue(response('coordinator default'))
    orchestrationPromptsApiMock.save.mockReturnValue(save.promise)

    await useOrchestrationPromptStore.getState().fetch()
    useOrchestrationPromptStore.getState().updateDraft('edited coordinator')
    const first = useOrchestrationPromptStore.getState().save()
    const duplicate = useOrchestrationPromptStore.getState().save()

    expect(orchestrationPromptsApiMock.save).toHaveBeenCalledTimes(1)
    await expect(duplicate).resolves.toBe(false)

    save.resolve({ ok: true, mode: 'coordinator', isCustom: true })
    await expect(first).resolves.toBe(true)
    expect(useOrchestrationPromptStore.getState().prompts?.coordinator.effective).toBe('edited coordinator')
  })

  it('refuses an over-limit draft without calling the API', async () => {
    orchestrationPromptsApiMock.get.mockResolvedValue(response('short', 10))
    await useOrchestrationPromptStore.getState().fetch()

    useOrchestrationPromptStore.getState().updateDraft('this is longer than ten characters')

    await expect(useOrchestrationPromptStore.getState().save()).resolves.toBe(false)
    expect(orchestrationPromptsApiMock.save).not.toHaveBeenCalled()
  })

  it('refuses a blank draft without calling the API', async () => {
    orchestrationPromptsApiMock.get.mockResolvedValue(response('short'))
    await useOrchestrationPromptStore.getState().fetch()

    useOrchestrationPromptStore.getState().updateDraft('   ')

    await expect(useOrchestrationPromptStore.getState().save()).resolves.toBe(false)
    expect(orchestrationPromptsApiMock.save).not.toHaveBeenCalled()
  })

  it('keeps an unsaved draft across a refresh', async () => {
    orchestrationPromptsApiMock.get.mockResolvedValue(response('from server'))
    await useOrchestrationPromptStore.getState().fetch()
    useOrchestrationPromptStore.getState().updateDraft('typed but unsaved')

    await useOrchestrationPromptStore.getState().fetch()

    expect(useOrchestrationPromptStore.getState().draft).toBe('typed but unsaved')
  })
})
