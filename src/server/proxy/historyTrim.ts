/**
 * Trim conversation history when an upstream caps what one request may carry.
 *
 * Xingchi (`api.xingchiapi.com`, a Codex relay) refuses long requests with
 * `400 session_turn_limit_exceeded`. The relay has two different caps under that
 * one code, and the message text says which one fired:
 *
 * - "已满 20 轮对话 / reached 20 turns": only `type:"message"` user items are
 *   counted, capped at 20. Tool results (`function_call_output`) and assistant
 *   messages do not count. This path is used when the request carries neither
 *   `tools` nor `instructions`.
 * - "模型已回复超过 200 轮 / more than 200 model turns": the request carries
 *   `tools` or `instructions` (every real CLI request does), and the relay
 *   rejects on the *size* of the history — around 800KB / 200K tokens. Measured
 *   boundary: the full 805KB history is refused, the same tail cut to 201KB
 *   passes. Item counts do not matter (201 short items pass).
 *
 * Neither cap is bound to a conversation id: a one-message request with the
 * original `prompt_cache_key` passes, and the same oversized history is refused
 * with a fresh random key. Rotating the id therefore cannot help — the only way
 * to continue in place is to send less history.
 *
 * Trim rules:
 * - `system`, tools and every non-message field stay untouched.
 * - The kept window starts at a clean boundary: a `function_call` is never
 *   separated from its `function_call_output`, because a dangling output is an
 *   invalid Responses input.
 * - The first real user message is kept as an anchor when it fits: it carries
 *   the task statement, and without it the model no longer knows what the
 *   session is about. The anchor occupies part of the budget.
 */

import type { AnthropicMessage, AnthropicRequest } from './transform/types.js'

export const TURN_LIMIT_ERROR_CODE = 'session_turn_limit_exceeded'

/**
 * The relay's request-size cap for `tools`/`instructions` requests.
 *
 * The relay changes this cap without notice: on 2026-11-25 the wording moved
 * from "more than 200 model turns" (805KB of pure history passed, 835KB with
 * instructions was refused) to "reached 100 model turns". Measured against the
 * 100-turn wording: a 381KB request passes, a 572KB request is refused, and a
 * 150-round-trip request reports "105 turns" — the counter is a size-derived
 * number, not an item count (1 user + 101 assistant messages still passes).
 *
 * 250KB of model-visible message content leaves room for the real request's
 * system prompt and ~100 tool definitions under that boundary.
 */
export const TRIMMED_HISTORY_BUDGET_BYTES = 250 * 1024

/**
 * Process-wide override for the trim budget. Relays change their caps without
 * notice; setting this (or a provider's `turnLimitTrimBytes`) lets the user
 * follow the new boundary without a code change or a new build.
 */
export const TURN_LIMIT_BUDGET_ENV = 'CLAUDE_PROXY_TURN_LIMIT_BUDGET_BYTES'

/**
 * Budget precedence: per-provider override, then the environment variable,
 * then the built-in default.
 */
export function resolveTurnLimitBudgetBytes(override?: number | null): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override)
  }
  const fromEnv = Number.parseInt(process.env[TURN_LIMIT_BUDGET_ENV] ?? '', 10)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return TRIMMED_HISTORY_BUDGET_BYTES
}

/** The relay's user-message cap on its non-tool path. */
export const USER_TURN_LIMIT = 20

/**
 * Budget for the compact list of earlier user instructions kept outside the
 * window. Authorizations and task switches are cheap (a few KB) but decisive:
 * without them the model reads the recent tool trail and concludes the user
 * never approved the work it is doing.
 */
export const EARLIER_INSTRUCTION_BUDGET_BYTES = 16 * 1024

const EARLIER_INSTRUCTION_LIMIT = 64
const EARLIER_INSTRUCTION_CHARS = 300

/**
 * Budget for the compacted activity digest that keeps the shape of the work
 * that fell outside the recent window. Tool calls and their outputs are
 * summarized instead of dropped whole, so the model still knows what it did
 * even though the details are gone.
 */
export const COMPACTED_ACTIVITY_BUDGET_BYTES = 32 * 1024
const COMPACTED_ENTRY_CHARS = 500

type TurnLimitKind = 'user-turns' | 'history-size'

type ParsedTurnLimit = {
  kind: TurnLimitKind
  /** The number in the relay's message, when it names one. */
  limit?: number
}

const TURN_LIMIT_PATTERN = /(?:已满|超过|已回复)\s*(\d+)\s*轮|(?:reached|more than)\s+(\d+)\s+(?:model\s+)?turns?/i

/**
 * Read which cap the relay reported. The "size" wording ("模型已回复超过
 * 200 轮") is the one used when `tools`/`instructions` are present; the
 * user-turn wording ("已满 20 轮对话") names the small number. Anything above
 * the user-turn range is the size path, and a message that names no number at
 * all also falls back to the size path — a real CLI request always carries
 * tools, so that is the cap it actually hits.
 */
export function parseTurnLimit(errText: string): ParsedTurnLimit {
  const match = TURN_LIMIT_PATTERN.exec(errText)
  const parsed = match ? Number.parseInt(match[1] ?? match[2] ?? '', 10) : NaN
  if (Number.isFinite(parsed) && parsed <= USER_TURN_LIMIT) {
    return { kind: 'user-turns', limit: parsed }
  }
  return { kind: 'history-size', limit: Number.isFinite(parsed) ? parsed : undefined }
}

function isToolResultMessage(message: AnthropicMessage): boolean {
  return message.role === 'user'
    && Array.isArray(message.content)
    && message.content.some(block => block.type === 'tool_result')
}

function isRealUserMessage(message: AnthropicMessage): boolean {
  return message.role === 'user' && !isToolResultMessage(message)
}

/**
 * System injections ride in user messages too (background-task notifications,
 * skill/bootstrap blocks, local command output). They are cheap in meaning but
 * expensive in bytes, and they crowd out the user's actual authorizations in
 * the retained-instructions budget. Keep them out of that list.
 */
const USER_INJECTION_MARKERS = [
  '<task-notification',
  '<task-id>',
  'Base directory for this skill',
  '<local-command-',
]

function isUserInstructionMessage(message: AnthropicMessage): boolean {
  if (!isRealUserMessage(message)) return false
  const text = userMessageText(message)
  return !USER_INJECTION_MARKERS.some(marker => text.includes(marker))
}

/** UTF-8 size of a text payload, matching what the relay counts on the wire. */
function textBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Model-visible text size of a message.
 *
 * Counting serialized JSON instead inflates the estimate roughly sixfold on
 * real transcripts (escaping, cache_control, tool_use inputs), which made the
 * budget cut to ~12KB of content where the relay accepts ~200KB. The cap is
 * on what the model sees, so count text payloads, base64 media and tool inputs
 * only — in UTF-8 bytes, because a CJK character is three bytes but one UTF-16
 * code unit.
 */
function contentTextBytes(value: unknown): number {
  if (typeof value === 'string') return textBytes(value)
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) total += contentTextBytes(item)
    return total
  }
  if (!value || typeof value !== 'object') return 0
  const record = value as Record<string, unknown>
  let total = 0
  if (typeof record.text === 'string') total += textBytes(record.text)
  if (typeof record.data === 'string') total += textBytes(record.data)
  if (typeof record.url === 'string') total += textBytes(record.url)
  if (record.content !== undefined) total += contentTextBytes(record.content)
  if (record.source !== undefined) total += contentTextBytes(record.source)
  if (record.input !== undefined) {
    try {
      total += textBytes(JSON.stringify(record.input))
    } catch {
      // Circular tool input: count nothing rather than fail the trim.
    }
  }
  return total
}

function messageBytes(message: AnthropicMessage): number {
  return contentTextBytes(message.content)
}

/**
 * Replace media payloads with short placeholders, keeping every text and tool
 * field. The newest message must survive a trim even when it carries a
 * screenshot: the model needs to know what the current turn was doing, and a
 * dropped image is cheaper than a dropped turn.
 */
function degradeMessageMedia(message: AnthropicMessage): AnthropicMessage {
  if (!Array.isArray(message.content)) return message
  const degradeBlocks = (blocks: unknown[]): unknown[] => blocks.map(block => {
    if (!block || typeof block !== 'object') return block
    const record = block as Record<string, unknown>
    if (record.type === 'image' || record.type === 'document') {
      return { type: 'text', text: `[${String(record.type)} omitted to fit provider request limit]` }
    }
    if (record.type === 'tool_result' && Array.isArray(record.content)) {
      return { ...record, content: degradeBlocks(record.content) }
    }
    return block
  })
  return { ...message, content: degradeBlocks(message.content) as AnthropicMessage['content'] }
}

/** Plain text of a real user message, ignoring attachments and media. */
function userMessageText(message: AnthropicMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Collapse the real user messages that fell outside the kept window into one
 * short user message. The model keeps the user's authorizations and task
 * switches even though the tool trail that carried them is gone.
 *
 * Only the newest {@link EARLIER_INSTRUCTION_LIMIT} are kept, each clipped to
 * {@link EARLIER_INSTRUCTION_CHARS}, and the whole list is clamped to
 * {@link EARLIER_INSTRUCTION_BUDGET_BYTES}.
 */
function messageSummaryText(message: AnthropicMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'tool_use') {
      let args = ''
      try {
        args = JSON.stringify(block.input)
      } catch {
        // Circular tool input: summarize the call without its arguments.
      }
      parts.push(`[tool_use ${block.name}${args ? ` ${args}` : ''}]`)
    } else if (block.type === 'tool_result') {
      const content = block.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter(part => part.type === 'text').map(part => part.text).join('')
          : ''
      parts.push(`[tool_result ${text}]`)
    }
  }
  return parts.join(' ')
}

/**
 * Summarize the messages that fell outside the recent window into one short
 * user message: tool names, arguments and the head of each output, newest
 * entries kept first. The model keeps a coarse memory of the work instead of
 * losing it entirely, without spending a second upstream request.
 */
function buildCompactedActivity(
  messages: AnthropicMessage[],
  start: number,
  anchorIndex: number,
  budgetBytes: number,
): AnthropicMessage | null {
  if (start <= 0 || budgetBytes <= 0) return null
  const header = '[Compacted earlier activity retained for continuity]'
  const entries: string[] = []
  let used = textBytes(header)
  for (let index = start - 1; index >= 0; index -= 1) {
    if (index === anchorIndex) continue
    // Real user messages are carried by the earlier-instructions list.
    if (isRealUserMessage(messages[index])) continue
    const text = messageSummaryText(messages[index]).trim()
    if (!text) continue
    const entry = text.length > COMPACTED_ENTRY_CHARS
      ? `${text.slice(0, COMPACTED_ENTRY_CHARS)}…`
      : text
    const size = textBytes(entry)
    if (used + size > budgetBytes && entries.length > 0) break
    entries.push(entry)
    used += size
    if (used >= budgetBytes) break
  }
  if (entries.length === 0) return null
  entries.reverse()
  const render = (): string => `${header}\n${entries.map(entry => `- ${entry}`).join('\n')}`
  let content = render()
  // The per-entry "- " prefix and newlines are not in the accumulator; drop the
  // oldest entries until the rendered digest itself fits.
  while (entries.length > 1 && textBytes(content) > budgetBytes) {
    entries.shift()
    content = render()
  }
  return { role: 'user', content }
}

function buildEarlierInstructions(
  messages: AnthropicMessage[],
  start: number,
  anchorIndex: number,
): AnthropicMessage | null {
  const picked: string[] = []
  for (let index = start - 1; index >= 0; index -= 1) {
    if (index === anchorIndex) continue
    if (!isUserInstructionMessage(messages[index])) continue
    const text = userMessageText(messages[index]).trim()
    if (!text) continue
    picked.push(
      text.length > EARLIER_INSTRUCTION_CHARS
        ? `${text.slice(0, EARLIER_INSTRUCTION_CHARS)}…`
        : text,
    )
    if (picked.length >= EARLIER_INSTRUCTION_LIMIT) break
  }
  if (picked.length === 0) return null
  picked.reverse()

  const header = '[Earlier user instructions retained for continuity]'
  const render = (items: string[]): string => `${header}\n${items.map(text => `- ${text}`).join('\n')}`

  // Clamp in UTF-8 bytes; the reserve was sized in the same unit. Drop the
  // oldest entries first: the newest authorization is the one that matters.
  let content = render(picked)
  while (picked.length > 1 && textBytes(content) > EARLIER_INSTRUCTION_BUDGET_BYTES) {
    picked.shift()
    content = render(picked)
  }
  if (!content.trim()) return null
  return { role: 'user', content }
}

function totalBytes(messages: AnthropicMessage[]): number {
  let total = 0
  for (const message of messages) total += messageBytes(message)
  return total
}

/** Collect the tool_use ids that survive in the kept window. */
function collectToolUseIds(messages: AnthropicMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') ids.add(block.id)
    }
  }
  return ids
}

/** Collect the tool_use ids that have a result in the kept window. */
function collectToolResultIds(messages: AnthropicMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_result') ids.add(block.tool_use_id)
    }
  }
  return ids
}

/**
 * Keep only complete tool round-trips in the kept window.
 *
 * Anthropic rejects an orphan tool_result, and the Responses converter turns
 * it into an orphan `function_call_output` that the relay rejects too. The
 * reverse also fails upstream: a `function_call` with no output (an
 * interrupted or still-running call) is refused by the relay. Drop both
 * halves that lost their partner.
 *
 * The cut can orphan results in the middle of the window, not only at its
 * start: Claude Code may record consecutive assistant tool_use messages and
 * merge their results into one later user message, so the window can begin at
 * the assistant whose result list also covers calls left behind.
 */
function repairOrphanToolResults(kept: AnthropicMessage[]): AnthropicMessage[] {
  const toolUseIds = collectToolUseIds(kept)
  const toolResultIds = collectToolResultIds(kept)
  const repaired: AnthropicMessage[] = []
  for (const message of kept) {
    if (!Array.isArray(message.content)) {
      repaired.push(message)
      continue
    }
    const filtered = message.content.filter(block => {
      if (block.type === 'tool_result') return toolUseIds.has(block.tool_use_id)
      if (block.type === 'tool_use') return toolResultIds.has(block.id)
      return true
    })
    if (filtered.length === message.content.length) {
      repaired.push(message)
      continue
    }
    // A carrier whose only content was orphaned blocks disappears entirely.
    if (filtered.length === 0) continue
    repaired.push({ ...message, content: filtered })
  }
  return repaired
}

/**
 * Move the window start back over leading tool-result carriers so a tool_use is
 * never cut away from its result. Returns the adjusted start.
 */
function alignToToolBoundary(messages: AnthropicMessage[], start: number): number {
  let aligned = start
  while (
    aligned > 0
    && messages[aligned].role === 'user'
    && isToolResultMessage(messages[aligned])
  ) {
    aligned -= 1
  }
  return aligned
}

/**
 * Cut the history down to the newest messages that fit in `budgetBytes`,
 * keeping tool calls paired and the task anchor in place when it fits.
 */
function trimToByteBudget(
  messages: AnthropicMessage[],
  budgetBytes: number,
): AnthropicMessage[] | null {
  const anchorIndex = messages.findIndex(isRealUserMessage)
  const anchor = anchorIndex >= 0 ? messages[anchorIndex] : null
  const anchorBytes = anchor ? messageBytes(anchor) : 0
  // An anchor that eats a quarter of the budget would leave too little room for
  // the recent turns; drop it instead of trading the live context for the task
  // statement.
  const anchorFits = anchor !== null && anchorBytes <= budgetBytes / 4

  // Earlier user messages are cheap and carry authorizations/task switches;
  // reserve their list up front so the window never crowds it out.
  const hasEarlierUser = messages.some(
    (message, index) => index !== anchorIndex && isUserInstructionMessage(message),
  )
  const earlierReserve = hasEarlierUser ? EARLIER_INSTRUCTION_BUDGET_BYTES : 0

  // The newest message can carry a screenshot larger than the whole budget.
  // Keep the turn (and its tool calls/results) by degrading its media rather
  // than refusing to trim at all.
  let source = messages
  let degradedLatest = false
  if (messageBytes(messages[messages.length - 1]) > budgetBytes) {
    const degraded = degradeMessageMedia(messages[messages.length - 1])
    if (messageBytes(degraded) > budgetBytes) return null
    source = [...messages.slice(0, -1), degraded]
    degradedLatest = true
  }

  // Reserve the anchor, earlier-instruction and compacted-activity shares up
  // front so the recent window never crowds them out.
  let used = (anchorFits ? anchorBytes : 0) + earlierReserve + COMPACTED_ACTIVITY_BUDGET_BYTES
  let start = source.length
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (index === anchorIndex) break
    const size = messageBytes(source[index])
    if (used + size > budgetBytes) {
      // The newest single message alone exceeds the budget even after media
      // degradation: no trim can make this request fit.
      if (start === source.length) return null
      break
    }
    used += size
    start = index
  }
  if (start >= source.length) return null

  start = alignToToolBoundary(source, start)
  let kept = source.slice(start)
  kept = repairOrphanToolResults(kept)

  const prefix: AnthropicMessage[] = []
  if (anchor && anchorFits && anchorIndex < start) {
    prefix.push(anchor)
  }
  const earlier = hasEarlierUser
    ? buildEarlierInstructions(messages, start, anchorIndex)
    : null
  if (earlier) prefix.push(earlier)
  const compacted = buildCompactedActivity(
    messages,
    start,
    anchorIndex,
    Math.min(
      COMPACTED_ACTIVITY_BUDGET_BYTES,
      Math.max(0, budgetBytes - totalBytes(prefix) - totalBytes(kept)),
    ),
  )
  if (compacted) prefix.push(compacted)
  if (prefix.length > 0) kept = [...prefix, ...kept]

  if (kept.length === 0) return null
  // A media-degraded latest message is a real change even when every message
  // fits the window; returning null there would skip the retry that the
  // degradation exists to make possible.
  if (!degradedLatest && kept.length >= messages.length) return null

  // Alignment and the anchor can push a borderline window over the budget;
  // retrying with it would just be refused again. Allow the small overrun a
  // single aligned message introduces, nothing more.
  if (totalBytes(kept) > budgetBytes * 1.1) return null
  return kept
}

/**
 * Cut the history down to the newest `maxUserMessages` real user messages,
 * keeping tool calls paired. Used for the relay's 20-user-turn path, where only
 * `role:"user"` messages count.
 */
function trimToUserTurnLimit(
  messages: AnthropicMessage[],
  maxUserMessages: number,
): AnthropicMessage[] | null {
  const limit = Math.max(1, maxUserMessages)
  let seen = 0
  let start = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRealUserMessage(messages[index])) {
      seen += 1
      if (seen > limit) break
      start = index
    }
  }
  if (start === 0 || start >= messages.length) return null

  start = alignToToolBoundary(messages, start)
  let kept = messages.slice(start)
  kept = repairOrphanToolResults(kept)
  if (kept.length === 0 || kept.length >= messages.length) return null
  return kept
}

/**
 * Return a shorter request body for a `session_turn_limit_exceeded` refusal, or
 * `null` when there is nothing safe to trim.
 *
 * `errText` selects the cap: the user-turn wording trims user messages, the
 * size wording trims by the measured byte budget. When the reported user-turn
 * count is already under the limit, the size path is used instead — that is the
 * shape a real CLI request has (tools/instructions present).
 */
export function trimHistoryForTurnLimit(
  body: AnthropicRequest,
  errText: string,
  options: { budgetBytes?: number | null } = {},
): AnthropicRequest | null {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return null

  const parsed = parseTurnLimit(errText)

  if (parsed.kind === 'user-turns') {
    const limit = parsed.limit ?? USER_TURN_LIMIT
    const userTurns = messages.filter(isRealUserMessage).length
    if (userTurns >= limit) {
      const trimmed = trimToUserTurnLimit(messages, limit - 1)
      if (trimmed) return { ...body, messages: trimmed }
    }
  }

  const trimmed = trimToByteBudget(messages, resolveTurnLimitBudgetBytes(options.budgetBytes))
  if (!trimmed) return null
  return { ...body, messages: trimmed }
}