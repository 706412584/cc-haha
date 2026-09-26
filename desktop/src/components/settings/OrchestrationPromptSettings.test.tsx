import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { orchestrationPromptsApiMock } = vi.hoisted(() => ({
  orchestrationPromptsApiMock: {
    get: vi.fn(),
    save: vi.fn(),
    reset: vi.fn(),
  },
}))

vi.mock('../../api/orchestrationPrompts', () => ({
  orchestrationPromptsApi: orchestrationPromptsApiMock,
}))

// The real renderer pulls katex/marked/dompurify in for content this suite never
// asserts on; same stub the AgentManager suite uses.
vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))

import type { OrchestrationPromptsResponse } from '../../api/orchestrationPrompts'
import { useOrchestrationPromptStore } from '../../stores/orchestrationPromptStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { OrchestrationPromptSettings } from './OrchestrationPromptSettings'

const DEFAULT_PROMPT = 'You are the coordinator. Fan out tasks to specialist workers.'
const SOLO_DEFAULT = 'You are running the Solo pipeline.'

function makeResponse(overrides: {
  coordinatorCustom?: string | null
  maxChars?: number
} = {}): OrchestrationPromptsResponse {
  const coordinatorCustom = overrides.coordinatorCustom ?? null
  return {
    maxChars: overrides.maxChars ?? 200_000,
    prompts: {
      coordinator: {
        default: DEFAULT_PROMPT,
        custom: coordinatorCustom,
        effective: coordinatorCustom ?? DEFAULT_PROMPT,
        isCustom: coordinatorCustom !== null,
      },
      solo: {
        default: SOLO_DEFAULT,
        custom: null,
        effective: SOLO_DEFAULT,
        isCustom: false,
      },
      re: {
        default: 'RE default.',
        custom: null,
        effective: 'RE default.',
        isCustom: false,
      },
    },
  }
}

async function renderSettings(response: OrchestrationPromptsResponse = makeResponse()) {
  orchestrationPromptsApiMock.get.mockResolvedValue(response)
  render(<OrchestrationPromptSettings />)
  await waitFor(() => expect(orchestrationPromptsApiMock.get).toHaveBeenCalled())
  return response
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
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

describe('OrchestrationPromptSettings', () => {
  it('loads the built-in prompt into the editor and marks the mode as default', async () => {
    await renderSettings()

    expect(screen.getByLabelText('Orchestration mode')).toHaveValue(DEFAULT_PROMPT)
    // One badge per rail row plus the editor toolbar — all three modes ship default.
    expect(screen.getAllByText('Default')).toHaveLength(4)
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()
  })

  it('saves the edited draft through PUT for the selected mode', async () => {
    orchestrationPromptsApiMock.save.mockResolvedValue({
      ok: true,
      mode: 'coordinator',
      isCustom: true,
    })
    await renderSettings()

    const editor = screen.getByLabelText('Orchestration mode')
    fireEvent.change(editor, { target: { value: 'Custom coordinator prompt.' } })
    expect(screen.getByText('Unsaved')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(orchestrationPromptsApiMock.save).toHaveBeenCalledWith(
      'coordinator',
      'Custom coordinator prompt.',
    ))
    // The rail row and the editor toolbar both flip to "Custom".
    await waitFor(() => expect(screen.getAllByText('Custom')).toHaveLength(2))
    expect(screen.getByText('Saved')).toBeInTheDocument()
    // The runtime picks the change up on the next mode switch or session.
    expect(screen.getByText(
      'Changes take effect the next time you switch modes or start a new session.',
    )).toBeInTheDocument()
  })

  it('resets a custom prompt through DELETE after confirmation', async () => {
    orchestrationPromptsApiMock.reset.mockResolvedValue({
      ok: true,
      mode: 'coordinator',
      isCustom: false,
    })
    await renderSettings(makeResponse({ coordinatorCustom: 'Custom coordinator prompt.' }))

    expect(screen.getByLabelText('Orchestration mode')).toHaveValue('Custom coordinator prompt.')

    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reset to default' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to default' }))

    await waitFor(() => expect(orchestrationPromptsApiMock.reset).toHaveBeenCalledWith('coordinator'))
    // Reset must clear the override, not write the built-in text back as a value.
    expect(orchestrationPromptsApiMock.save).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByLabelText('Orchestration mode')).toHaveValue(DEFAULT_PROMPT))
    expect(screen.getAllByText('Default')).toHaveLength(4)
  })

  it('blocks an over-limit draft and explains the ceiling instead of calling the API', async () => {
    await renderSettings(makeResponse({ maxChars: 10 }))

    fireEvent.change(screen.getByLabelText('Orchestration mode'), {
      target: { value: 'This prompt is far too long.' },
    })

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Too long: the limit is 10 characters.')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(orchestrationPromptsApiMock.save).not.toHaveBeenCalled()
  })

  it('confirms before a mode switch would drop an unsaved draft', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    await renderSettings()

    fireEvent.change(screen.getByLabelText('Orchestration mode'), {
      target: { value: 'Half-typed coordinator prompt.' },
    })

    // Declining keeps the user on the mode they were editing.
    confirmSpy.mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole('tab', { name: /Solo mode/ }))
    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes to this prompt?')
    expect(screen.getByLabelText('Orchestration mode')).toHaveValue('Half-typed coordinator prompt.')

    // Accepting moves on and loads that mode's own text.
    confirmSpy.mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('tab', { name: /Solo mode/ }))
    expect(screen.getByLabelText('Solo mode')).toHaveValue(SOLO_DEFAULT)
  })

  it('does not prompt when the draft has no unsaved changes', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    await renderSettings()

    fireEvent.click(screen.getByRole('tab', { name: /Solo mode/ }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Solo mode')).toHaveValue(SOLO_DEFAULT)
  })

  it('warns that a custom RE prompt replaces the authorization gate too', async () => {
    await renderSettings()

    expect(screen.queryByText(/authorization gate/)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /RE pipeline/ }))

    expect(screen.getByText(
      'A custom prompt replaces the default in full — including its authorization gate and its refusal of jailbreak instructions.',
    )).toBeInTheDocument()
    expect(screen.getByLabelText('RE pipeline')).toHaveValue('RE default.')
  })
})
