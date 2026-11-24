import { describe, expect, test } from 'bun:test'
import {
  EARLIER_INSTRUCTION_BUDGET_BYTES,
  TURN_LIMIT_ERROR_CODE,
  TRIMMED_HISTORY_BUDGET_BYTES,
  parseTurnLimit,
  trimHistoryForTurnLimit,
  USER_TURN_LIMIT,
} from './historyTrim.js'
import type { AnthropicMessage, AnthropicRequest } from './transform/types.js'

const SIZE_WORDING = JSON.stringify({
  error: {
    code: TURN_LIMIT_ERROR_CODE,
    message: '当前会话已经很长（模型已回复超过 200 轮），请新开一个会话继续（Codex 输入 /new，其他客户端新建对话）。This conversation is too long (more than 200 model turns). Please start a new session to continue.',
  },
})

const USER_WORDING = JSON.stringify({
  error: {
    code: TURN_LIMIT_ERROR_CODE,
    message: '当前会话已满 20 轮对话，请新开一个会话继续（Codex 输入 /new，其他客户端新建对话）。This conversation has reached 20 turns. Please start a new session to continue.',
  },
})

function request(messages: AnthropicMessage[]): AnthropicRequest {
  return {
    model: 'gpt-6.1-sol',
    max_tokens: 8192,
    messages,
    system: 'fixture system',
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  }
}

function user(text: string): AnthropicMessage {
  return { role: 'user', content: text }
}

function assistant(text: string): AnthropicMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function toolUse(id: string): AnthropicMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo' } }] }
}

function toolResult(id: string, text: string): AnthropicMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
}

/** A realistic long history: real user turn, then tool round-trips. */
function longHistory(turns: number, bytesPerResult: number): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [user('TASK: implement the fixture')]
  for (let index = 0; index < turns; index += 1) {
    messages.push(toolUse(`tool-${index}`))
    messages.push(toolResult(`tool-${index}`, 'x'.repeat(bytesPerResult)))
    messages.push(assistant(`result ${index}`))
  }
  return messages
}

function jsonBytes(messages: AnthropicMessage[]): number {
  return JSON.stringify(messages).length
}

function utf8Bytes(messages: AnthropicMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8')
}

function seenUserTurns(messages: AnthropicMessage[]): number {
  return messages.filter(message => message.role === 'user'
    && !(Array.isArray(message.content)
      && message.content.some(block => block.type === 'tool_result'))).length
}

function assertPaired(messages: AnthropicMessage[]): void {
  const uses = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.add(block.id)
    }
  }
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        expect(uses.has(block.tool_use_id)).toBe(true)
      }
    }
  }
}

describe('parseTurnLimit', () => {
  test('reads the small user-turn wording as the user-turn cap', () => {
    expect(parseTurnLimit(USER_WORDING)).toEqual({ kind: 'user-turns', limit: USER_TURN_LIMIT })
  })

  test('reads the 200-turn wording as the history-size cap', () => {
    expect(parseTurnLimit(SIZE_WORDING)).toEqual({ kind: 'history-size', limit: 200 })
  })

  test('falls back to the size cap when the message names no number', () => {
    expect(parseTurnLimit('{"error":{"code":"session_turn_limit_exceeded"}}')).toEqual({ kind: 'history-size', limit: undefined })
  })
})

describe('trimHistoryForTurnLimit', () => {
  test('leaves a short history untouched', () => {
    const body = request([user('hello'), assistant('hi')])
    expect(trimHistoryForTurnLimit(body, SIZE_WORDING)).toBeNull()
  })

  test('size cap: keeps the newest turns within the byte budget', () => {
    const body = request(longHistory(200, 4096))
    expect(jsonBytes(body.messages)).toBeGreaterThan(TRIMMED_HISTORY_BUDGET_BYTES)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    expect(jsonBytes(trimmed!.messages)).toBeLessThan(jsonBytes(body.messages))
    expect(trimmed!.messages.length).toBeLessThan(body.messages.length)
    assertPaired(trimmed!.messages)
    // The task statement is the anchor: the model must still know the task.
    expect(trimmed!.messages[0]).toEqual(user('TASK: implement the fixture'))
  })

  test('size cap: keeps non-message fields untouched', () => {
    const body = request(longHistory(200, 4096))
    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)!

    expect(trimmed.model).toBe(body.model)
    expect(trimmed.system).toBe(body.system)
    expect(trimmed.tools).toBe(body.tools)
    expect(trimmed.max_tokens).toBe(body.max_tokens)
  })

  test('user-turn cap: keeps at most 19 real user messages', () => {
    const messages: AnthropicMessage[] = []
    for (let index = 0; index < 25; index += 1) {
      messages.push(user(`question ${index}`))
      messages.push(assistant(`answer ${index}`))
    }
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, USER_WORDING)

    expect(trimmed).not.toBeNull()
    expect(seenUserTurns(trimmed!.messages)).toBe(USER_TURN_LIMIT - 1)
    expect(trimmed!.messages.at(-1)).toEqual(assistant('answer 24'))
  })

  test('user-turn cap: tool results stay paired with their tool_use', () => {
    const messages: AnthropicMessage[] = [user('TASK')]
    for (let index = 0; index < 25; index += 1) {
      messages.push(user(`question ${index}`))
      messages.push(toolUse(`t-${index}`))
      messages.push(toolResult(`t-${index}`, 'ok'))
    }
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, USER_WORDING)

    expect(trimmed).not.toBeNull()
    expect(seenUserTurns(trimmed!.messages)).toBeLessThanOrEqual(USER_TURN_LIMIT - 1)
    assertPaired(trimmed!.messages)
  })

  test('user-turn wording on an already-short history falls through to the size path', () => {
    const body = request(longHistory(200, 4096))

    const trimmed = trimHistoryForTurnLimit(body, USER_WORDING)

    expect(trimmed).not.toBeNull()
    expect(jsonBytes(trimmed!.messages)).toBeLessThan(jsonBytes(body.messages))
  })

  test('starts the kept window at a clean boundary even when the budget lands on a tool result', () => {
    const messages: AnthropicMessage[] = [user('TASK')]
    for (let index = 0; index < 80; index += 1) {
      messages.push(toolUse(`t-${index}`))
      messages.push(toolResult(`t-${index}`, 'y'.repeat(8192)))
    }
    const body = request(messages)

    // A budget that lands inside the newest result still produces a valid window.
    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    assertPaired(trimmed!.messages)
    expect(trimmed!.messages[0].role).toBe('user')
  })

  test('does nothing when every message is already part of one window', () => {
    const body = request([user('only'), assistant('turn')])
    expect(trimHistoryForTurnLimit(body, USER_WORDING)).toBeNull()
  })

  test('returns null for an empty history', () => {
    expect(trimHistoryForTurnLimit({ ...request([]), messages: [] }, SIZE_WORDING)).toBeNull()
  })

  test('handles string content alongside block content', () => {
    const messages: AnthropicMessage[] = []
    for (let index = 0; index < 200; index += 1) {
      messages.push(user(`question ${index} ${'q'.repeat(4096)}`))
      messages.push(assistant(`answer ${index}`))
    }
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    expect(trimmed!.messages.length).toBeLessThan(messages.length)
  })

  test('budget counts UTF-8 bytes, not UTF-16 code units', () => {
    const messages: AnthropicMessage[] = [user('任务：实现中文界面')]
    for (let index = 0; index < 60; index += 1) {
      messages.push(toolUse(`cjk-${index}`))
      // 20000 CJK chars = 60KB in UTF-8 but only 20K in UTF-16 code units.
      messages.push(toolResult(`cjk-${index}`, '中'.repeat(20_000)))
    }
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    expect(utf8Bytes(trimmed!.messages)).toBeLessThanOrEqual(TRIMMED_HISTORY_BUDGET_BYTES * 1.1)
    assertPaired(trimmed!.messages)
  })

  test('drops an oversized anchor instead of letting it consume the budget', () => {
    const hugeAnchor = user('TASK ' + 'anchor'.repeat(TRIMMED_HISTORY_BUDGET_BYTES / 4))
    const messages: AnthropicMessage[] = [hugeAnchor]
    for (let index = 0; index < 200; index += 1) {
      messages.push(toolUse(`big-${index}`))
      messages.push(toolResult(`big-${index}`, 'z'.repeat(4096)))
    }
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    expect(trimmed!.messages[0]).not.toEqual(hugeAnchor)
    expect(utf8Bytes(trimmed!.messages)).toBeLessThanOrEqual(TRIMMED_HISTORY_BUDGET_BYTES * 1.1)
  })

  test('keeps earlier real user instructions that fell outside the window', () => {
    const messages: AnthropicMessage[] = [user('TASK')]
    messages.push(user('ok，开始数据对接类任务'))
    for (let index = 0; index < 200; index += 1) {
      messages.push(toolUse(`e-${index}`))
      messages.push(toolResult(`e-${index}`, 'x'.repeat(4096)))
    }
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    const text = JSON.stringify(trimmed!.messages)
    expect(text).toContain('Earlier user instructions retained for continuity')
    expect(text).toContain('开始数据对接类任务')
    assertPaired(trimmed!.messages)
  })

  test('earlier-instruction list keeps the newest entries within its budget', () => {
    const messages: AnthropicMessage[] = [user('TASK')]
    for (let index = 0; index < 20; index += 1) {
      messages.push(user(`early instruction ${index} ${'x'.repeat(2000)}`))
    }
    for (let index = 0; index < 200; index += 1) {
      messages.push(toolUse(`l-${index}`))
      messages.push(toolResult(`l-${index}`, 'y'.repeat(4096)))
    }
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)
    const list = trimmed!.messages.find(
      message => typeof message.content === 'string'
        && message.content.startsWith('[Earlier user instructions'),
    ) as AnthropicMessage | undefined

    expect(list).toBeDefined()
    expect(Buffer.byteLength(list!.content as string, 'utf8'))
      .toBeLessThanOrEqual(EARLIER_INSTRUCTION_BUDGET_BYTES)
    // The newest authorization must survive; the oldest entries are dropped.
    expect(list!.content as string).toContain('early instruction 19')
    expect(list!.content as string).not.toContain('early instruction 0 ')
  })

  test('does not add an earlier-instruction list when no user message was cut', () => {
    const messages: AnthropicMessage[] = [toolUse('solo'), toolResult('solo', 'z'.repeat(4096))]
    for (let index = 0; index < 200; index += 1) {
      messages.push(toolUse(`n-${index}`))
      messages.push(toolResult(`n-${index}`, 'z'.repeat(4096)))
    }
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    expect(JSON.stringify(trimmed!.messages)).not.toContain('Earlier user instructions')
  })

  test('drops a tool_use whose result never came back', () => {
    const messages: AnthropicMessage[] = [user('TASK')]
    for (let index = 0; index < 200; index += 1) {
      messages.push(toolUse(`p-${index}`))
      messages.push(toolResult(`p-${index}`, 'x'.repeat(4096)))
    }
    messages.push(assistant('planning the next step'))
    messages.push(toolUse('pending-call'))
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    expect(JSON.stringify(trimmed!.messages)).not.toContain('pending-call')
    const uses = new Set<string>()
    const results = new Set<string>()
    for (const message of trimmed!.messages) {
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block.type === 'tool_use') uses.add(block.id)
        if (block.type === 'tool_result') results.add(block.tool_use_id)
      }
    }
    expect([...uses].sort()).toEqual([...results].sort())
  })

  test('degrades oversized media in the newest message instead of refusing', () => {
    const messages: AnthropicMessage[] = [user('TASK')]
    for (let index = 0; index < 200; index += 1) {
      messages.push(toolUse(`d-${index}`))
      messages.push(toolResult(`d-${index}`, 'x'.repeat(4096)))
    }
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: 'here is the screenshot' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(TRIMMED_HISTORY_BUDGET_BYTES * 2) },
        },
      ],
    })
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    const text = JSON.stringify(trimmed!.messages)
    // The current turn survives: its text and the tool trail that led to it.
    expect(text).toContain('here is the screenshot')
    expect(text).toContain('omitted to fit provider request limit')
    expect(text).not.toContain('AAAAAAAAAAAA')
    expect(trimmed!.messages.at(-1)).toMatchObject({ role: 'user' })
  })

  test('degrades oversized media even when no other message needs trimming', () => {
    const messages: AnthropicMessage[] = [
      user('TASK'),
      assistant('done'),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'here is the screenshot' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(TRIMMED_HISTORY_BUDGET_BYTES * 2) },
          },
        ],
      },
    ]
    const body = request(messages)

    const trimmed = trimHistoryForTurnLimit(body, SIZE_WORDING)

    expect(trimmed).not.toBeNull()
    expect(trimmed!.messages.length).toBe(messages.length)
    const text = JSON.stringify(trimmed!.messages)
    expect(text).toContain('here is the screenshot')
    expect(text).toContain('omitted to fit provider request limit')
    expect(text).not.toContain('BBBBBBBBBBBB')
  })

  test('returns null when the newest single message alone exceeds the budget', () => {
    const messages: AnthropicMessage[] = [user('TASK')]
    for (let index = 0; index < 20; index += 1) {
      messages.push(toolUse(`m-${index}`))
      messages.push(toolResult(`m-${index}`, 'ok'))
    }
    messages.push(assistant('huge'.repeat(TRIMMED_HISTORY_BUDGET_BYTES)))
    const body = request(messages)

    expect(trimHistoryForTurnLimit(body, SIZE_WORDING)).toBeNull()
  })
})