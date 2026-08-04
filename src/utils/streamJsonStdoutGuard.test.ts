import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetStreamJsonStdoutGuardForTesting,
  installStreamJsonStdoutGuard,
} from './streamJsonStdoutGuard.js'

type WriteCallback = (error?: Error | null) => void

let savedStdoutWrite: typeof process.stdout.write
let savedStderrWrite: typeof process.stderr.write

beforeEach(() => {
  _resetStreamJsonStdoutGuardForTesting()
  savedStdoutWrite = process.stdout.write
  savedStderrWrite = process.stderr.write
})

afterEach(() => {
  _resetStreamJsonStdoutGuardForTesting()
  process.stdout.write = savedStdoutWrite
  process.stderr.write = savedStderrWrite
})

describe('stream-json stdout write callbacks', () => {
  test.serial('waits for the original write callback even when write returns true', async () => {
    let downstreamCallback: WriteCallback | undefined
    process.stdout.write = ((_chunk, encodingOrCallback, callback) => {
      downstreamCallback =
        typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : callback
      return true
    }) as typeof process.stdout.write
    installStreamJsonStdoutGuard()

    let callbackCalls = 0
    const accepted = process.stdout.write('{"type":"result"}\n', error => {
      expect(error).toBeUndefined()
      callbackCalls += 1
    })

    expect(accepted).toBe(true)
    await Promise.resolve()
    expect(callbackCalls).toBe(0)
    expect(downstreamCallback).toBeFunction()

    downstreamCallback?.()
    expect(callbackCalls).toBe(1)
  })

  test.serial('attaches the callback only to the final forwarded line and preserves false', () => {
    const downstreamCallbacks: Array<WriteCallback | undefined> = []
    process.stdout.write = ((_chunk, encodingOrCallback, callback) => {
      downstreamCallbacks.push(
        typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : callback,
      )
      return false
    }) as typeof process.stdout.write
    installStreamJsonStdoutGuard()

    const callbackErrors: Array<Error | null | undefined> = []
    const accepted = process.stdout.write(
      '{"type":"first"}\n{"type":"second"}\n',
      error => callbackErrors.push(error),
    )

    expect(accepted).toBe(false)
    expect(downstreamCallbacks).toHaveLength(2)
    expect(downstreamCallbacks[0]).toBeUndefined()
    expect(downstreamCallbacks[1]).toBeFunction()

    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    downstreamCallbacks[1]?.(brokenPipe)
    expect(callbackErrors).toEqual([brokenPipe])
  })

  test.serial('preserves the string encoding overload on the callback-owning write', () => {
    let receivedEncoding: BufferEncoding | undefined
    let downstreamCallback: WriteCallback | undefined
    process.stdout.write = ((_chunk, encodingOrCallback, callback) => {
      receivedEncoding = encodingOrCallback as BufferEncoding
      downstreamCallback = callback
      return true
    }) as typeof process.stdout.write
    installStreamJsonStdoutGuard()

    let callbackCalls = 0
    const accepted = process.stdout.write(
      '{"type":"result"}\n',
      'utf8',
      () => {
        callbackCalls += 1
      },
    )

    expect(accepted).toBe(true)
    expect(receivedEncoding).toBe('utf8')
    expect(downstreamCallback).toBeFunction()
    downstreamCallback?.()
    expect(callbackCalls).toBe(1)
  })

  test.serial('completes a fully diverted write once without touching stdout', async () => {
    let stdoutCalls = 0
    process.stdout.write = (() => {
      stdoutCalls += 1
      return true
    }) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    installStreamJsonStdoutGuard()

    let callbackCalls = 0
    const accepted = process.stdout.write('not json\n', () => {
      callbackCalls += 1
    })

    expect(accepted).toBe(true)
    expect(stdoutCalls).toBe(0)
    expect(callbackCalls).toBe(0)
    await Promise.resolve()
    expect(callbackCalls).toBe(1)
  })
})
