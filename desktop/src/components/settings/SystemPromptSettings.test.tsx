import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { systemPromptApiMock } = vi.hoisted(() => ({
  systemPromptApiMock: {
    get: vi.fn(),
    save: vi.fn(),
    reset: vi.fn(),
  },
}))

vi.mock('../../api/systemPrompt', () => ({
  systemPromptApi: systemPromptApiMock,
}))

// The real renderer pulls katex/marked/dompurify in for content this suite never
// asserts on; same stub the AgentManager suite uses.
vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))

import type { SystemPromptResponse } from '../../api/systemPrompt'
import { useSystemPromptStore } from '../../stores/systemPromptStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { SystemPromptSettings } from './SystemPromptSettings'

const BUILT_IN = 'You are an interactive agent that helps users with software engineering tasks.'

function makeResponse(overrides: Partial<SystemPromptResponse> = {}): SystemPromptResponse {
  const custom = overrides.custom ?? null
  return {
    custom,
    isCustom: custom !== null,
    default: BUILT_IN,
    maxChars: 200_000,
    ...overrides,
  }
}

async function renderSettings(response: SystemPromptResponse = makeResponse()) {
  systemPromptApiMock.get.mockResolvedValue(response)
  render(<SystemPromptSettings />)
  await waitFor(() => expect(systemPromptApiMock.get).toHaveBeenCalled())
  return response
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useSystemPromptStore.setState({
    data: null,
    draft: '',
    isLoading: false,
    isSaving: false,
    error: null,
    lastSavedAt: null,
  })
})

describe('SystemPromptSettings', () => {
  it('seeds the editor from the built-in snapshot and marks the prompt as default', async () => {
    await renderSettings()

    expect(screen.getByLabelText('System prompt')).toHaveValue(BUILT_IN)
    expect(screen.getAllByText('Default').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()
    // The replace warning is always shown.
    expect(screen.getByRole('status')).toHaveTextContent(/replaces the built-in system prompt in full/i)
  })

  it('shows the custom text with a custom badge and a reset action', async () => {
    await renderSettings(makeResponse({ custom: 'You are a pirate assistant.' }))

    expect(screen.getByLabelText('System prompt')).toHaveValue('You are a pirate assistant.')
    expect(screen.getByText('Custom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeInTheDocument()
  })

  it('saves the draft and marks it saved', async () => {
    await renderSettings()
    systemPromptApiMock.save.mockResolvedValue({ ok: true, isCustom: true })

    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'MY PROMPT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(systemPromptApiMock.save).toHaveBeenCalledWith('MY PROMPT'))
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
  })

  it('loads the built-in default into the editor without saving', async () => {
    await renderSettings(makeResponse({ custom: 'OLD CUSTOM' }))

    fireEvent.click(screen.getByRole('button', { name: 'Load built-in default' }))

    expect(screen.getByLabelText('System prompt')).toHaveValue(BUILT_IN)
    expect(systemPromptApiMock.save).not.toHaveBeenCalled()
    // The load leaves the draft dirty against the stored custom text.
    expect(screen.getByText('Unsaved')).toBeInTheDocument()
  })

  it('resets the override after confirmation', async () => {
    await renderSettings(makeResponse({ custom: 'OLD CUSTOM' }))
    systemPromptApiMock.reset.mockResolvedValue({ ok: true, isCustom: false })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    // ConfirmDialog renders its own confirm button with the same label.
    const confirmButtons = screen.getAllByRole('button', { name: 'Reset to default' })
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!)

    await waitFor(() => expect(systemPromptApiMock.reset).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByLabelText('System prompt')).toHaveValue(BUILT_IN))
  })

  it('blocks saving a blank prompt', async () => {
    await renderSettings()

    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: '   ' } })

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('blocks saving a prompt past the ceiling and shows the limit', async () => {
    await renderSettings(makeResponse({ maxChars: 10 }))

    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'x'.repeat(11) } })

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/limit is 10/)
  })

  it('shows a load failure with a retry when the initial fetch fails', async () => {
    systemPromptApiMock.get.mockRejectedValue(new Error('boom'))
    render(<SystemPromptSettings />)

    await waitFor(() => expect(screen.getByText('Could not load the system prompt')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
