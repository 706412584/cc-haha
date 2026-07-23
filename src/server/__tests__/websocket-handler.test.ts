import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  __markPrewarmPendingForTests,
  __markActiveTurnForTests,
  __refreshDisconnectedTurnCleanupWatcherForTests,
  __registerPendingUserTurnForTests,
  __markPrewarmedForTests,
  __resetWebSocketHandlerStateForTests,
  __setCachedSessionSummaryReaderForTests,
  __drainWebSocketRuntimeTransitionsForTests,
  closeSessionConnection,
  getActiveSessionIds,
  handleWebSocket,
  translateCliMessage,
  type WebSocketData,
} from '../ws/handler.js'
import {
  __resetDisconnectGraceMsForTests,
  __setDisconnectGraceMsForTests,
} from '../ws/disconnectGraceConfig.js'
import { conversationService } from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import { sessionService } from '../services/sessionService.js'

function makeClientSocket(sessionId: string, clientKind: 'full' | 'pet' = 'full') {
  const sent: string[] = []
  return {
    data: {
      sessionId,
      connectedAt: Date.now(),
      channel: 'client',
      clientKind,
      sdkToken: null,
      serverPort: 0,
      serverHost: '127.0.0.1',
    },
    send: mock((payload: string) => {
      sent.push(payload)
    }),
    close: mock(() => {}),
    sent,
  } as unknown as ServerWebSocket<WebSocketData> & { sent: string[] }
}

describe('translateCliMessage usage mapping', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('keeps cache token counts on result completion events', () => {
    const sessionId = `usage-${crypto.randomUUID()}`

    const messages = translateCliMessage({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 3456,
        cache_creation_input_tokens: 789,
      },
    }, sessionId)

    expect(messages).toEqual([{
      type: 'message_complete',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 3456,
        cache_creation_tokens: 789,
      },
    }])
  })

  it('silently ignores CLI keep-alive frames', () => {
    const log = spyOn(console, 'log')

    expect(translateCliMessage({ type: 'keep_alive' }, 'session-1')).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })

  it('maps SDK permission cancellation and response events to resolution messages', () => {
    expect(translateCliMessage({
      type: 'control_cancel_request',
      request_id: 'permission-1',
    }, 'session-1')).toEqual([{
      type: 'permission_resolved',
      requestId: 'permission-1',
      permissionType: 'tool',
    }])

    expect(translateCliMessage({
      type: 'control_response',
      response: {
        request_id: 'permission-2',
        response: { behavior: 'deny' },
      },
    }, 'session-1')).toEqual([{
      type: 'permission_resolved',
      requestId: 'permission-2',
      permissionType: 'tool',
      allowed: false,
    }])
  })
})

describe('WebSocket handler session isolation', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    __resetDisconnectGraceMsForTests()
    mock.restore()
  })

  it('ignores stale disconnects from an older socket for the same session', () => {
    const sessionId = `duplicate-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const clearCallbacks = spyOn(conversationService, 'clearOutputCallbacks')
    const cancelComputerUse = spyOn(computerUseApprovalService, 'cancelSession')

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    clearCallbacks.mockClear()
    cancelComputerUse.mockClear()

    handleWebSocket.close(first, 1000, 'stale tab closed')

    expect(getActiveSessionIds()).toContain(sessionId)
    expect(clearCallbacks).not.toHaveBeenCalled()
    expect(cancelComputerUse).not.toHaveBeenCalled()
  })

  it('closes and removes an active client socket when a session is deleted', () => {
    const sessionId = `delete-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const clearCallbacks = spyOn(conversationService, 'clearOutputCallbacks')
    const cancelComputerUse = spyOn(computerUseApprovalService, 'cancelSession')

    handleWebSocket.open(ws)

    expect(closeSessionConnection(sessionId, 'session deleted')).toBe(true)

    expect(getActiveSessionIds()).not.toContain(sessionId)
    expect(ws.close).toHaveBeenCalledWith(1000, 'session deleted')
    expect(clearCallbacks).toHaveBeenCalledWith(sessionId)
    expect(cancelComputerUse).toHaveBeenCalledWith(sessionId)
  })

  it('replays pending permission requests when a client reconnects', () => {
    const sessionId = `permission-reconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      {
        requestId: 'request-ask-1',
        toolName: 'AskUserQuestion',
        toolUseId: 'tool-ask-1',
        input: {
          questions: [
            {
              header: 'Scope',
              question: 'Which scope?',
              options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
            },
          ],
        },
        description: 'Answer questions?',
      },
    ])

    handleWebSocket.open(ws)

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_request',
      requestId: 'request-ask-1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-ask-1',
      input: {
        questions: [
          {
            header: 'Scope',
            question: 'Which scope?',
            options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
          },
        ],
      },
      description: 'Answer questions?',
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: ['request-ask-1'],
      computerUseRequestIds: [],
      turnActive: false,
    })
  })

  it('gives pet clients only sanitized state and denies privileged client messages', () => {
    const sessionId = `pet-capability-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    let outputCallback: ((message: unknown) => void) | null = null
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{
      requestId: 'pet-hidden-request',
      toolName: 'Read',
      input: { file_path: '/Users/alice/private.txt' },
    }])
    const clearSessionTranscript = spyOn(sessionService, 'clearSessionTranscript')

    handleWebSocket.open(ws)
    outputCallback?.({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'private transcript text' }] },
    })
    outputCallback?.({ type: 'system', subtype: 'status', status: 'compacting' })
    handleWebSocket.message(ws, JSON.stringify({
      type: 'set_permission_mode',
      mode: 'bypassPermissions',
    }))
    handleWebSocket.message(ws, JSON.stringify({ type: 'ping' }))
    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: '/clear' }))

    const sent = ws.sent.map((payload) => JSON.parse(payload))
    expect(sent).toContainEqual({ type: 'connected', sessionId })
    expect(sent).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
    expect(sent).toContainEqual({
      type: 'error',
      message: 'Pet action failed. Open the session for details.',
      code: 'PET_CAPABILITY_DENIED',
    })
    expect(sent).toContainEqual({ type: 'pong' })
    expect(clearSessionTranscript).not.toHaveBeenCalled()
    expect(sent).not.toContainEqual(expect.objectContaining({ type: 'permission_request' }))
    expect(JSON.stringify(sent)).not.toContain('/Users/alice/private.txt')
    expect(JSON.stringify(sent)).not.toContain('private transcript text')
  })

  it('keeps only the selected pet session socket active', () => {
    const first = makeClientSocket(`pet-first-${crypto.randomUUID()}`, 'pet')
    const second = makeClientSocket(`pet-second-${crypto.randomUUID()}`, 'pet')

    handleWebSocket.open(first)
    handleWebSocket.open(second)

    expect(first.close).toHaveBeenCalledWith(1000, 'Pet session switched')
    expect(second.close).not.toHaveBeenCalled()
  })

  it('tracks and replays pending Computer Use requests when a client reconnects', async () => {
    const sessionId = `computer-use-reconnect-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const request = {
      requestId: 'cu-request-1',
      reason: 'Inspect another app',
      apps: [],
      requestedFlags: {},
      screenshotFiltering: 'native' as const,
    }
    const response = {
      granted: [],
      denied: [],
      flags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      userConsented: true,
    }

    handleWebSocket.open(first)
    const approval = computerUseApprovalService.requestApproval(sessionId, request)
    expect(computerUseApprovalService.getPendingRequests(sessionId)).toEqual([request])

    handleWebSocket.open(second)

    expect(second.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'connected', sessionId },
      {
        type: 'computer_use_permission_request',
        requestId: request.requestId,
        request,
      },
      {
        type: 'permission_requests_snapshot',
        toolRequestIds: [],
        computerUseRequestIds: [request.requestId],
        turnActive: false,
      },
    ])

    expect(computerUseApprovalService.resolveApproval(request.requestId, response)).toBe(true)
    await expect(approval).resolves.toEqual(response)
    expect(computerUseApprovalService.getPendingRequests(sessionId)).toEqual([])
  })

  it('marks a registered pre-send user turn active in the reconnect snapshot', () => {
    const sessionId = `pending-turn-reconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    __registerPendingUserTurnForTests(sessionId)

    handleWebSocket.open(ws)

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: true,
    })
  })

  it('does not revive a stopped turn in the reconnect snapshot', () => {
    const sessionId = `stopped-turn-reconnect-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    handleWebSocket.open(first)
    __markActiveTurnForTests(sessionId)

    handleWebSocket.message(first, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.open(second)

    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: false,
    })
  })

  it('replays an applied runtime request idempotently after its result is lost', async () => {
    const sessionId = `runtime-replay-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
      filePath: '/tmp/runtime-replay.jsonl',
      projectDir: '-tmp',
      workDir: '/tmp',
      transcriptMessageCount: 0,
      customTitle: null,
    })
    spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    const request = {
      type: 'set_runtime_config',
      requestId: crypto.randomUUID(),
      providerId: null,
      modelId: 'claude-opus-4-7',
    }

    handleWebSocket.message(ws, JSON.stringify(request))
    await __drainWebSocketRuntimeTransitionsForTests()
    handleWebSocket.message(ws, JSON.stringify(request))
    await __drainWebSocketRuntimeTransitionsForTests()

    expect(ws.sent.map(payload => JSON.parse(payload)).filter(
      message => message.type === 'runtime_config_result',
    )).toEqual([
      {
        type: 'runtime_config_result',
        requestId: request.requestId,
        result: 'applied',
        selection: {
          providerId: null,
          modelId: request.modelId,
        },
      },
      {
        type: 'runtime_config_result',
        requestId: request.requestId,
        result: 'applied',
        selection: {
          providerId: null,
          modelId: request.modelId,
        },
      },
    ])
  })

  it('applies cross-provider runtime config in-session without forcing a transition', async () => {
    const sessionId = `runtime-cross-provider-apply-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({
      filePath: '/tmp/runtime-cross-provider-apply.jsonl',
      projectDir: '-tmp',
      workDir: '/tmp',
      transcriptMessageCount: 2,
      customTitle: null,
      runtimeProviderId: 'provider-a',
    })
    spyOn(sessionService, 'appendSessionMetadata').mockResolvedValue(undefined)
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    const request = {
      type: 'set_runtime_config',
      requestId: crypto.randomUUID(),
      providerId: null,
      modelId: 'claude-opus-4-7',
    }

    handleWebSocket.message(ws, JSON.stringify(request))
    await __drainWebSocketRuntimeTransitionsForTests()
    handleWebSocket.message(ws, JSON.stringify(request))
    await __drainWebSocketRuntimeTransitionsForTests()

    const results = ws.sent.map(payload => JSON.parse(payload)).filter(
      message => message.type === 'runtime_config_result',
    )
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      requestId: request.requestId,
      result: 'applied',
      selection: {
        providerId: null,
        modelId: request.modelId,
      },
    })
    expect(results[1]).toEqual(results[0])
  })

  it('rejects malformed runtime request ids without applying a selection', async () => {
    const sessionId = `runtime-invalid-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const appendMetadata = spyOn(sessionService, 'appendSessionMetadata')

    handleWebSocket.message(ws, JSON.stringify({
      type: 'set_runtime_config',
      requestId: 'not-a-uuid',
      providerId: null,
      modelId: 'claude-opus-4-7',
    }))
    await __drainWebSocketRuntimeTransitionsForTests()

    expect(ws.sent.map(payload => JSON.parse(payload))).toContainEqual({
      type: 'runtime_config_result',
      requestId: 'not-a-uuid',
      result: 'rejected',
      code: 'RUNTIME_CONFIG_REQUEST_INVALID',
      message: 'Runtime config request id is invalid.',
    })
    expect(appendMetadata).not.toHaveBeenCalled()
  })

  it('does not let a stopped turn fallback kill a replacement turn', () => {
    const sessionId = `stopped-turn-replaced-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any)
    const sendInterrupt = spyOn(conversationService, 'sendInterrupt').mockImplementation(() => {})
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const stopSessionInstance = spyOn(conversationService, 'stopSessionInstance').mockReturnValue(true)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getActiveInstanceId').mockReturnValue('instance-stopped-turn')
    __markActiveTurnForTests(sessionId)

    handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))

    expect(sendInterrupt).toHaveBeenCalledWith(sessionId)
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3_000)
    const expireForceKill = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined

    __registerPendingUserTurnForTests(sessionId)
    expireForceKill?.()

    expect(stopSession).not.toHaveBeenCalled()
    expect(stopSessionInstance).not.toHaveBeenCalled()
  })

  it('forwards background task stop requests to the CLI control channel', async () => {
    const sessionId = `stop-background-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'bash-task-1',
    }))
    await Promise.resolve()

    expect(requestControl).toHaveBeenCalledWith(sessionId, {
      subtype: 'stop_task',
      task_id: 'bash-task-1',
    })
  })

  it('silently confirms a background stop when the CLI session is already gone', async () => {
    const sessionId = `stop-background-gone-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'requestControl').mockRejectedValue(
      new Error('CLI session is not running'),
    )

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'bash-task-1',
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stopped',
      taskId: 'bash-task-1',
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ type: 'background_task_stop_failed' }),
    )
  })

  it('confirms a background stop when the CLI exits during the request', async () => {
    const sessionId = `stop-background-exit-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let sessionRunning = true
    spyOn(conversationService, 'hasSession').mockImplementation(() => sessionRunning)
    spyOn(conversationService, 'requestControl').mockImplementation(async () => {
      sessionRunning = false
      throw new Error('CLI session is not running')
    })

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'bash-task-1',
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stopped',
      taskId: 'bash-task-1',
    })
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ type: 'background_task_stop_failed' }),
    )
  })

  it('confirms a timed-out background stop when the CLI session exited', async () => {
    const sessionId = `stop-background-timeout-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'requestControl').mockRejectedValue(
      new Error('Timed out waiting for stop_task response'),
    )

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'bash-task-1',
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stopped',
      taskId: 'bash-task-1',
    })
  })

  it('reports a timed-out background stop while the CLI session is still running', async () => {
    const sessionId = `stop-background-live-timeout-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'requestControl').mockRejectedValue(
      new Error('Timed out waiting for stop_task response'),
    )

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'bash-task-1',
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'bash-task-1',
      message: 'Timed out waiting for stop_task response',
    })
  })

  it('reports a task-scoped failure when the CLI rejects a background stop', async () => {
    const sessionId = `stop-background-failed-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'requestControl').mockRejectedValue(new Error('Task is not running'))

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'bash-task-1',
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'bash-task-1',
      message: 'Task is not running',
    })
  })

  it('rejects malformed background task ids without throwing from the async handler', async () => {
    const ws = makeClientSocket(`stop-background-invalid-${crypto.randomUUID()}`)
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({})

    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 42,
    }))
    await Promise.resolve()

    expect(requestControl).not.toHaveBeenCalled()
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: '',
      message: 'Background task id is required',
    })
  })

  it('persists terminal task notifications before forwarding them to the client', async () => {
    const sessionId = `task-notification-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()

    handleWebSocket.open(ws)
    ws.sent.length = 0

    const completed = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'terminal-task-event-1',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      status: 'completed',
      summary: 'Background task completed',
      timestamp: '2026-07-18T00:01:00.000Z',
    }
    outputCallback?.(completed)
    await Promise.resolve()
    await Promise.resolve()

    expect(append).toHaveBeenCalledTimes(1)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: completed,
    })

    // A running notification is UI activity, not a terminal state that should
    // be restored after restart. It must forward without another persistence.
    const running = {
      ...completed,
      uuid: 'running-task-event-1',
      status: 'running',
    }
    outputCallback?.(running)

    expect(append).toHaveBeenCalledTimes(1)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: running,
    })
  })

  it('does not send a stale stop failure after observing a terminal task notification', async () => {
    const sessionId = `task-notification-stop-race-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    let finishPersistence!: () => void
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve
    })
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(sessionService, 'appendSessionTaskNotification').mockReturnValue(persistence)
    spyOn(conversationService, 'requestControl').mockRejectedValue(
      new Error('Task is not running'),
    )

    handleWebSocket.open(ws)
    ws.sent.length = 0

    const completed = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'terminal-task-stop-race-1',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      status: 'completed',
      summary: 'Background task completed',
      timestamp: '2026-07-18T00:01:00.000Z',
    }
    outputCallback?.(completed)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'agent-task-1',
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ type: 'background_task_stop_failed' }),
    )
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ type: 'system_notification' }),
    )

    finishPersistence()
    await persistence
    await Promise.resolve()

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'system_notification',
      subtype: 'task_notification',
      data: completed,
    })
  })

  it('does not retain terminal task state after the session is closed', async () => {
    const sessionId = `task-notification-cleanup-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    spyOn(conversationService, 'requestControl').mockRejectedValue(
      new Error('Task is not running'),
    )

    handleWebSocket.open(first)
    outputCallback?.({
      type: 'system',
      subtype: 'task_notification',
      uuid: 'terminal-task-cleanup-1',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      status: 'completed',
    })
    expect(closeSessionConnection(sessionId, 'session replaced')).toBe(true)

    handleWebSocket.open(second)
    second.sent.length = 0
    handleWebSocket.message(second, JSON.stringify({
      type: 'stop_background_task',
      taskId: 'agent-task-1',
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'background_task_stop_failed',
      taskId: 'agent-task-1',
      message: 'Task is not running',
    })
  })

  it('broadcasts tool and Computer Use permission resolutions to every client', () => {
    const sessionId = `permission-resolution-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    spyOn(conversationService, 'respondToPermission').mockReturnValue(true)
    spyOn(computerUseApprovalService, 'resolveApproval').mockReturnValue(true)

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    first.sent.length = 0
    second.sent.length = 0

    handleWebSocket.message(first, JSON.stringify({
      type: 'permission_response',
      requestId: 'permission-1',
      allowed: true,
    }))

    for (const ws of [first, second]) {
      expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'permission_resolved',
        requestId: 'permission-1',
        permissionType: 'tool',
        allowed: true,
      })
      ws.sent.length = 0
    }

    handleWebSocket.message(second, JSON.stringify({
      type: 'computer_use_permission_response',
      requestId: 'cu-1',
      response: {
        granted: [],
        denied: [],
        flags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: false,
        },
        userConsented: false,
      },
    }))

    for (const ws of [first, second]) {
      expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: 'permission_resolved',
        requestId: 'cu-1',
        permissionType: 'computer_use',
        allowed: false,
      })
    }
  })

  it('keeps disconnected sessions alive longer while user input is pending', () => {
    const sessionId = `permission-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      {
        requestId: 'request-ask-1',
        toolName: 'AskUserQuestion',
        toolUseId: 'tool-ask-1',
        input: { questions: [] },
      },
    ])

    handleWebSocket.open(ws)
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1006, 'renderer reconnecting')

    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBeGreaterThan(30_000)
  })

  it('bounds an active turn waiting on permission after the last client disconnects', () => {
    const sessionId = `active-permission-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      {
        requestId: 'request-bash-1',
        toolName: 'Bash',
        input: { command: 'echo hello' },
      },
    ])
    let turnCompleteCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      turnCompleteCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1006, 'permission prompt abandoned')

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(30 * 60_000)
    expect(turnCompleteCallback).not.toBeNull()

    const expirePermissionWait = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expirePermissionWait?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('starts the permission cleanup bound when disconnect happens before the turn is sent', () => {
    const sessionId = `late-permission-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    const pendingRequests = spyOn(conversationService, 'getPendingPermissionRequests')
      .mockReturnValue([])
    let turnOutputCallback: ((cliMsg: any) => void) | null = null
    let cliSessionReady = false
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      // ConversationService.onOutput is a no-op until startSession has inserted
      // the session. This was the gap hidden by the previous regression test.
      if (cliSessionReady) turnOutputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    // Mirrors the real H5 race: user_message has synchronously claimed the
    // turn, but CLI startup has not completed and messageSent is still false.
    __registerPendingUserTurnForTests(sessionId)
    setTimeoutSpy.mockClear()
    handleWebSocket.close(ws, 1006, 'renderer closed before permission prompt')

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(turnOutputCallback).toBeNull()

    // CLI startup finishes while the H5 tab remains closed. handleUserMessage
    // refreshes the watcher immediately before sending the queued turn.
    cliSessionReady = true
    __refreshDisconnectedTurnCleanupWatcherForTests(sessionId)
    expect(turnOutputCallback).not.toBeNull()

    pendingRequests.mockReturnValue([{
      requestId: 'late-request-1',
      toolName: 'Bash',
      input: { command: 'echo later' },
    }])
    ;(turnOutputCallback as ((cliMsg: any) => void) | null)?.({
      type: 'control_request',
      request_id: 'late-request-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash' },
    })

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(30 * 60_000)
  })

  it('does not forward prewarm startup status to a reconnecting client', async () => {
    const sessionId = `prewarm-reconnect-${crypto.randomUUID()}`
    const second = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null

    __markPrewarmPendingForTests(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getRecentSdkMessages').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {
      outputCallback = null
    })

    handleWebSocket.open(second)
    outputCallback?.({
      type: 'stream_event',
      event: { type: 'message_start' },
    })

    const secondMessages = second.sent.map((payload) => JSON.parse(payload))
    expect(secondMessages).not.toContainEqual({ type: 'status', state: 'thinking' })
  })

  it('keeps a running session alive on disconnect and cleans up only after the turn finishes (issue #764)', () => {
    const sessionId = `running-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    let turnCompleteCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, cb) => {
      turnCompleteCallback = cb
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    setTimeoutSpy.mockClear()

    // Last client disconnects while the turn is still running: no kill timer,
    // just a turn-completion watcher.
    handleWebSocket.close(ws, 1006, 'phone locked screen')
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()
    expect(turnCompleteCallback).not.toBeNull()

    // Turn finishes while still disconnected → now the idle grace timer starts.
    turnCompleteCallback?.({ type: 'result', subtype: 'success' })
    expect(setTimeoutSpy).toHaveBeenCalled()
    // Timer body still hasn't run, so the process is not killed yet.
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('keeps the last disconnected client session alive until all background tasks finish', () => {
    const sessionId = `background-task-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)

    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      description: 'Verify the desktop app',
      task_type: 'local_agent',
    })
    outputCallbacks[0]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'shell-task-1',
      tool_use_id: 'shell-tool-1',
      status: 'running',
      output_file: '',
      summary: 'Running the focused tests',
    })
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1000, 'pet closed')

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()
    expect(outputCallbacks).toHaveLength(2)

    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      status: 'completed',
      output_file: '',
      summary: 'Desktop verification passed',
    })

    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()

    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'shell-task-1',
      tool_use_id: 'shell-tool-1',
      status: 'completed',
      output_file: '',
      summary: 'Focused tests passed',
    })

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(30_000)
    expect(stopSession).not.toHaveBeenCalled()

    const expireIdleGrace = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expireIdleGrace?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('cancels an armed idle timer when a background task starts late', () => {
    const sessionId = `late-background-task-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 123 as any)
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    setTimeoutSpy.mockClear()
    handleWebSocket.close(ws, 1000, 'pet closed while idle')

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(outputCallbacks).toHaveLength(2)
    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-task-1',
      tool_use_id: 'late-tool-1',
      description: 'Started after the idle timer was armed',
      task_type: 'local_agent',
    })

    expect(clearTimeoutSpy).toHaveBeenCalledWith(123)
    expect(stopSession).not.toHaveBeenCalled()

    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'late-task-1',
      tool_use_id: 'late-tool-1',
      status: 'completed',
      output_file: '',
      summary: 'Late task completed',
    })

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2)
    const expireIdleGrace = setTimeoutSpy.mock.calls[1]?.[0] as (() => void) | undefined
    expireIdleGrace?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('keeps the pending-permission disconnect bound when a background task starts late', () => {
    const sessionId = `permission-bound-background-task-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'pet')
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 456 as any)
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{
      requestId: 'permission-1',
      toolName: 'Bash',
      input: { command: 'echo pending' },
    }])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    const outputCallbacks: Array<(cliMsg: any) => void> = []
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    setTimeoutSpy.mockClear()
    clearTimeoutSpy.mockClear()
    handleWebSocket.close(ws, 1000, 'pet closed while awaiting permission')

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(30 * 60_000)
    expect(outputCallbacks).toHaveLength(2)

    outputCallbacks[1]?.({
      type: 'system',
      subtype: 'task_started',
      task_id: 'late-task-with-permission-1',
      tool_use_id: 'late-tool-with-permission-1',
      description: 'Started while permission was pending',
      task_type: 'local_agent',
    })

    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(456)
    const expirePermissionBound = setTimeoutSpy.mock.calls[0]?.[0] as (() => void) | undefined
    expirePermissionBound?.()
    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })

  it('uses the configured disconnect grace period for an idle session', () => {
    const sessionId = `idle-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    __setDisconnectGraceMsForTests(120_000)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(ws)
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1006, 'tab closed')

    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(120_000)
  })

  it('does not start the idle timer if the client reconnects before the turn finishes', () => {
    const sessionId = `reconnect-mid-turn-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const reconnected = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)

    let turnCompleteCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, cb) => {
      turnCompleteCallback = cb
    })
    const removeOutputCallback = spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    handleWebSocket.close(ws, 1006, 'phone locked screen')
    expect(turnCompleteCallback).not.toBeNull()

    // Reconnect tears down the watcher before the turn completes.
    handleWebSocket.open(reconnected)
    expect(removeOutputCallback).toHaveBeenCalled()
    setTimeoutSpy.mockClear()

    // A late result must not schedule cleanup now that a client is back.
    turnCompleteCallback?.({ type: 'result', subtype: 'success' })
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('reports authoritative turn state when a reconnected client asks to reconcile', () => {
    const runningSessionId = `sync-running-${crypto.randomUUID()}`
    const runningSocket = makeClientSocket(runningSessionId)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(runningSocket)
    __markActiveTurnForTests(runningSessionId)
    runningSocket.sent.length = 0
    handleWebSocket.message(runningSocket, JSON.stringify({ type: 'sync_state' }))

    expect(runningSocket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'running',
    })

    const idleSessionId = `sync-idle-${crypto.randomUUID()}`
    const idleSocket = makeClientSocket(idleSessionId)
    handleWebSocket.open(idleSocket)
    idleSocket.sent.length = 0
    handleWebSocket.message(idleSocket, JSON.stringify({ type: 'sync_state' }))

    expect(idleSocket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'idle',
    })
  })

  it('waits for handoff summary staging before starting the first user turn', async () => {
    const sessionId = `handoff-target-${crypto.randomUUID()}`
    const previousSessionId = `handoff-source-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    let resolveSummary!: (summary: any) => void
    const summaryPending = new Promise<any>((resolve) => {
      resolveSummary = resolve
    })

    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const startSession = spyOn(conversationService, 'startSession').mockImplementation(async () => {
      signalStarted()
    })
    __setCachedSessionSummaryReaderForTests(() => summaryPending)
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue(null)
    spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue(null)

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'set_handoff_summary',
      previousSessionId,
    }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'continue from there',
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(startSession).not.toHaveBeenCalled()

    resolveSummary({
      sessionId: previousSessionId,
      main: 'Previous work summary',
      recent: 'Ready to continue',
      baseMessageCount: 2,
      modelUsed: 'test-model',
      generatedAt: '2026-07-11T00:00:00.000Z',
    })
    await started

    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it('terminates the desktop turn when user-message handling throws unexpectedly', async () => {
    const sessionId = `user-message-failure-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(sessionService, 'getCustomTitle').mockRejectedValue(
      new Error('metadata store unavailable'),
    )

    handleWebSocket.open(ws)
    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'continue the long task',
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = ws.sent.map((payload) => JSON.parse(payload))
    expect(messages).toContainEqual({
      type: 'error',
      message: 'The request could not be started. Please retry.',
      code: 'USER_TURN_FAILED',
      retryable: true,
    })
    expect(messages).toContainEqual({ type: 'status', state: 'idle' })

    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'idle',
    })
  })

  it('rejects a second user message without releasing the active turn', async () => {
    const sessionId = `concurrent-user-message-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    let rejectFirst!: (error: Error) => void
    let customTitleCalls = 0
    spyOn(sessionService, 'getCustomTitle').mockImplementation(() => {
      customTitleCalls++
      if (customTitleCalls === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject
        })
      }
      return new Promise(() => {})
    })

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'older turn',
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(customTitleCalls).toBe(1)

    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: 'newer turn',
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(customTitleCalls).toBe(1)
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'error',
      message: 'A user turn is already active for this session. Retry after it completes.',
      code: 'SESSION_TURN_ACTIVE',
      retryable: true,
    })

    rejectFirst(new Error('older metadata request failed'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    ws.sent.length = 0
    handleWebSocket.message(ws, JSON.stringify({ type: 'sync_state' }))
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'session_state',
      turnState: 'idle',
    })
  })
})

describe('prewarm idle timer active-turn guard (issue #865 follow-up)', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  // Arm the prewarm idle timer the way markPrewarmed does, and return its fire
  // callback so a test can trigger it deterministically without waiting 5 min.
  function armPrewarmIdleTimer(sessionId: string): () => void {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (() => 0) as unknown as typeof setTimeout,
    )
    __markPrewarmedForTests(sessionId)
    const fire = setTimeoutSpy.mock.calls.at(-1)?.[0] as (() => void) | undefined
    if (!fire) throw new Error('prewarm idle timer was not armed')
    return fire
  }

  it('does not kill a prewarmed session once a user turn is registered, even before messageSent flips (CLI-startup blind window)', () => {
    const sessionId = `prewarm-blind-window-${crypto.randomUUID()}`
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const fire = armPrewarmIdleTimer(sessionId)

    // The concurrent prewarm_session/user_message race: the turn is registered
    // (activeUserTurns has it) but messageSent is still false during CLI startup
    // when the idle timer fires. The old isSessionTurnActive guard was blind to
    // this window — the turn-registered guard must catch it.
    __registerPendingUserTurnForTests(sessionId)
    fire()

    expect(stopSession).not.toHaveBeenCalled()
  })

  it('does not kill a prewarmed session with a fully active (messageSent) turn', () => {
    const sessionId = `prewarm-active-turn-${crypto.randomUUID()}`
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const fire = armPrewarmIdleTimer(sessionId)

    __markActiveTurnForTests(sessionId)
    fire()

    expect(stopSession).not.toHaveBeenCalled()
  })

  it('still reclaims a truly idle prewarmed session with no turn and no clients', () => {
    const sessionId = `prewarm-truly-idle-${crypto.randomUUID()}`
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const fire = armPrewarmIdleTimer(sessionId)

    // No registered turn and no connected client → the reaper must still fire,
    // otherwise the timer's whole purpose (reclaiming idle prewarmed CLIs) is lost.
    fire()

    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })
})
