import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getIsInteractive,
  setIsInteractive,
} from '../../bootstrap/state.js'
import { enableConfigs } from '../../utils/config.js'
import { get3PModelCapabilityOverride } from '../../utils/model/modelSupportOverrides.js'
import { buildProviderManagedEnv } from '../../server/services/providerRuntimeEnv.js'
import type { SavedProvider } from '../../server/types/provider.js'
import { queryModelWithStreaming, queryWithModel } from './claude.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'

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

function successfulResponse(model: string, withThinking = false): string {
  const textIndex = withThinking ? 1 : 0

  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_required_thinking',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    ...(withThinking ? [
      sseEvent('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
      sseEvent('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'signature_delta', signature: 'fixture-signature' },
      }),
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ] : []),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: textIndex,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: textIndex,
      delta: { type: 'text_delta', text: 'OK' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function truncatedToolResponse(model: string): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_truncated_tool',
        type: 'message',
        role: 'assistant',
        model,
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
        type: 'tool_use',
        id: 'tool_truncated_write',
        name: 'Write',
        input: {},
      },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"file_path":"/tmp/never-created","content":"unfinished',
      },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens', stop_sequence: null },
      usage: { output_tokens: 131_072 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function hangingToolResponse(model: string): Response {
  const initialEvents = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_hanging_tool',
        type: 'message',
        role: 'assistant',
        model,
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
        type: 'tool_use',
        id: 'tool_hanging_write',
        name: 'Write',
        input: {},
      },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"content":"still growing',
      },
    }),
  ].join('')

  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(initialEvents))
      setTimeout(() => {
        try {
          controller.close()
        } catch {
          // The watchdog cancels the response body before this fallback close.
        }
      }, 250)
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function progressingToolResponse(model: string): Response {
  const events = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_progressing_tool',
        type: 'message',
        role: 'assistant',
        model,
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
        type: 'tool_use',
        id: 'tool_progressing_bash',
        name: 'Bash',
        input: {},
      },
    }),
    ...['{', '"command"', ':', '"echo OK"', '}'].map(partialJson =>
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: partialJson },
      }),
    ),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ]
  let nextEvent = 0
  let cancelled = false

  return new Response(new ReadableStream({
    async pull(controller) {
      if (nextEvent > 0) await Bun.sleep(10)
      if (cancelled) return
      controller.enqueue(new TextEncoder().encode(events[nextEvent]))
      nextEvent += 1
      if (nextEvent === events.length) controller.close()
    },
    cancel() {
      cancelled = true
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function tricklingToolResponse(model: string): Response {
  const initialEvents = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_trickling_tool',
        type: 'message',
        role: 'assistant',
        model,
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
        type: 'tool_use',
        id: 'tool_trickling_write',
        name: 'Write',
        input: {},
      },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"content":"' },
    }),
  ].join('')
  const progressEvent = sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: 'x' },
  })
  let sentInitialEvents = false
  let cancelled = false

  return new Response(new ReadableStream({
    async pull(controller) {
      if (sentInitialEvents) await Bun.sleep(10)
      if (cancelled) return
      controller.enqueue(new TextEncoder().encode(
        sentInitialEvents ? progressEvent : initialEvents,
      ))
      sentInitialEvents = true
    },
    cancel() {
      cancelled = true
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

const ENV_KEYS = [
  'NODE_ENV',
  'HOME',
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
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_STREAM_TRANSIENT_RETRY_MAX',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_ENABLE_STREAM_WATCHDOG',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_STREAM_MAX_DURATION_MS',
  'CLAUDE_STREAM_TOOL_INPUT_MAX_DURATION_MS',
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

async function captureQueryRequest({
  model,
  pinnedModel,
  capabilities,
  effortValue,
  configureCapabilityOverrides = true,
  globalThinkingEnabled,
  provider,
  responseFactory,
  continuationSystemPrompts,
  env,
}: {
  model: string
  pinnedModel?: string
  capabilities?: string
  effortValue?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  configureCapabilityOverrides?: boolean
  globalThinkingEnabled?: boolean
  provider?: SavedProvider
  responseFactory?: (model: string, body: Record<string, unknown>, headers: Headers) => Response
  continuationSystemPrompts?: string[][]
  env?: Readonly<Record<string, string | undefined>>
}): Promise<{
  content: unknown
  apiError: string | undefined
  error: string | undefined
  requests: Array<Record<string, unknown>>
  requestHeaders: Array<Headers>
}> {
  const requests: Array<Record<string, unknown>> = []
  const requestHeaders: Array<Headers> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requestHeaders.push(new Headers(request.headers))
      const body = await request.json() as Record<string, unknown>
      requests.push(body)
      return responseFactory?.(model, body, request.headers) ?? new Response(successfulResponse(model), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-required-thinking-'))
  const managedEnv = provider
    ? buildProviderManagedEnv({
        ...provider,
        baseUrl: `http://127.0.0.1:${server.port}`,
      })
    : {}
  const requestedEnv = { ...managedEnv, ...env }
  const envKeys = [...new Set([...ENV_KEYS, ...Object.keys(requestedEnv)])]
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
  const originalMacro = globals.MACRO
  const originalIsInteractive = getIsInteractive()

  try {
    globals.MACRO = { BUILD_TIME: '' }
    setIsInteractive(false)
    process.env.NODE_ENV = 'production'
    process.env.HOME = configDir
    process.env.CLAUDE_CONFIG_DIR = configDir
    if (globalThinkingEnabled !== undefined) {
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ alwaysThinkingEnabled: globalThinkingEnabled }),
      )
    }
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_DISABLE_THINKING
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'loopback-test-key'
    process.env.ANTHROPIC_MODEL = model
    delete process.env.ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES
    if (configureCapabilityOverrides && capabilities !== undefined) {
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = pinnedModel ?? model
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
        capabilities
    }
    for (const [key, value] of Object.entries(requestedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clearCapabilityCache()
    enableConfigs()

    const options = {
      model,
      querySource: 'insights' as const,
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      effortValue,
    }
    let result
    if (continuationSystemPrompts) {
      const history: Message[] = []
      for (const [index, systemPrompt] of [[], ...continuationSystemPrompts].entries()) {
        history.push(createUserMessage({ content: index === 0 ? 'Reply exactly OK' : 'Continue' }))
        const assistants = []
        for await (const message of queryModelWithStreaming({
          messages: history,
          systemPrompt: asSystemPrompt(systemPrompt),
          thinkingConfig: { type: 'disabled' },
          tools: [],
          signal: new AbortController().signal,
          options: {
            ...options,
            enablePromptCaching: false,
            getToolPermissionContext: async () => getEmptyToolPermissionContext(),
          },
        })) {
          if (message.type === 'assistant') assistants.push(message)
        }
        history.push(...assistants)
        result = assistants.at(-1)
      }
    } else {
      result = await queryWithModel({
        userPrompt: 'Reply exactly OK',
        signal: new AbortController().signal,
        options,
      })
    }
    if (!result) throw new Error('No assistant response received')

    return {
      content: result.message.content,
      apiError: result.apiError,
      error: result.error,
      requests,
      requestHeaders,
    }
  } finally {
    for (const key of envKeys) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (originalMacro === undefined) delete globals.MACRO
    else globals.MACRO = originalMacro
    setIsInteractive(originalIsInteractive)
    server.stop(true)
    clearCapabilityCache()
    await rm(configDir, { recursive: true, force: true })
  }
}

test('does not replay a policy-blocked stream through non-streaming fallback', async () => {
  let calls = 0
  const result = await captureQueryRequest({
    model: 'gpt-6-astra',
    continuationSystemPrompts: [],
    responseFactory: model => {
      calls += 1
      return new Response(calls === 1 ? sseEvent('error', {
        type: 'error',
        error: { type: 'permission_error', code: 'cyber_policy', message: 'Request blocked by safety policy' },
      }) : successfulResponse(model), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  expect(result.requests).toHaveLength(1)
  expect(JSON.stringify(result.content)).toContain('Request blocked by safety policy')
})

test('keeps required-thinking models enabled when the caller requests disabled thinking', async () => {
  const { content, requests } = await captureQueryRequest({
    model: 'k3',
    capabilities: 'thinking,required_thinking,effort,max_effort',
  })

  expect(content).toEqual([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.model).toBe('k3')
  expect(requests[0]?.thinking).toMatchObject({ type: 'enabled' })
}, 10_000)

test('derives GLM 5.3 standard API request controls from the provider-managed environment', async () => {
  const provider = {
    id: 'provider-zhipu',
    presetId: 'zhipuglm',
    name: 'Zhipu GLM',
    apiKey: 'loopback-test-key',
    authStrategy: 'auth_token',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiFormat: 'anthropic',
    runtimeKind: 'anthropic_compatible',
    models: {
      main: 'glm-5.3-flash[1m]',
      haiku: 'glm-5.3-flash[1m]',
      sonnet: 'glm-5.3[1m]',
      opus: 'glm-5.3[1m]',
    },
  } satisfies SavedProvider

  const { content, requests } = await captureQueryRequest({
    model: 'glm-5.3-flash[1m]',
    provider,
    configureCapabilityOverrides: false,
    globalThinkingEnabled: false,
    effortValue: 'low',
    responseFactory: (model, body) => {
      const thinking = body.thinking as { type?: unknown } | undefined
      const outputConfig = body.output_config as { effort?: unknown } | undefined
      if (
        thinking?.type !== 'enabled' ||
        !['low', 'high', 'max'].includes(String(outputConfig?.effort))
      ) {
        return Response.json({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: '1210',
            message: '[1210][API 调用参数有误，请检查文档。]',
          },
        }, { status: 400 })
      }
      return new Response(successfulResponse(model), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })

  expect(content).toEqual([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.model).toBe('glm-5.3-flash')
  expect(requests[0]?.thinking).toMatchObject({ type: 'enabled' })
  expect(requests[0]?.output_config).toEqual({ effort: 'low' })
}, 10_000)

test('keeps request effort when thinking is explicitly disabled', async () => {
  const { requests } = await captureQueryRequest({
    model: 'effort-model',
    capabilities: 'thinking,effort,max_effort',
    effortValue: 'low',
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.thinking).toEqual({ type: 'disabled' })
  expect(requests[0]?.output_config).toEqual({ effort: 'low' })
}, 10_000)

test('sends effort through the final request when a pinned model adds a 1M marker', async () => {
  const { requests, requestHeaders } = await captureQueryRequest({
    model: 'deepseek-v4-flash',
    pinnedModel: 'deepseek-v4-flash[1m]',
    capabilities: 'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    effortValue: 'low',
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.model).toBe('deepseek-v4-flash')
  expect(requests[0]?.output_config).toEqual({ effort: 'low' })
  expect(requests[0]?.thinking).toEqual({ type: 'disabled' })
  expect(requestHeaders[0]?.get('anthropic-beta')).toContain('effort-2025-11-24')
}, 10_000)

test('keeps explicit GPT effort in the final direct-relay request when beta headers are disabled', async () => {
  const { requests, requestHeaders } = await captureQueryRequest({
    model: 'gpt-5.6-sol[1m]',
    configureCapabilityOverrides: false,
    effortValue: 'xhigh',
    env: {
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.model).toBe('gpt-5.6-sol')
  expect(requests[0]?.output_config).toEqual({ effort: 'xhigh' })
  expect(requestHeaders[0]?.get('anthropic-beta')).toBeNull()
}, 10_000)

test('normalizes a disabled parent thinking mode to adaptive for Fable', async () => {
  const { requests } = await captureQueryRequest({
    model: 'claude-fable-5',
    configureCapabilityOverrides: false,
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.thinking).toEqual({ type: 'adaptive' })
  expect(requests[0]?.thinking).not.toEqual({ type: 'disabled' })
}, 10_000)

for (const [disableBetas, disableAdaptive] of [[false, false], [true, false], [false, true]]) {
  test(`keeps Fable 5.1 replay usable after a system change (disable betas: ${disableBetas}, adaptive: ${disableAdaptive})`, async () => {
    let originalSystem: string | undefined
    let responseIndex = 0
    const { content, requests, requestHeaders } = await captureQueryRequest({
      model: 'claude-fable-5-1',
      configureCapabilityOverrides: false,
      continuationSystemPrompts: [[], ['Additional working directories: /tmp/project-two']],
      env: {
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: disableBetas ? '1' : undefined,
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: disableAdaptive ? '1' : undefined,
      },
      responseFactory: (model, body, headers) => {
        const system = JSON.stringify(body.system)
        const changed = originalSystem !== undefined && system !== originalSystem
        originalSystem ??= system
        const thinking = body.thinking as { block_binding?: { prefix_mismatch_behavior?: string } }
        if (changed && (
          thinking?.block_binding?.prefix_mismatch_behavior !== 'drop_block' ||
          !headers.get('anthropic-beta')?.includes('thinking-binding-controls-2026-08-01')
        )) {
          return Response.json({ type: 'error', error: {
            type: 'invalid_request_error', message: 'The block is bound to a different conversation',
          } }, { status: 400 })
        }
        const response = successfulResponse(model, true).replaceAll('msg_required_thinking', `msg_replay_${responseIndex++}`)
        return new Response(response, { headers: { 'content-type': 'text/event-stream' } })
      },
    })

    expect(content).toContainEqual({ type: 'text', text: 'OK' })
    expect(requests).toHaveLength(3)
    for (let index = 0; index < requests.length; index++) {
      expect(requests[index]?.model).toBe('claude-fable-5-1')
      expect(requests[index]?.thinking).toEqual({
        type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' },
      })
      expect(requestHeaders[index]?.get('anthropic-beta')).toContain('thinking-binding-controls-2026-08-01')
    }
    for (const request of requests.slice(1)) {
      expect(JSON.stringify(request.messages)).toContain('fixture-signature')
    }
  }, 10_000)
}

test('drops a tool call truncated at the output-token boundary', async () => {
  const { content, apiError, error, requests } = await captureQueryRequest({
    model: 'deepseek-v4-flash',
    configureCapabilityOverrides: false,
    responseFactory: model => new Response(truncatedToolResponse(model), {
      headers: { 'content-type': 'text/event-stream' },
    }),
  })

  expect(requests).toHaveLength(1)
  expect(content).toEqual([
    expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('tool call was truncated'),
    }),
  ])
  expect(content).not.toContainEqual(expect.objectContaining({ type: 'tool_use' }))
  expect(apiError).toBeUndefined()
  expect(error).toBe('max_output_tokens')
}, 10_000)

test('aborts a tool input that stops progressing without completing', async () => {
  const { content, error, requests } = await captureQueryRequest({
    model: 'deepseek-v4-flash',
    configureCapabilityOverrides: false,
    responseFactory: hangingToolResponse,
    env: {
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1000',
      CLAUDE_STREAM_MAX_DURATION_MS: '1000',
      CLAUDE_STREAM_TOOL_INPUT_MAX_DURATION_MS: '20',
    },
  })

  expect(requests).toHaveLength(1)
  expect(content).toEqual([
    expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('Tool input generation exceeded'),
    }),
  ])
  expect(error).toBe('server_error')
}, 10_000)

test('allows a progressing tool input to outlive its inactivity budget', async () => {
  const { content, error, requests } = await captureQueryRequest({
    model: 'deepseek-v4-flash',
    configureCapabilityOverrides: false,
    responseFactory: progressingToolResponse,
    env: {
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1000',
      CLAUDE_STREAM_MAX_DURATION_MS: '1000',
      // The fixture streams ~10 events at ~10ms each; give the overall
      // tool-input budget enough headroom that a slow CI scheduler cannot
      // exhaust it between deltas (every delta resets the inactivity clock).
      CLAUDE_STREAM_TOOL_INPUT_MAX_DURATION_MS: '2000',
    },
  })

  expect(requests).toHaveLength(1)
  expect(content).toEqual([
    expect.objectContaining({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'echo OK' },
    }),
  ])
  expect(error).toBeUndefined()
}, 10_000)

test('bounds a tool input that keeps progressing but never completes', async () => {
  const { content, error, requests } = await captureQueryRequest({
    model: 'deepseek-v4-flash',
    configureCapabilityOverrides: false,
    responseFactory: tricklingToolResponse,
    env: {
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1000',
      CLAUDE_STREAM_MAX_DURATION_MS: '200',
      CLAUDE_STREAM_TOOL_INPUT_MAX_DURATION_MS: '100',
    },
  })

  expect(requests).toHaveLength(1)
  expect(content).toEqual([
    expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('Stream max duration exceeded'),
    }),
  ])
  expect(error).toBe('server_error')
}, 10_000)

function clearCapabilityCache() {
  ;(get3PModelCapabilityOverride as typeof get3PModelCapabilityOverride & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}
