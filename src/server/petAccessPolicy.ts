import type { ClientMessage, ServerMessage } from './ws/events.js'

const SESSION_ID_PATTERN = '[0-9a-zA-Z_-]{1,64}'
const MAX_PET_FOLLOW_UP_LENGTH = 32_768
export const PET_SESSION_LIMIT = 9
const PET_SESSION_STATUS_PATTERN = new RegExp(
  `^/api/sessions/(${SESSION_ID_PATTERN})/chat/status$`,
)
const PET_SESSION_WEBSOCKET_PATTERN = new RegExp(`^/ws/(${SESSION_ID_PATTERN})$`)

function isAllowedApiPath(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/api/desktop-ui/preferences/pet') return true
  if (method === 'PUT' && pathname === '/api/desktop-ui/preferences/pet') return true
  if (method === 'GET' && pathname === '/api/sessions') return true
  return method === 'GET' && PET_SESSION_STATUS_PATTERN.test(pathname)
}

/**
 * A pet token is intentionally narrower than the desktop local-access token.
 * It can bootstrap the companion, read the bounded session projection, and
 * update only pet-owned preferences. Everything else fails closed.
 */
export function isPetHttpRequestAllowed(request: Request, url: URL): boolean {
  if (request.method === 'GET' && url.pathname === '/health') return true
  if (request.method === 'GET' && PET_SESSION_WEBSOCKET_PATTERN.test(url.pathname)) {
    return true
  }
  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers.get('Access-Control-Request-Method')?.toUpperCase()
    return requestedMethod ? isAllowedApiPath(requestedMethod, url.pathname) : false
  }
  return isAllowedApiPath(request.method, url.pathname)
}

export function getPetScopedSessionId(pathname: string): string | null {
  return PET_SESSION_WEBSOCKET_PATTERN.exec(pathname)?.[1]
    ?? PET_SESSION_STATUS_PATTERN.exec(pathname)?.[1]
    ?? null
}

export function isPetSessionInProjection(
  sessionId: string,
  sessions: readonly { id: string }[],
): boolean {
  return sessions.some((session) => session.id === sessionId)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).every(key => expected.has(key)) &&
    keys.every(key => Object.hasOwn(value, key))
}

export function isPetClientMessageAllowed(message: unknown): message is ClientMessage {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false
  const record = message as Record<string, unknown>

  switch (record.type) {
    case 'user_message':
      return typeof record.content === 'string' &&
        record.content.trim().length > 0 &&
        !record.content.trimStart().startsWith('/') &&
        record.content.length <= MAX_PET_FOLLOW_UP_LENGTH &&
        hasOnlyKeys(record, ['type', 'content'])
    case 'sync_state':
    case 'stop_generation':
    case 'ping':
      return hasOnlyKeys(record, ['type'])
    default:
      return false
  }
}

const PET_SERVER_MESSAGE_TYPES = new Set<ServerMessage['type']>([
  'connected',
  'session_state',
  'permission_requests_snapshot',
  'status',
  'error',
  'message_complete',
  'pong',
])

export function toPetServerMessage(message: ServerMessage): ServerMessage | null {
  if (!PET_SERVER_MESSAGE_TYPES.has(message.type)) return null

  if (message.type === 'permission_requests_snapshot') {
    return {
      ...message,
      toolRequestIds: [],
      computerUseRequestIds: [],
    }
  }
  if (message.type === 'error') {
    return {
      type: 'error',
      message: 'Pet action failed. Open the session for details.',
      code: message.code,
      ...(message.retryable !== undefined ? { retryable: message.retryable } : {}),
      ...(message.businessErrorCode !== undefined
        ? { businessErrorCode: message.businessErrorCode }
        : {}),
    }
  }
  if (message.type === 'message_complete') {
    return {
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  }
  if (message.type === 'status') {
    return {
      type: 'status',
      state: message.state,
    }
  }
  return message
}
