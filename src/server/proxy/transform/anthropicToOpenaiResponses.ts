/**
 * Request transformation: Anthropic Messages → OpenAI Responses API
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicMessage,
  OpenAIResponsesRequest,
  OpenAIResponsesInputItem,
  OpenAIChatContentPart,
} from './types.js'
import { stripLeadingBillingHeader } from './billingHeader.js'
import { normalizeOpenAIReasoningEffort } from './effort.js'

export type OpenAIResponsesTransformOptions = {
  /** Stable cache routing key, forwarded as `prompt_cache_key`. */
  cacheKey?: string
  passSamplingParams?: boolean
}

/**
 * Convert Anthropic Messages request to OpenAI Responses API request.
 */
export function anthropicToOpenaiResponses(
  body: AnthropicRequest,
  options: OpenAIResponsesTransformOptions = {},
): OpenAIResponsesRequest {
  const input: OpenAIResponsesInputItem[] = []

  // Convert messages to input items
  for (const msg of body.messages) {
    convertMessageToInputItems(msg, input)
  }

  const result: OpenAIResponsesRequest = {
    model: body.model,
    input,
    stream: body.stream,
    store: false,
  }

  // system → instructions, minus the leading billing attribution: its
  // rotating cch= signature would change the prefix every turn and defeat
  // upstream prompt caching.
  if (body.system) {
    const instructions = typeof body.system === 'string'
      ? stripLeadingBillingHeader(body.system)
      : body.system.map((b) => stripLeadingBillingHeader(b.text)).filter(Boolean).join('\n')
    if (instructions) {
      result.instructions = instructions
    }
  }

  if (options.cacheKey) {
    result.prompt_cache_key = options.cacheKey
  }

  // max_tokens — omit to let upstream provider use its own default/max.
  // Claude Code sends very large values that exceed many providers' limits.

  // Claude Code sends Anthropic sampling params that some compatible
  // providers reject. Keep them opt-in for providers known to accept them.
  if (options.passSamplingParams) {
    if (body.temperature !== undefined) result.temperature = body.temperature
    if (body.top_p !== undefined) result.top_p = body.top_p
  }

  // tools — an empty array after filtering is dropped, not sent as `[]`, so it
  // reads as "no tools" to strict upstreams instead of "an empty tool set".
  if (body.tools && body.tools.length > 0) {
    const tools = body.tools
      .filter((t) => t.name !== 'BatchTool')
      .map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }))
    if (tools.length > 0) {
      result.tools = tools
    }
  }

  // tool_choice — only meaningful next to the tools it selects from. A choice
  // that outlives its tool (BatchTool filtered above, or a client that sends
  // tool_choice with no tools at all) is an orphan that strict Responses
  // upstreams reject.
  if (body.tool_choice !== undefined) {
    const toolChoice = convertToolChoice(body.tool_choice)
    if (isSelectableToolChoice(toolChoice, result.tools)) {
      result.tool_choice = toolChoice
    }
  }

  // thinking → reasoning
  if (body.thinking) {
    const budget = body.thinking.budget_tokens
    if (budget !== undefined) {
      if (budget <= 1024) result.reasoning = { effort: 'low' }
      else if (budget <= 8192) result.reasoning = { effort: 'medium' }
      else result.reasoning = { effort: 'high' }
    } else if (body.thinking.type === 'enabled') {
      result.reasoning = { effort: 'high' }
    }
  }
  const outputConfigEffort = normalizeOpenAIReasoningEffort(body.output_config?.effort)
  if (outputConfigEffort !== undefined) {
    result.reasoning = { ...(result.reasoning ?? {}), effort: outputConfigEffort }
  }

  // stop_sequences not supported in Responses API, dropped

  return result
}

function convertMessageToInputItems(msg: AnthropicMessage, output: OpenAIResponsesInputItem[]): void {
  const content = msg.content

  // Simple string content
  if (typeof content === 'string') {
    output.push({ type: 'message', role: msg.role, content })
    return
  }

  if (!Array.isArray(content) || content.length === 0) {
    output.push({ type: 'message', role: msg.role, content: '' })
    return
  }

  // Collect text/image parts and handle tool blocks separately
  const contentParts: (string | OpenAIChatContentPart)[] = []

  for (const block of content) {
    if (block.type === 'text') {
      contentParts.push(block.text)
    } else if (block.type === 'image') {
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      })
    } else if (block.type === 'tool_use') {
      // Flush any accumulated content first
      if (contentParts.length > 0) {
        const flatContent = contentParts.length === 1 && typeof contentParts[0] === 'string'
          ? contentParts[0]
          : contentParts.map((p) => typeof p === 'string' ? p : '').join('')
        if (flatContent) {
          output.push({ type: 'message', role: msg.role, content: flatContent })
        }
        contentParts.length = 0
      }
      // Lift to function_call item
      output.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
      })
    } else if (block.type === 'tool_result') {
      // Lift to function_call_output item
      const resultContent = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n')
          : ''
      output.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: resultContent,
      })
    }
    // Skip thinking blocks
  }

  // Flush remaining content
  if (contentParts.length > 0) {
    const flatContent = contentParts.length === 1 && typeof contentParts[0] === 'string'
      ? contentParts[0]
      : contentParts.map((p) => typeof p === 'string' ? p : '').join('')
    if (flatContent) {
      output.push({ type: 'message', role: msg.role, content: flatContent })
    }
  }
}

function convertToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice
  if (typeof choice === 'object' && choice !== null) {
    const c = choice as Record<string, unknown>
    if (c.type === 'auto') return 'auto'
    if (c.type === 'any') return 'required'
    if (c.type === 'none') return 'none'
    if (c.type === 'tool' && typeof c.name === 'string') {
      // Responses names the function inline: {type:'function', name}. The
      // nested {function:{name}} form belongs to Chat Completions and is
      // rejected here (see anthropicToOpenaiChat for that shape).
      return { type: 'function', name: c.name }
    }
  }
  return 'auto'
}

/**
 * A named tool_choice is only valid while its target survives into the request.
 * Anything else — a choice with no tools at all — is dropped so the upstream
 * never sees a selector pointing at nothing.
 */
function isSelectableToolChoice(
  choice: unknown,
  tools: { name: string }[] | undefined,
): boolean {
  if (!tools || tools.length === 0) return false
  if (typeof choice !== 'object' || choice === null) return true
  const name = (choice as Record<string, unknown>).name
  if (typeof name !== 'string') return true
  return tools.some((tool) => tool.name === name)
}
