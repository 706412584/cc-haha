import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installStdioWriteFailureGuards } from './stdioGuards'

const makeStream = () => new EventEmitter()

describe('Electron stdio write failure guards', () => {
  it('keeps an EPIPE write failure from escalating to an uncaught exception', () => {
    const stdout = makeStream()
    installStdioWriteFailureGuards([stdout])

    const epipe: NodeJS.ErrnoException = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
    })

    // Without a listener, EventEmitter rethrows 'error' — exactly how Node
    // turns a failed console.log into the Electron crash dialog.
    expect(() => stdout.emit('error', epipe)).not.toThrow()
  })

  it('guards stderr as well as stdout', () => {
    const stdout = makeStream()
    const stderr = makeStream()

    expect(installStdioWriteFailureGuards([stdout, stderr])).toBe(2)
    expect(() => stderr.emit('error', new Error('write EPIPE'))).not.toThrow()
  })

  it('does not stack duplicate listeners when installed twice', () => {
    const stdout = makeStream()

    expect(installStdioWriteFailureGuards([stdout])).toBe(1)
    expect(installStdioWriteFailureGuards([stdout])).toBe(0)
    expect(stdout.listenerCount('error')).toBe(1)
  })

  it('defaults to the real process stdio streams', () => {
    // Idempotent by design, so calling it here cannot disturb the test runner's
    // own streams beyond the single no-op listener the app installs at startup.
    expect(installStdioWriteFailureGuards()).toBeGreaterThanOrEqual(0)
    expect(process.stdout.listenerCount('error')).toBeGreaterThan(0)
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0)
  })
})
