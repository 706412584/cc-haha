import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { traceCaptureService } from '../services/traceCaptureService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handleProxyRequest } from './handler.js'

/** Minimal Responses API success body. */
function upstreamBody() {
  return {
    id: 'resp_fixture',
    object: 'response',
    created_at: 0,
    model: 'fixture',
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg_fixture',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok' }],
    }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

const TURN_LIMIT_BODY = JSON.stringify({
  error: {
    code: 'session_turn_limit_exceeded',
    message: '当前会话已经很长（模型已回复超过 200 轮），请新开一个会话继续（Codex 输入 /new，其他客户端新建对话）。This conversation is too long (more than 200 model turns). Please start a new session to continue.',
    type: 'invalid_request_error',
  },
})

function user(text: string) {
  return { role: 'user', content: text }
}

function toolUse(id: string) {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo' } }] }
}

function toolResult(id: string, text: string) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
}

function longHistory(turns: number): unknown[] {
  const messages: unknown[] = [user('TASK')]
  for (let index = 0; index < turns; index += 1) {
    messages.push(toolUse(`tool-${index}`))
    messages.push(toolResult(`tool-${index}`, 'x'.repeat(4096)))
  }
  return messages
}

describe('proxy retries a turn-limit refusal with trimmed history', () => {
  let fixture: string
  let previous: string | undefined
  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'turn-limit-handler-'))
    previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = fixture
    resetSettingsCache()
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    resetSettingsCache()
    await rm(fixture, { recursive: true, force: true })
  })

  async function runProxy(messages: unknown[], upstreamResponses: Array<() => Response>) {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Fixture',
      baseUrl: 'https://fixture.invalid',
      apiKey: 'fake-key',
      apiFormat: 'openai_responses',
      models: { main: 'fixture', haiku: 'fixture', sonnet: 'fixture', opus: 'fixture' },
    })
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    const bodies: string[] = []
    let index = 0
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(String(init?.body ?? ''))
      const make = upstreamResponses[Math.min(index, upstreamResponses.length - 1)]
      index += 1
      return make()
    })
    try {
      const request = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-code-session-id': 'turn-limit-fixture',
        },
        body: JSON.stringify({ model: 'fixture', max_tokens: 1024, messages, stream: false }),
      })
      const response = await handleProxyRequest(request, new URL(request.url))
      return { status: response.status, bodies }
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  }

  const limitResponse = () => new Response(TURN_LIMIT_BODY, {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
  const okResponse = () => new Response(JSON.stringify(upstreamBody()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  test('cuts the history and retries once, then returns the successful response', async () => {
    const { status, bodies } = await runProxy(longHistory(200), [limitResponse, okResponse])

    expect(status).toBe(200)
    expect(bodies.length).toBe(2)
    const firstInput = (JSON.parse(bodies[0]) as { input: unknown[] }).input
    const secondInput = (JSON.parse(bodies[1]) as { input: unknown[] }).input
    expect(secondInput.length).toBeLessThan(firstInput.length)
    // The kept window still starts with the task anchor.
    expect(secondInput[0]).toMatchObject({ type: 'message', role: 'user', content: 'TASK' })
  })

  test('retries at most once even when the trimmed request is still refused', async () => {
    const { status, bodies } = await runProxy(longHistory(200), [
      limitResponse,
      limitResponse,
      okResponse,
    ])

    expect(status).toBe(400)
    expect(bodies.length).toBe(2)
  })

  test('does not retry when there is nothing safe to trim', async () => {
    const { status, bodies } = await runProxy(
      [user('hello'), { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
      [limitResponse, okResponse],
    )

    expect(status).toBe(400)
    expect(bodies.length).toBe(1)
  })

  test('still refuses unrelated 400s without a retry', async () => {
    const { status, bodies } = await runProxy(longHistory(200), [
      () => new Response(JSON.stringify({ error: { message: 'Invalid tools array' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
      okResponse,
    ])

    expect(status).toBe(400)
    expect(bodies.length).toBe(1)
  })
})