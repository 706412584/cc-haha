export type StreamWatchdogAbortReason =
  | 'idle'
  | 'max_duration'
  | 'tool_input_duration'
  | 'thinking_duration'
export type StreamWatchdogErrorCode =
  | 'STREAM_IDLE_TIMEOUT'
  | 'STREAM_MAX_DURATION'
  | 'STREAM_TOOL_INPUT_DURATION'
  | 'STREAM_THINKING_DURATION'
export type StreamWatchdogPhase =
  | 'before_first_event'
  | 'before_content'
  | 'mid_stream'

export type StreamWatchdogSnapshot = {
  phase: StreamWatchdogPhase
  eventCount: number
  contentDeltaCount: number
  textDeltaCount: number
  thinkingDeltaCount: number
  toolInputDeltaCount: number
  lastEventType?: string
  lastDeltaType?: string
  lastBlockType?: string
  /** performance.now() when the most recent thinking_delta landed; undefined
   *  before any thinking has streamed. Used by isThinkingOnlyStall to spare
   *  long-but-active reasoning from the fast-fail budget. */
  lastThinkingAt?: number
  messageStopReceived: boolean
  toolUseStarted: boolean
  localToolUseStarted: boolean
  localToolUseCompleted: boolean
  serverToolUseStarted: boolean
}

type StreamEventLike = {
  type?: unknown
  index?: unknown
  content_block?: unknown
  delta?: unknown
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function hasNonEmptyStringField(
  value: Record<string, unknown>,
  field: string,
): boolean {
  const text = value[field]
  return typeof text === 'string' && text.length > 0
}

function isContentDelta(delta: Record<string, unknown>): boolean {
  switch (delta.type) {
    case 'text_delta':
      return hasNonEmptyStringField(delta, 'text')
    case 'thinking_delta':
      return hasNonEmptyStringField(delta, 'thinking')
    case 'input_json_delta':
      return hasNonEmptyStringField(delta, 'partial_json')
    case 'connector_text_delta':
      return hasNonEmptyStringField(delta, 'connector_text')
    default:
      return false
  }
}

function countContentDelta(
  snapshot: StreamWatchdogSnapshot,
  deltaType: string | undefined,
): StreamWatchdogSnapshot {
  switch (deltaType) {
    case 'text_delta':
    case 'connector_text_delta':
      return {
        ...snapshot,
        contentDeltaCount: snapshot.contentDeltaCount + 1,
        textDeltaCount: snapshot.textDeltaCount + 1,
      }
    case 'thinking_delta':
      return {
        ...snapshot,
        contentDeltaCount: snapshot.contentDeltaCount + 1,
        thinkingDeltaCount: snapshot.thinkingDeltaCount + 1,
        lastThinkingAt: performance.now(),
      }
    case 'input_json_delta':
      return {
        ...snapshot,
        contentDeltaCount: snapshot.contentDeltaCount + 1,
        toolInputDeltaCount: snapshot.toolInputDeltaCount + 1,
      }
    default:
      return snapshot
  }
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

function formatDetails(snapshot: StreamWatchdogSnapshot): string {
  const lastEvent = snapshot.lastDeltaType ?? snapshot.lastEventType ?? 'none'
  const parts = [
    `last event: ${lastEvent}`,
    `events: ${snapshot.eventCount}`,
    `content deltas: ${snapshot.contentDeltaCount}`,
  ]
  if (snapshot.lastBlockType) {
    parts.push(`last block: ${snapshot.lastBlockType}`)
  }
  return parts.join(', ')
}

function buildMessage(
  reason: StreamWatchdogAbortReason,
  timeoutMs: number,
  snapshot: StreamWatchdogSnapshot,
): string {
  const seconds = formatSeconds(timeoutMs)
  if (reason === 'max_duration') {
    return `Stream max duration exceeded - no completion received after ${seconds} (${formatDetails(snapshot)})`
  }
  if (reason === 'tool_input_duration') {
    return `Tool input generation exceeded ${seconds} - aborting incomplete tool call (${formatDetails(snapshot)})`
  }
  if (reason === 'thinking_duration') {
    return `Thinking stream exceeded ${seconds} without producing text or a tool call - aborting stalled reasoning loop (${formatDetails(snapshot)})`
  }

  switch (snapshot.phase) {
    case 'before_first_event':
      return `Stream idle timeout - no stream events received for ${seconds}`
    case 'before_content':
      return `Stream idle timeout - stream started but no content was received for ${seconds} (${formatDetails(snapshot)})`
    case 'mid_stream':
      return `Provider stream stalled after partial response - no new chunks for ${seconds} (${formatDetails(snapshot)})`
  }
}

export class StreamWatchdogTimeoutError extends Error {
  readonly code: StreamWatchdogErrorCode
  readonly phase: StreamWatchdogPhase

  constructor(
    readonly reason: StreamWatchdogAbortReason,
    readonly timeoutMs: number,
    readonly streamSnapshot: StreamWatchdogSnapshot,
  ) {
    super(buildMessage(reason, timeoutMs, streamSnapshot))
    this.name = 'StreamWatchdogTimeoutError'
    this.code = reason === 'max_duration'
      ? 'STREAM_MAX_DURATION'
      : reason === 'tool_input_duration'
        ? 'STREAM_TOOL_INPUT_DURATION'
        : reason === 'thinking_duration'
          ? 'STREAM_THINKING_DURATION'
          : 'STREAM_IDLE_TIMEOUT'
    this.phase = streamSnapshot.phase
  }

  /**
   * Only an idle stall is re-sent: max_duration and tool_input_duration
   * already spent their budget, and server-side tool work cannot be undone.
   * A completed local tool_use does not block it — the commit buffer holds
   * that block until the response completes, so the tool has not run.
   */
  safeToRetryStream(): boolean {
    return (
      this.reason === 'idle' &&
      !this.streamSnapshot.serverToolUseStarted
    )
  }

  toDiagnosticData(): Record<string, unknown> {
    return {
      reason: this.reason,
      code: this.code,
      phase: this.phase,
      timeoutMs: this.timeoutMs,
      safeToRetry: this.safeToRetryStream(),
      ...this.streamSnapshot,
    }
  }
}

class StreamWatchdogState {
  private snapshotValue: StreamWatchdogSnapshot = {
    phase: 'before_first_event',
    eventCount: 0,
    contentDeltaCount: 0,
    textDeltaCount: 0,
    thinkingDeltaCount: 0,
    toolInputDeltaCount: 0,
    messageStopReceived: false,
    toolUseStarted: false,
    localToolUseStarted: false,
    localToolUseCompleted: false,
    serverToolUseStarted: false,
  }

  private readonly blockTypesByIndex = new Map<number, string>()

  recordEvent(event: unknown): boolean {
    const beforeContentDeltaCount = this.snapshotValue.contentDeltaCount
    const rawEvent = asObject(event) as StreamEventLike | null
    const type = readString(rawEvent?.type)
    if (!type) {
      return false
    }

    this.snapshotValue = {
      ...this.snapshotValue,
      eventCount: this.snapshotValue.eventCount + 1,
      lastEventType: type,
    }

    if (type === 'message_stop') {
      this.snapshotValue = {
        ...this.snapshotValue,
        messageStopReceived: true,
      }
    }

    if (type === 'content_block_start') {
      const block = asObject(rawEvent?.content_block)
      const blockType = readString(block?.type)
      const index = readIndex(rawEvent?.index)
      if (blockType) {
        this.snapshotValue = {
          ...this.snapshotValue,
          lastBlockType: blockType,
          toolUseStarted:
            this.snapshotValue.toolUseStarted ||
            blockType === 'tool_use' ||
            blockType === 'server_tool_use',
          localToolUseStarted:
            this.snapshotValue.localToolUseStarted || blockType === 'tool_use',
          serverToolUseStarted:
            this.snapshotValue.serverToolUseStarted || blockType === 'server_tool_use',
        }
        if (index !== undefined) {
          this.blockTypesByIndex.set(index, blockType)
        }
      }
    }

    if (type === 'content_block_stop') {
      const index = readIndex(rawEvent?.index)
      const blockType = index === undefined
        ? undefined
        : this.blockTypesByIndex.get(index)
      if (blockType === 'tool_use') {
        this.snapshotValue = {
          ...this.snapshotValue,
          localToolUseCompleted: true,
          lastBlockType: blockType,
        }
      }
      if (index !== undefined) {
        this.blockTypesByIndex.delete(index)
      }
    }

    if (type === 'content_block_delta') {
      const delta = asObject(rawEvent?.delta)
      const deltaType = readString(delta?.type)
      const index = readIndex(rawEvent?.index)
      const blockType = index === undefined
        ? undefined
        : this.blockTypesByIndex.get(index)
      this.snapshotValue = {
        ...this.snapshotValue,
        ...(deltaType ? { lastDeltaType: deltaType } : {}),
        ...(blockType ? { lastBlockType: blockType } : {}),
      }
      if (delta && isContentDelta(delta)) {
        this.snapshotValue = countContentDelta(this.snapshotValue, deltaType)
      }
    }

    this.snapshotValue = {
      ...this.snapshotValue,
      phase: this.snapshotValue.contentDeltaCount > 0
        ? 'mid_stream'
        : 'before_content',
    }

    return (
      beforeContentDeltaCount === 0 &&
      this.snapshotValue.contentDeltaCount > 0
    )
  }

  hasContentDelta(): boolean {
    return this.snapshotValue.contentDeltaCount > 0
  }

  /**
   * True when the stream has entered reasoning but produced not a single byte
   * of user-visible text or tool input, and never reached message_stop.
   *
   * This is the shape of a stalled reasoning loop: some OpenAI-compatible
   * relays keep emitting thinking chunks forever (256k+ deltas observed) and
   * never send finish_reason, so the idle watchdog is reset on every chunk and
   * can never fire. Requiring zero text AND zero tool input keeps the guard
   * from ever touching a legitimate long think that goes on to answer.
   *
   * "Entered reasoning" must accept both delta and non-delta shapes: an
   * OpenAI-compatible gateway may open a `thinking` block and then only send
   * `signature_delta` events, or open a `redacted_thinking` block outright
   * (openaiResponsesStreamToAnthropic.ts), neither of which increments
   * thinkingDeltaCount. Keying only on the delta count would leave those
   * streams protected by the 600s cap alone — the exact stall this fixes.
   *
   * A stream whose most recent thinking_delta is still fresh is NOT a stall:
   * reasoning models on `max` effort think for many minutes before writing
   * their first user-visible token. We only call it stalled when the most
   * recent thinking event is itself older than the fast-fail budget, so a
   * healthy long think that is actively producing new content is never cut
   * off — even if that thinking happens to repeat or circle.
   */
  /**
   * Milliseconds until the most recent thinking event becomes "quiet" — i.e.
   * until we should consider the stream stalled. Returns 0 if the quiet
   * window has already elapsed, or Infinity if no thinking has streamed yet.
   * Callers use this to re-arm the watchdog timer so the next wake-up is
   * guaranteed to land at or past the quiet window, instead of skipping the
   * stall check entirely when it lands early.
   */
  msUntilThinkingQuietWindow(quietWindowMs: number): number {
    const last = this.snapshotValue.lastThinkingAt
    if (last === undefined) return 0
    const elapsed = performance.now() - last
    return Math.max(0, quietWindowMs - elapsed)
  }

  isThinkingOnlyStall(quietWindowMs = 0): boolean {
    const snapshot = this.snapshotValue
    const enteredReasoning =
      snapshot.thinkingDeltaCount > 0 ||
      snapshot.lastBlockType === 'thinking' ||
      snapshot.lastBlockType === 'redacted_thinking'
    if (!enteredReasoning) return false
    if (snapshot.textDeltaCount > 0) return false
    if (snapshot.toolInputDeltaCount > 0) return false
    if (snapshot.toolUseStarted) return false
    if (snapshot.messageStopReceived) return false
    if (snapshot.lastThinkingAt !== undefined && quietWindowMs > 0) {
      // Most recent thinking event is still inside the quiet window — the
      // stream is actively thinking, not stalled.
      if (performance.now() - snapshot.lastThinkingAt < quietWindowMs) {
        return false
      }
    }
    return true
  }

  snapshot(): StreamWatchdogSnapshot {
    return { ...this.snapshotValue }
  }

  createTimeoutError(
    reason: StreamWatchdogAbortReason,
    timeoutMs: number,
  ): StreamWatchdogTimeoutError {
    return new StreamWatchdogTimeoutError(reason, timeoutMs, this.snapshot())
  }
}

export function createStreamWatchdogState(): StreamWatchdogState {
  return new StreamWatchdogState()
}
