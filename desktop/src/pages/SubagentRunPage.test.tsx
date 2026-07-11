import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubagentRunResponse } from '../api/subagents'
import { useSettingsStore } from '../stores/settingsStore'

vi.mock('../api/subagents', () => ({
  subagentsApi: {
    getRunByTool: vi.fn(),
  },
}))

import { subagentsApi } from '../api/subagents'
import { SubagentRunPage } from './SubagentRunPage'

const TRANSCRIPT_TIMESTAMP = '2026-07-03T10:20:11.000Z'

function subagentRun(overrides: Partial<SubagentRunResponse> = {}): SubagentRunResponse {
  return {
    sessionId: 'session-1',
    toolUseId: 'tool-1',
    agentId: 'abc123',
    status: 'completed',
    description: 'Explore repo',
    prompt: 'Read files',
    summary: 'Found layout seam',
    messages: [
      {
        id: 'msg-user',
        type: 'user',
        content: 'Read files',
        timestamp: TRANSCRIPT_TIMESTAMP,
      },
      {
        id: 'msg-assistant',
        type: 'assistant',
        content: [{ type: 'text', text: 'Finding' }],
        timestamp: TRANSCRIPT_TIMESTAMP,
      },
    ],
    truncated: false,
    source: 'subagent-jsonl',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

describe('SubagentRunPage', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.mocked(subagentsApi.getRunByTool).mockReset()
  })

  it('renders SubAgent run details', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      outputFile: '/tmp/result.md',
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    expect(await screen.findByText('Kuhn')).toBeInTheDocument()
    expect(screen.getByText('Agent: abc123')).toBeInTheDocument()
    expect(screen.getAllByText('Explore repo').length).toBeGreaterThan(0)
    expect(screen.getByText('Output: /tmp/result.md')).toBeInTheDocument()
    expect(screen.queryByText('Parent Agent Tool Call')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('"prompt": "Read files"')
    expect(screen.queryByText(/Dispatched an agent|派遣了一个代理/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open run/ })).not.toBeInTheDocument()

    const transcript = screen.getByTestId('subagent-conversation')
    expect(transcript).toHaveTextContent('Read files')
    expect(transcript).toHaveTextContent('Finding')
    expect(transcript).not.toHaveTextContent('assistant_text')
  })

  it('renders a loading state while the run is loading', () => {
    vi.mocked(subagentsApi.getRunByTool).mockReturnValue(deferred<SubagentRunResponse>().promise)

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="Kuhn" />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading SubAgent run...')
    expect(screen.getByRole('button', { name: 'Refresh SubAgent run' })).toBeDisabled()
  })

  it('renders a missing transcript fallback', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockResolvedValue(subagentRun({
      agentId: null,
      status: 'unknown',
      summary: 'Only summary available',
      messages: [],
      source: 'none',
    }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    const conversation = await screen.findByTestId('subagent-conversation')
    expect(conversation).toHaveTextContent('Only summary available')
    expect(screen.queryByText('No local transcript messages captured for this SubAgent.')).not.toBeInTheDocument()
  })

  it('refreshes running SubAgent runs while the detail tab is open', async () => {
    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(subagentRun({
        status: 'running',
        messages: [],
        prompt: 'Review streaming changes',
      }))
      .mockResolvedValueOnce(subagentRun({
        status: 'completed',
        messages: [],
        prompt: 'Review streaming changes',
        result: 'Streaming review complete',
      }))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-conversation')).toHaveTextContent('Review streaming changes')

    await waitFor(() => expect(subagentsApi.getRunByTool).toHaveBeenCalledTimes(2), { timeout: 2500 })
    expect(await screen.findByText('Completed')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-conversation')).toHaveTextContent('Streaming review complete')
  })

  it('keeps the tab open on API errors', async () => {
    vi.mocked(subagentsApi.getRunByTool).mockRejectedValue(new Error('boom'))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'))
    expect(screen.getByRole('button', { name: 'Refresh SubAgent run' })).toBeInTheDocument()
  })

  it('ignores stale responses when the selected SubAgent changes before the first request resolves', async () => {
    const first = deferred<SubagentRunResponse>()
    const second = deferred<SubagentRunResponse>()
    vi.mocked(subagentsApi.getRunByTool).mockImplementation((sessionId) =>
      sessionId === 'session-a' ? first.promise : second.promise
    )

    const { rerender } = render(<SubagentRunPage sourceSessionId="session-a" toolUseId="tool-a" title="First Agent" />)
    rerender(<SubagentRunPage sourceSessionId="session-b" toolUseId="tool-b" title="Second Agent" />)

    await act(async () => {
      second.resolve(subagentRun({
        sessionId: 'session-b',
        toolUseId: 'tool-b',
        summary: 'Second result',
        messages: [{
          id: 'second-finding',
          type: 'assistant',
          content: [{ type: 'text', text: 'Second finding' }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        }],
      }))
      await second.promise
    })

    expect(screen.getByText(/Second finding/)).toBeInTheDocument()

    await act(async () => {
      first.resolve(subagentRun({
        sessionId: 'session-a',
        toolUseId: 'tool-a',
        summary: 'Stale first result',
        messages: [{
          id: 'stale-finding',
          type: 'assistant',
          content: [{ type: 'text', text: 'Stale finding' }],
          timestamp: TRANSCRIPT_TIMESTAMP,
        }],
      }))
      await first.promise
    })

    expect(screen.getByText(/Second finding/)).toBeInTheDocument()
    expect(screen.queryByText('Stale first result')).not.toBeInTheDocument()
    expect(screen.queryByText(/Stale finding/)).not.toBeInTheDocument()
  })

  it('keeps existing details visible when refresh fails', async () => {
    vi.mocked(subagentsApi.getRunByTool)
      .mockResolvedValueOnce(subagentRun({ messages: [], summary: 'Initial result' }))
      .mockRejectedValueOnce(new Error('refresh failed'))

    render(<SubagentRunPage sourceSessionId="session-1" toolUseId="tool-1" title="SubAgent" />)

    expect((await screen.findAllByText('Initial result')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh SubAgent run' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('refresh failed'))
    expect(screen.getAllByText('Initial result').length).toBeGreaterThan(0)
  })
})
