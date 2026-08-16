import { describe, test, expect } from 'bun:test'
import { anthropicToOpenaiChat } from '../proxy/transform/anthropicToOpenaiChat.js'
import { openaiChatToAnthropic } from '../proxy/transform/openaiChatToAnthropic.js'
import type { AnthropicRequest, OpenAIChatResponse } from '../proxy/transform/types.js'

describe('aikangsI-kiro99 opus4.6 reasoning passthrough', () => {
  test('Anthropic thinking → OpenAI reasoning_effort → OpenAI reasoning_content → Anthropic thinking', () => {
    // 步骤 1: cc-haha 收到带 thinking 的 Anthropic 请求
    const anthropicRequest: AnthropicRequest = {
      model: 'opus-4.6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Test reasoning' }],
      thinking: { type: 'enabled', budget_tokens: 8192 },
    }

    // 步骤 2: cc-haha 转换为 OpenAI Chat 格式
    const openaiRequest = anthropicToOpenaiChat(anthropicRequest, {
      roundTripReasoningContent: true,
      passThinkingToggle: true,
    })

    expect(openaiRequest.reasoning_effort).toBe('medium')

    // 步骤 3: 模拟 aikangsI-kiro99 返回 reasoning_content
    const openaiResponse: OpenAIChatResponse = {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'opus-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Final answer',
          reasoning_content: 'Step 1: analyze the question. Step 2: formulate answer.',
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    }

    // 步骤 4: cc-haha 转换回 Anthropic 格式
    const anthropicResponse = openaiChatToAnthropic(openaiResponse, 'opus-4.6')

    expect(anthropicResponse.content).toHaveLength(2)
    expect(anthropicResponse.content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Step 1: analyze the question. Step 2: formulate answer.',
    })
    expect(anthropicResponse.content[1]).toMatchObject({
      type: 'text',
      text: 'Final answer',
    })
  })

  test('服务商不返回 reasoning_content 时应只有文本块', () => {
    const openaiResponse: OpenAIChatResponse = {
      id: 'chatcmpl-no-reasoning',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'opus-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Direct answer without reasoning',
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }

    const anthropicResponse = openaiChatToAnthropic(openaiResponse, 'opus-4.6')

    expect(anthropicResponse.content).toHaveLength(1)
    expect(anthropicResponse.content[0]).toMatchObject({
      type: 'text',
      text: 'Direct answer without reasoning',
    })
  })
})
