import { describe, it, expect } from 'vitest'

import { errorCountFromDiagnostics, toLegacyLspState } from './lspStateMap'
import type { LspDiagnostic, WorkspaceLspState } from '../types/lsp'

describe('toLegacyLspState', () => {
  it('returns starting when state is undefined (never loaded)', () => {
    const result = toLegacyLspState(undefined, 0, 'w1')
    expect(result).toEqual({ state: 'starting', workspaceId: 'w1', errorCount: 0 })
  })

  it('treats idle as starting so the pill does not flash unavailable', () => {
    const idle: WorkspaceLspState = { state: 'idle', path: null, serverName: null, command: null }
    expect(toLegacyLspState(idle, 0, 'w1')).toEqual({
      state: 'starting',
      workspaceId: 'w1',
      errorCount: 0,
    })
  })

  it('passes through starting', () => {
    const starting: WorkspaceLspState = { state: 'starting', path: null, serverName: null, command: null }
    expect(toLegacyLspState(starting, 0, 'w1')).toEqual({
      state: 'starting',
      workspaceId: 'w1',
      errorCount: 0,
    })
  })

  it('passes through ready and threads errorCount', () => {
    const ready: WorkspaceLspState = {
      state: 'ready',
      path: 'src/app.ts',
      serverName: 'typescript',
      command: 'typescript-language-server',
    }
    expect(toLegacyLspState(ready, 3, 'w1')).toEqual({
      state: 'ready',
      workspaceId: 'w1',
      errorCount: 3,
    })
  })

  it('preserves a lifecycle failure reason and sanitized detail', () => {
    const unavailable: WorkspaceLspState = {
      state: 'unavailable',
      path: null,
      serverName: null,
      command: null,
      reason: 'spawn-failed',
      error: 'Unable to launch typescript-language-server',
    }
    expect(toLegacyLspState(unavailable, 0, 'w1')).toEqual({
      state: 'unavailable',
      workspaceId: 'w1',
      reason: 'spawn-failed',
      errorCount: 0,
      lastStderrTail: 'Unable to launch typescript-language-server',
    })
  })

  it('preserves unsupported-extension without inventing retry detail', () => {
    const unavailable: WorkspaceLspState = {
      state: 'unavailable',
      path: null,
      serverName: null,
      command: null,
      reason: 'unsupported-extension',
    }
    const result = toLegacyLspState(unavailable, 0, 'w1')
    expect(result).toEqual({
      state: 'unavailable',
      workspaceId: 'w1',
      reason: 'unsupported-extension',
      errorCount: 0,
    })
  })
})

describe('errorCountFromDiagnostics', () => {
  function diag(severity: LspDiagnostic['severity']): LspDiagnostic {
    return { path: 'a.ts', line: 1, column: 1, severity, message: 'm' }
  }

  it('returns 0 when undefined or empty', () => {
    expect(errorCountFromDiagnostics(undefined)).toBe(0)
    expect(errorCountFromDiagnostics([])).toBe(0)
  })

  it('counts only error severity, not warning/info/hint', () => {
    expect(
      errorCountFromDiagnostics([
        diag('error'),
        diag('warning'),
        diag('error'),
        diag('info'),
        diag('hint'),
      ]),
    ).toBe(2)
  })
})
