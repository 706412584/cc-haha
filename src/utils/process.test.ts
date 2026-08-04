import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  flushProcessOutput,
  getProcessOutputDrainTimeoutMs,
  writeToStdout,
} from './process.js'

afterEach(async () => {
  mock.restore()
  await flushProcessOutput()
})

describe('process output draining', () => {
  test.serial('waits for a backpressured write callback before reporting flushed', async () => {
    let writeCallback: ((error?: Error | null) => void) | undefined
    spyOn(process.stdout, 'write').mockImplementation(((_data, callback) => {
      writeCallback = callback as (error?: Error | null) => void
      return false
    }) as typeof process.stdout.write)

    writeToStdout('final stream-json result\n')
    let flushed = false
    const flush = flushProcessOutput().then(() => {
      flushed = true
    })

    writeCallback?.()
    await Promise.resolve()
    expect(flushed).toBe(false)

    process.stdout.emit('drain')
    await flush
    expect(flushed).toBe(true)
  })

  test.serial('scales the bounded drain budget with queued bytes', () => {
    const callbacks: Array<(error?: Error | null) => void> = []
    spyOn(process.stdout, 'write').mockImplementation(((_data, callback) => {
      callbacks.push(callback as (error?: Error | null) => void)
      return false
    }) as typeof process.stdout.write)

    writeToStdout('small')
    const smallBudget = getProcessOutputDrainTimeoutMs()
    writeToStdout('x'.repeat(4 * 1024 * 1024))
    const largeBudget = getProcessOutputDrainTimeoutMs()
    writeToStdout('x'.repeat(16 * 1024 * 1024))
    const cappedBudget = getProcessOutputDrainTimeoutMs()

    for (const callback of callbacks) callback()
    process.stdout.emit('drain')

    expect(smallBudget).toBeGreaterThanOrEqual(2000)
    expect(largeBudget).toBeGreaterThan(smallBudget)
    expect(cappedBudget).toBe(30_000)
  })

  test.serial('treats a broken stdout pipe as flushed', async () => {
    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    let writeCount = 0
    spyOn(process.stdout, 'destroy').mockImplementation(() => process.stdout)
    spyOn(process.stdout, 'write').mockImplementation(((_data, _callback) => {
      writeCount += 1
      if (writeCount === 1) return false
      throw brokenPipe
    }) as typeof process.stdout.write)

    writeToStdout('already queued')
    expect(() => writeToStdout('tail')).not.toThrow()
    await expect(flushProcessOutput()).resolves.toBeUndefined()
    expect(process.stdout.destroy).toHaveBeenCalled()
  })

  test.serial('settles all queued writes when stdout reports EPIPE through its callback', async () => {
    const callbacks: Array<(error?: Error | null) => void> = []
    spyOn(process.stdout, 'destroy').mockImplementation(() => process.stdout)
    spyOn(process.stdout, 'write').mockImplementation(((_data, callback) => {
      callbacks.push(callback as (error?: Error | null) => void)
      return false
    }) as typeof process.stdout.write)

    writeToStdout('first queued write')
    writeToStdout('second queued write')
    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    callbacks[0]?.(brokenPipe)

    await expect(flushProcessOutput()).resolves.toBeUndefined()
    expect(process.stdout.destroy).toHaveBeenCalled()
  })
})
