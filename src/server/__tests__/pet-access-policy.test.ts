import { describe, expect, test } from 'bun:test'
import {
  getPetScopedSessionId,
  isPetClientMessageAllowed,
  isPetHttpRequestAllowed,
  isPetSessionInProjection,
  toPetServerMessage,
} from '../petAccessPolicy.js'

function request(pathname: string, method = 'GET', headers?: HeadersInit) {
  const url = new URL(pathname, 'http://127.0.0.1:3456')
  return {
    url,
    request: new Request(url, { method, headers }),
  }
}

describe('pet access capability policy', () => {
  test('allows only bounded companion REST routes', () => {
    for (const [method, pathname] of [
      ['GET', '/health'],
      ['GET', '/api/desktop-ui/preferences/pet'],
      ['PUT', '/api/desktop-ui/preferences/pet'],
      ['GET', '/api/sessions?limit=400'],
      ['GET', '/api/sessions/session-123/chat/status'],
      ['GET', '/ws/session-123'],
    ]) {
      const candidate = request(pathname, method)
      expect(isPetHttpRequestAllowed(candidate.request, candidate.url)).toBe(true)
    }

    for (const [method, pathname] of [
      ['GET', '/api/providers'],
      ['GET', '/api/desktop-ui/preferences'],
      ['GET', '/api/filesystem'],
      ['GET', '/api/computer-use/authorized-apps'],
      ['GET', '/api/settings/user'],
      ['POST', '/api/doctor/repair'],
      ['GET', '/api/sessions/session-123/messages'],
      ['GET', '/api/sessions/session-123/slash-commands'],
      ['GET', '/api/tasks/lists/session-123'],
      ['GET', '/preview-fs/session-123/index.html'],
      ['GET', '/local-file/tmp/private.txt'],
      ['POST', '/proxy/v1/messages'],
    ]) {
      const candidate = request(pathname, method)
      expect(isPetHttpRequestAllowed(candidate.request, candidate.url)).toBe(false)
    }
  })

  test('allows preflight only when its eventual API method is allowed', () => {
    const allowed = request('/api/desktop-ui/preferences/pet', 'OPTIONS', {
      'Access-Control-Request-Method': 'PUT',
    })
    const denied = request('/api/settings/user', 'OPTIONS', {
      'Access-Control-Request-Method': 'GET',
    })

    expect(isPetHttpRequestAllowed(allowed.request, allowed.url)).toBe(true)
    expect(isPetHttpRequestAllowed(denied.request, denied.url)).toBe(false)
  })

  test('accepts follow-up, stop, reconnect sync, and heartbeat without attachments', () => {
    expect(isPetClientMessageAllowed({ type: 'user_message', content: 'Follow up' })).toBe(true)
    expect(isPetClientMessageAllowed({ type: 'user_message', content: '  /clear' })).toBe(false)
    expect(isPetClientMessageAllowed({ type: 'user_message', content: '/model private' })).toBe(false)
    expect(isPetClientMessageAllowed({ type: 'user_message', content: 'Explain /clear safely' })).toBe(true)
    expect(isPetClientMessageAllowed({ type: 'stop_generation' })).toBe(true)
    expect(isPetClientMessageAllowed({ type: 'sync_state' })).toBe(true)
    expect(isPetClientMessageAllowed({ type: 'ping' })).toBe(true)

    expect(isPetClientMessageAllowed({
      type: 'user_message',
      content: 'Read this file',
      attachments: [{ type: 'file', path: '/tmp/private' }],
    })).toBe(false)
    expect(isPetClientMessageAllowed({ type: 'permission_response', requestId: 'p1', allowed: true })).toBe(false)
    expect(isPetClientMessageAllowed({ type: 'computer_use_permission_response' })).toBe(false)
    expect(isPetClientMessageAllowed({ type: 'set_permission_mode', mode: 'bypassPermissions' })).toBe(false)
    expect(isPetClientMessageAllowed({ type: 'set_runtime_config', providerId: 'private', modelId: 'secret' })).toBe(false)
    expect(isPetClientMessageAllowed({ type: 'prewarm_session' })).toBe(false)
    expect(isPetClientMessageAllowed({ type: 'stop_background_task', taskId: 'task-1' })).toBe(false)
  })

  test('extracts only pet-scoped session routes and checks the bounded projection', () => {
    expect(getPetScopedSessionId('/ws/session-123')).toBe('session-123')
    expect(getPetScopedSessionId('/api/sessions/session-123/chat/status')).toBe('session-123')
    expect(getPetScopedSessionId('/api/sessions')).toBeNull()
    expect(isPetSessionInProjection('session-123', [{ id: 'session-123' }])).toBe(true)
    expect(isPetSessionInProjection('session-hidden', [{ id: 'session-123' }])).toBe(false)
  })

  test('filters sensitive server events and redacts bounded state messages', () => {
    expect(toPetServerMessage({
      type: 'permission_request',
      requestId: 'p1',
      toolName: 'Read',
      input: { file_path: '/tmp/private' },
    })).toBeNull()
    expect(toPetServerMessage({
      type: 'computer_use_permission_request',
      requestId: 'cu1',
      request: {
        requestId: 'cu1',
        reason: 'Inspect password manager',
        apps: [],
        requestedFlags: {},
        screenshotFiltering: 'native',
      },
    })).toBeNull()
    expect(toPetServerMessage({ type: 'content_delta', text: 'private transcript' })).toBeNull()
    expect(toPetServerMessage({
      type: 'permission_requests_snapshot',
      toolRequestIds: ['p1'],
      computerUseRequestIds: ['cu1'],
      turnActive: true,
    })).toEqual({
      type: 'permission_requests_snapshot',
      toolRequestIds: [],
      computerUseRequestIds: [],
      turnActive: true,
    })
    expect(toPetServerMessage({
      type: 'error',
      message: 'Bearer secret failed at /Users/alice/private',
      code: 'CLI_ERROR',
    })).toEqual({
      type: 'error',
      message: 'Pet action failed. Open the session for details.',
      code: 'CLI_ERROR',
    })
    expect(toPetServerMessage({
      type: 'message_complete',
      usage: { input_tokens: 999, output_tokens: 888 },
    })).toEqual({
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(toPetServerMessage({
      type: 'status',
      state: 'tool_executing',
      verb: 'Reading /Users/alice/private.txt',
      attemptStart: true,
    })).toEqual({
      type: 'status',
      state: 'tool_executing',
    })
  })
})
