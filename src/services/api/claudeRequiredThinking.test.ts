import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enableConfigs } from '../../utils/config.js'
import { queryWithModel } from './claude.js'

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function thinkingSummaryResponse(parts: string[]): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_thinking_summary',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.6-sol',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    ...parts.map((thinking) => sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking },
    })),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'OK' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function upstreamErrorResponse(): string {
  return sseEvent('error', {
    error: {
      message: 'Upstream service temporarily unavailable',
      type: 'upstream_error',
    },
    type: 'error',
  })
}

function partialServerToolResponse(): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_partial_server_tool',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.6-sol',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'server_tool_use',
        id: 'srvtool_1',
        name: 'web_search',
        input: {},
      },
    }),
  ].join('')
}

function successfulResponse(): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_required_thinking',
        type: 'message',
        role: 'assistant',
        model: 'kimi-k2.7-code',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OK' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

const ENV_KEYS = [
  'NODE_ENV',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_THINKING',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_STREAM_TRANSIENT_RETRY_MAX',
] as const

test.serial('accumulates every streamed thinking summary delta', async () => {
  const summaryParts = Array.from(
    { length: 47 },
    (_, index) => `summary-${String(index + 1).padStart(2, '0')} `,
  )
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(thinkingSummaryResponse(summaryParts), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-thinking-summary-'))
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
  const originalMacro = globals.MACRO

  try {
    globals.MACRO = { BUILD_TIME: '' }
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_DISABLE_THINKING
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'loopback-test-key'
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-sol'
    process.env.ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,max_effort'
    enableConfigs()

    const result = await queryWithModel({
      userPrompt: 'Reply exactly OK',
      signal: new AbortController().signal,
      options: {
        model: 'gpt-5.6-sol',
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'max',
      },
    })

    expect(result.message.content).toEqual([
      { type: 'thinking', thinking: summaryParts.join(''), signature: '' },
      { type: 'text', text: 'OK' },
    ])
    expect(result.message.stop_reason).toBe('end_turn')
    expect(result.message.usage.output_tokens).toBe(1)
  } finally {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (originalMacro === undefined) delete globals.MACRO
    else globals.MACRO = originalMacro
    server.stop(true)
    await rm(configDir, { recursive: true, force: true })
  }
}, 10_000)

async function runStreamRecoveryScenario(
  name: string,
  responseForRequest: (requestCount: number) => string,
  options: { disableNonStreamingFallback?: boolean } = {},
) {
  let requestCount = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requestCount += 1
      return new Response(responseForRequest(requestCount), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const configDir = await mkdtemp(join(tmpdir(), `cc-haha-${name}-`))
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
  const originalMacro = globals.MACRO

  try {
    globals.MACRO = { BUILD_TIME: '' }
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_DISABLE_THINKING
    if (options.disableNonStreamingFallback === false) {
      delete process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK
    } else {
      process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
    }
    process.env.CLAUDE_STREAM_TRANSIENT_RETRY_MAX = '1'
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'loopback-test-key'
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-sol'
    process.env.ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,max_effort'
    enableConfigs()

    const result = await queryWithModel({
      userPrompt: 'Reply exactly OK',
      signal: new AbortController().signal,
      options: {
        model: 'gpt-5.6-sol',
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'max',
      },
    })

    return { requestCount, result }
  } finally {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (originalMacro === undefined) delete globals.MACRO
    else globals.MACRO = originalMacro
    server.stop(true)
    await rm(configDir, { recursive: true, force: true })
  }
}

test.serial('retries an upstream_error through the real query path', async () => {
  const { requestCount, result } = await runStreamRecoveryScenario(
    'upstream-error-retry',
    (attempt) => attempt === 1 ? upstreamErrorResponse() : successfulResponse(),
  )

  expect(requestCount).toBe(2)
  expect(result.message.content).toEqual([{ type: 'text', text: 'OK' }])
  expect(result.isApiErrorMessage).not.toBe(true)
}, 10_000)

test.serial('retries an empty SSE stream even when non-streaming fallback is disabled', async () => {
  const { requestCount, result } = await runStreamRecoveryScenario(
    'empty-stream-retry',
    (attempt) => attempt === 1 ? '' : successfulResponse(),
  )

  expect(requestCount).toBe(2)
  expect(result.message.content).toEqual([{ type: 'text', text: 'OK' }])
  expect(result.isApiErrorMessage).not.toBe(true)
}, 10_000)

test.serial('surfaces one error after the empty-stream retry is exhausted', async () => {
  const { requestCount, result } = await runStreamRecoveryScenario(
    'empty-stream-exhausted',
    () => '',
  )

  expect(requestCount).toBe(2)
  expect(result.isApiErrorMessage).toBe(true)
}, 10_000)

test.serial('does not retry after server-side tool activity starts', async () => {
  const { requestCount, result } = await runStreamRecoveryScenario(
    'partial-server-tool',
    () => partialServerToolResponse(),
  )

  expect(requestCount).toBe(1)
  expect(result.isApiErrorMessage).toBe(true)
}, 10_000)

test.serial('does not use non-streaming fallback after server-side tool activity starts', async () => {
  const { requestCount, result } = await runStreamRecoveryScenario(
    'partial-server-tool-default-fallback',
    () => partialServerToolResponse(),
    { disableNonStreamingFallback: false },
  )

  expect(requestCount).toBe(1)
  expect(result.isApiErrorMessage).toBe(true)
}, 10_000)

test.serial('sends effort when thinking is explicitly disabled', async () => {
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json() as Record<string, unknown>)
      return new Response(successfulResponse(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-disabled-thinking-effort-'))
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
  const originalMacro = globals.MACRO

  try {
    globals.MACRO = { BUILD_TIME: '' }
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_DISABLE_THINKING
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'loopback-test-key'
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-sol'
    process.env.ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,max_effort'
    enableConfigs()

    await queryWithModel({
      userPrompt: 'Reply exactly OK',
      signal: new AbortController().signal,
      options: {
        model: 'gpt-5.6-sol',
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'max',
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.thinking).toEqual({ type: 'disabled' })
    expect(requests[0]?.output_config).toEqual({ effort: 'max' })
  } finally {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (originalMacro === undefined) delete globals.MACRO
    else globals.MACRO = originalMacro
    server.stop(true)
    await rm(configDir, { recursive: true, force: true })
  }
}, 10_000)

test.serial('keeps required-thinking models enabled when the caller requests disabled thinking', async () => {
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json() as Record<string, unknown>)
      return new Response(successfulResponse(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-required-thinking-'))
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
  const originalMacro = globals.MACRO

  try {
    globals.MACRO = { BUILD_TIME: '' }
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_DISABLE_THINKING
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
    // CI/test auth requires a real accepted key source (ANTHROPIC_API_KEY /
    // CLAUDE_CODE_OAUTH_TOKEN). AUTH_TOKEN alone is treated as external auth and
    // still trips getAnthropicApiKeyWithSource() under NODE_ENV=test.
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'loopback-test-key'
    process.env.ANTHROPIC_MODEL = 'kimi-k2.7-code'
    delete process.env.ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'kimi-k2.7-code'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'kimi-k2.7-code'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'kimi-k2.7-code'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,required_thinking'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,required_thinking'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,required_thinking'
    enableConfigs()

    const result = await queryWithModel({
      userPrompt: 'Reply exactly OK',
      signal: new AbortController().signal,
      options: {
        model: 'kimi-k2.7-code',
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    expect(result.message.content).toEqual([{ type: 'text', text: 'OK' }])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.model).toBe('kimi-k2.7-code')
    expect(requests[0]?.thinking).toMatchObject({ type: 'enabled' })
  } finally {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (originalMacro === undefined) delete globals.MACRO
    else globals.MACRO = originalMacro
    server.stop(true)
    await rm(configDir, { recursive: true, force: true })
  }
}, 10_000)
