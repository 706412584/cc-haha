import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { emitAgentRunMessage, setAgentRunMessageSink } from '../utils/sdkEventQueue.js'
import { Stream } from '../utils/stream.js'
import {
  __runHeadlessStreamingForTests,
  bindAgentRunMessageSink,
} from './print.js'
import { RemoteIO } from './remoteIO.js'
import { StructuredIO } from './structuredIO.js'

async function* emptyInput(): AsyncGenerator<string> {}

describe('headless Agent stream outbound binding', () => {
  let wasInteractive = true

  beforeEach(() => {
    wasInteractive = getIsInteractive()
    setIsInteractive(false)
    setAgentRunMessageSink(undefined)
  })

  afterEach(() => {
    setAgentRunMessageSink(undefined)
    setIsInteractive(wasInteractive)
  })

  test('sends the private child stream directly through RemoteIO only', async () => {
    const regular = new StructuredIO(emptyInput())
    const removeRegular = bindAgentRunMessageSink(regular)
    emitAgentRunMessage({
      runAgentId: 'regular-agent',
      streamId: 'regular-stream',
      targetAgentId: 'regular-agent',
    }, { kind: 'complete' })
    removeRegular()
    regular.outbound.done()
    expect(await regular.outbound.next()).toEqual({ done: true, value: undefined })

    const remote = new StructuredIO(emptyInput())
    Object.setPrototypeOf(remote, RemoteIO.prototype)
    const removeRemote = bindAgentRunMessageSink(remote)
    emitAgentRunMessage({
      runAgentId: 'desktop-agent',
      streamId: 'desktop-stream',
      targetAgentId: 'desktop-agent',
    }, {
      kind: 'message',
      message: { type: 'stream_event', event: { type: 'content_block_delta' } },
    })

    expect((await remote.outbound.next()).value).toMatchObject({
      type: 'system',
      subtype: 'agent_run_message',
      run_agent_id: 'desktop-agent',
      stream_id: 'desktop-stream',
      target_agent_id: 'desktop-agent',
      event_kind: 'message',
    })
    removeRemote()
  })

  test('binds the real headless RemoteIO stream to the same outbound FIFO', async () => {
    const input = new Stream<string>()
    const remote = new StructuredIO(input)
    Object.setPrototypeOf(remote, RemoteIO.prototype)

    let appState = getDefaultAppState()
    const sigintListenersBefore = new Set(process.listeners('SIGINT'))
    const output = __runHeadlessStreamingForTests(
      remote,
      [],
      [],
      [],
      [],
      (() => undefined) as unknown as CanUseToolFn,
      {},
      () => appState,
      update => {
        appState = update(appState)
      },
      [],
      {
        verbose: undefined,
        jsonSchema: undefined,
        permissionPromptToolName: undefined,
        allowedTools: undefined,
        thinkingConfig: undefined,
        maxTurns: undefined,
        maxBudgetUsd: undefined,
        taskBudget: undefined,
        systemPrompt: undefined,
        appendSystemPrompt: undefined,
        userSpecifiedModel: undefined,
        fallbackModel: undefined,
        outputFormat: 'stream-json',
      },
    )
    const iterator = output[Symbol.asyncIterator]()

    emitAgentRunMessage({
      runAgentId: 'joined-agent',
      streamId: 'joined-stream',
      targetAgentId: 'joined-agent',
    }, { kind: 'complete' })
    const sentinel = { type: 'agent-run-stream-test-sentinel' } as never
    remote.outbound.enqueue(sentinel)

    const beforeSentinel = []
    for (;;) {
      const next = await iterator.next()
      if (next.value === sentinel) break
      beforeSentinel.push(next.value)
    }
    expect(beforeSentinel).toContainEqual(
      expect.objectContaining({
        type: 'system',
        subtype: 'agent_run_message',
        run_agent_id: 'joined-agent',
        stream_id: 'joined-stream',
      }),
    )

    input.done()
    while (!(await iterator.next()).done) {
      // Drain until the real headless input loop removes its sink and closes.
    }
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintListenersBefore.has(listener)) process.off('SIGINT', listener)
    }
  })
})
