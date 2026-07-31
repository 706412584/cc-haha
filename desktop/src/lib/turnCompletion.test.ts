import { describe, expect, it } from 'vitest'
import { buildTurnCompletionByMessageId } from './turnCompletion'
import type { UIMessage } from '../types/chat'

const T0 = new Date('2026-07-30T15:08:22Z').getTime()
const SECOND = 1000
const MINUTE = 60 * SECOND

function user(id: string, offsetMs: number, extra: Partial<UIMessage> = {}): UIMessage {
  return { id, type: 'user_text', content: `prompt ${id}`, timestamp: T0 + offsetMs, ...extra } as UIMessage
}

function assistant(id: string, offsetMs: number): UIMessage {
  return { id, type: 'assistant_text', content: `reply ${id}`, timestamp: T0 + offsetMs }
}

function toolResult(id: string, offsetMs: number): UIMessage {
  return { id, type: 'tool_result', toolUseId: `${id}-use`, content: 'ok', isError: false, timestamp: T0 + offsetMs }
}

describe('buildTurnCompletionByMessageId', () => {
  it('marks the last assistant reply of a finished turn with its end time and duration', () => {
    const completions = buildTurnCompletionByMessageId([
      user('u1', 0),
      assistant('a1', 12 * MINUTE + 19 * SECOND),
    ])

    expect(completions.get('a1')).toEqual({
      completedAt: T0 + 12 * MINUTE + 19 * SECOND,
      durationMs: 12 * MINUTE + 19 * SECOND,
    })
  })

  it('only marks the closing reply of a turn, not the ones before a tool call', () => {
    const completions = buildTurnCompletionByMessageId([
      user('u1', 0),
      assistant('a1', 5 * SECOND),
      toolResult('r1', 20 * SECOND),
      assistant('a2', 30 * SECOND),
    ])

    expect(completions.has('a1')).toBe(false)
    expect(completions.get('a2')?.completedAt).toBe(T0 + 30 * SECOND)
  })

  it('leaves a turn that ran tools after its last reply unmarked', () => {
    // The stamp renders under the reply, so a turn whose last reply is a
    // mid-turn aside ("now wiring it up:") would print "done" above the work
    // that followed it.
    const completions = buildTurnCompletionByMessageId([
      user('u1', 0),
      assistant('a1', 10 * SECOND),
      toolResult('r1', 45 * SECOND),
    ])

    expect(completions.size).toBe(0)
  })

  it('still closes the turn when only trailing cards follow the last reply', () => {
    // The task summary is written on the NEXT send and the background task card
    // is detached work: neither means the answer was still coming.
    const completions = buildTurnCompletionByMessageId([
      user('u1', 0),
      assistant('a1', 40 * SECOND),
      { id: 's1', type: 'task_summary', tasks: [], timestamp: T0 + 2 * MINUTE },
    ])

    expect(completions.get('a1')).toEqual({
      completedAt: T0 + 40 * SECOND,
      durationMs: 40 * SECOND,
    })
  })

  it('measures each turn from its own prompt', () => {
    const completions = buildTurnCompletionByMessageId([
      user('u1', 0),
      assistant('a1', 30 * SECOND),
      user('u2', 5 * MINUTE),
      assistant('a2', 6 * MINUTE),
    ])

    expect(completions.get('a1')?.durationMs).toBe(30 * SECOND)
    expect(completions.get('a2')?.durationMs).toBe(MINUTE)
  })

  it('leaves the running turn unmarked and still marks the finished ones', () => {
    const messages = [
      user('u1', 0),
      assistant('a1', 30 * SECOND),
      user('u2', MINUTE),
      assistant('a2', 90 * SECOND),
    ]

    const running = buildTurnCompletionByMessageId(messages, { turnActive: true })
    expect(running.has('a2')).toBe(false)
    expect(running.has('a1')).toBe(true)

    const idle = buildTurnCompletionByMessageId(messages, { turnActive: false })
    expect(idle.has('a2')).toBe(true)
  })

  it('does not let a queued prompt close the turn that is still running', () => {
    // The optimistic bubble for a queued prompt lands in the transcript while
    // the previous turn is still streaming. Treating it as a turn boundary
    // would stamp "done" on a turn that has not finished.
    const completions = buildTurnCompletionByMessageId(
      [
        user('u1', 0),
        assistant('a1', 30 * SECOND),
        user('u2', 40 * SECOND, { optimisticQueued: true }),
      ],
      { turnActive: true },
    )

    expect(completions.has('a1')).toBe(false)
  })

  it('ignores pending teammate prompts as turn boundaries', () => {
    const completions = buildTurnCompletionByMessageId(
      [
        user('u1', 0),
        assistant('a1', 30 * SECOND),
        user('u2', 40 * SECOND, { pending: true }),
      ],
      { turnActive: true },
    )

    expect(completions.has('a1')).toBe(false)
  })

  it('skips turns that produced no assistant text', () => {
    const completions = buildTurnCompletionByMessageId([
      user('u1', 0),
      toolResult('r1', 10 * SECOND),
      user('u2', 20 * SECOND),
      assistant('a1', 25 * SECOND),
    ])

    expect(completions.size).toBe(1)
    expect(completions.has('a1')).toBe(true)
  })

  it('ignores replies that precede the first prompt', () => {
    const completions = buildTurnCompletionByMessageId([
      assistant('a0', 0),
      user('u1', SECOND),
      assistant('a1', 2 * SECOND),
    ])

    expect(completions.has('a0')).toBe(false)
    expect(completions.has('a1')).toBe(true)
  })

  it('keeps the end time but drops an implausible duration', () => {
    // A turn spanning days is a session that was interrupted and resumed, not a
    // model that thought for two days.
    const completions = buildTurnCompletionByMessageId([
      user('u1', 0),
      assistant('a1', 50 * 60 * 60 * 1000),
    ])

    expect(completions.get('a1')?.completedAt).toBe(T0 + 50 * 60 * 60 * 1000)
    expect(completions.get('a1')?.durationMs).toBeUndefined()
  })

  it('clamps an out-of-order reply to the prompt time instead of going negative', () => {
    const completions = buildTurnCompletionByMessageId([
      { id: 'u1', type: 'user_text', content: 'prompt', timestamp: T0 },
      { id: 'a1', type: 'assistant_text', content: 'reply', timestamp: T0 - MINUTE },
    ])

    expect(completions.get('a1')?.completedAt).toBe(T0)
    expect(completions.get('a1')?.durationMs).toBe(0)
  })

  it('produces nothing when timestamps are unusable', () => {
    const completions = buildTurnCompletionByMessageId([
      { id: 'u1', type: 'user_text', content: 'prompt', timestamp: Number.NaN },
      { id: 'a1', type: 'assistant_text', content: 'reply', timestamp: Number.NaN },
    ])

    expect(completions.size).toBe(0)
  })
})
