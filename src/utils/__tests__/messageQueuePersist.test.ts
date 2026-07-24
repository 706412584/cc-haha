import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetQueueOpPersistWindowForTests,
  shouldPersistQueueOperation,
} from '../messageQueueManager.js'

describe('shouldPersistQueueOperation', () => {
  const original = process.env.CLAUDE_CODE_PERSIST_QUEUE_OPS

  beforeEach(() => {
    __resetQueueOpPersistWindowForTests()
    delete process.env.CLAUDE_CODE_PERSIST_QUEUE_OPS
  })

  afterEach(() => {
    __resetQueueOpPersistWindowForTests()
    if (original === undefined) delete process.env.CLAUDE_CODE_PERSIST_QUEUE_OPS
    else process.env.CLAUDE_CODE_PERSIST_QUEUE_OPS = original
  })

  test('defaults to off for all operations (prevents multi-GB jsonl spam)', () => {
    expect(shouldPersistQueueOperation('enqueue')).toBe(false)
    expect(shouldPersistQueueOperation('dequeue')).toBe(false)
    expect(shouldPersistQueueOperation('remove')).toBe(false)
  })

  test('never persists dequeue/remove even when debug flag is on', () => {
    process.env.CLAUDE_CODE_PERSIST_QUEUE_OPS = '1'
    expect(shouldPersistQueueOperation('dequeue')).toBe(false)
    expect(shouldPersistQueueOperation('remove')).toBe(false)
  })

  test('rate-limits enqueue when debug flag is on', () => {
    process.env.CLAUDE_CODE_PERSIST_QUEUE_OPS = 'true'
    let allowed = 0
    for (let i = 0; i < 50; i++) {
      if (shouldPersistQueueOperation('enqueue')) allowed++
    }
    expect(allowed).toBe(20)
  })
})
