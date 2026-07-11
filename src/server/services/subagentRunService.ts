import {
  sessionService,
  type MessageEntry,
  type MessageUsage,
  type SessionTaskNotification,
} from './sessionService.js'

export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'
export type SubagentRunSource = 'subagent-jsonl' | 'session-history' | 'live-task' | 'none'

export type SubagentRunUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type SubagentRunResponse = {
  sessionId: string
  toolUseId: string
  agentId: string | null
  taskId?: string
  status: SubagentRunStatus
  description?: string
  prompt?: string
  summary?: string
  result?: string
  outputFile?: string
  usage?: SubagentRunUsage
  messages: MessageEntry[]
  truncated: boolean
  updatedAt?: string
  source: SubagentRunSource
}

export type SubagentRunResolution = {
  agentId: string | null
  description?: string
  prompt?: string
  result?: string
  usage?: SubagentRunUsage
  updatedAt?: string
  hasResult: boolean
  isError: boolean
}

type ContentBlock = {
  type?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  text?: unknown
  is_error?: unknown
}

type MessageEntryLike = {
  type?: string
  content?: unknown
  timestamp?: string
  usage?: MessageUsage
  message?: {
    role?: string
    content?: unknown
    usage?: MessageUsage
  }
}

type TruncateResult = {
  messages: MessageEntry[]
  truncated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function contentFromMessage(entry: MessageEntryLike): unknown {
  return entry.content ?? entry.message?.content
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter(isRecord) as ContentBlock[]
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (!isRecord(block)) return ''
      if (typeof block.text === 'string') return block.text
      if ('content' in block) return textFromContent(block.content)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractAgentId(text: string): string | null {
  return text.match(/(?:^|\n)\s*agentId:\s*([A-Za-z0-9_-]+)/)?.[1] ?? null
}

function cleanedAgentResultText(text: string): string | undefined {
  const cleaned = text
    .replace(/<usage>[\s\S]*?<\/usage>/gi, '')
    .split('\n')
    .filter((line) => !/^\s*agentId:\s*[A-Za-z0-9_-]+/.test(line))
    .join('\n')
    .trim()

  return cleaned || undefined
}

function readNumberValue(text: string, keys: string[]): number | undefined {
  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tagMatch = text.match(new RegExp(`<${escapedKey}>\\s*(\\d+)\\s*<\\/${escapedKey}>`, 'i'))
    if (tagMatch?.[1]) return Number.parseInt(tagMatch[1], 10)

    const lineMatch = text.match(new RegExp(`(?:^|\\n)\\s*${escapedKey}\\s*[:=]\\s*(\\d+)`, 'i'))
    if (lineMatch?.[1]) return Number.parseInt(lineMatch[1], 10)
  }
  return undefined
}

function normalizeUsage(usage: SubagentRunUsage): SubagentRunUsage | undefined {
  const normalized: SubagentRunUsage = {}

  if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) {
    normalized.inputTokens = usage.inputTokens
  }
  if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
    normalized.outputTokens = usage.outputTokens
  }
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
    normalized.totalTokens = usage.totalTokens
  } else if (
    typeof normalized.inputTokens === 'number' &&
    typeof normalized.outputTokens === 'number'
  ) {
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function extractUsage(text: string): SubagentRunUsage | undefined {
  const usageText = text.match(/<usage>([\s\S]*?)<\/usage>/i)?.[1] ?? text
  return normalizeUsage({
    inputTokens: readNumberValue(usageText, ['input_tokens', 'inputTokens']),
    outputTokens: readNumberValue(usageText, ['output_tokens', 'outputTokens']),
    totalTokens: readNumberValue(usageText, ['total_tokens', 'totalTokens']),
  })
}

function mergeUsage(
  preferred: SubagentRunUsage | undefined,
  fallback: SubagentRunUsage | undefined,
): SubagentRunUsage | undefined {
  if (!preferred) return fallback
  if (!fallback) return preferred

  return normalizeUsage({
    inputTokens: preferred.inputTokens ?? fallback.inputTokens,
    outputTokens: preferred.outputTokens ?? fallback.outputTokens,
    totalTokens: preferred.totalTokens ?? fallback.totalTokens,
  })
}

function usageFromTranscriptMessages(messages: unknown[]): SubagentRunUsage | undefined {
  let inputTokens: number | undefined
  let outputTokens: number | undefined

  for (const message of messages) {
    if (!isRecord(message) || !isRecord(message.usage)) continue
    if (typeof message.usage.input_tokens === 'number') {
      inputTokens = (inputTokens ?? 0) + message.usage.input_tokens
    }
    if (typeof message.usage.output_tokens === 'number') {
      outputTokens = (outputTokens ?? 0) + message.usage.output_tokens
    }
  }

  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return normalizeUsage({ inputTokens, outputTokens })
}

function latestTimestamp(...values: Array<string | undefined>): string | undefined {
  let latest: string | undefined
  let latestMs = Number.NEGATIVE_INFINITY

  for (const value of values) {
    if (!value) continue
    const time = Date.parse(value)
    if (!Number.isFinite(time) || time < latestMs) continue
    latest = value
    latestMs = time
  }

  return latest
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function resolveSubagentRunFromMessages(
  messages: MessageEntryLike[],
  toolUseId: string,
): SubagentRunResolution | null {
  let foundAgentToolUse = false
  let description: string | undefined
  let prompt: string | undefined
  let agentId: string | null = null
  let result: string | undefined
  let usage: SubagentRunUsage | undefined
  let updatedAt: string | undefined
  let hasResult = false
  let isError = false

  for (const entry of messages) {
    for (const block of contentBlocks(contentFromMessage(entry))) {
      if (
        block.type === 'tool_use' &&
        block.name === 'Agent' &&
        block.id === toolUseId
      ) {
        foundAgentToolUse = true
        updatedAt = latestTimestamp(updatedAt, entry.timestamp)
        const input = isRecord(block.input) ? block.input : {}
        description = stringField(input.description) ?? description
        prompt = stringField(input.prompt) ?? prompt
      }

      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
        hasResult = true
        isError = block.is_error === true || isError
        updatedAt = latestTimestamp(updatedAt, entry.timestamp)
        const text = textFromContent(block.content)
        agentId = extractAgentId(text) ?? agentId
        result = cleanedAgentResultText(text) ?? result
        usage = mergeUsage(extractUsage(text), usage)
      }
    }
  }

  if (!foundAgentToolUse) return null

  return {
    agentId,
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(result ? { result } : {}),
    ...(usage ? { usage } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    hasResult,
    isError,
  }
}

export function truncateSubagentMessages(messages: MessageEntry[]): TruncateResult {
  if (messages.length <= 1000) {
    return { messages, truncated: false }
  }

  return {
    messages: [...messages.slice(0, 50), ...messages.slice(-950)],
    truncated: true,
  }
}

function statusFromResolution(
  resolution: SubagentRunResolution,
  notification: SessionTaskNotification | undefined,
): SubagentRunStatus {
  if (resolution.isError) return 'failed'
  if (notification?.status) return notification.status
  if (resolution.hasResult) return 'completed'
  return 'running'
}

export async function getSubagentRunByTool(
  sessionId: string,
  toolUseId: string,
): Promise<SubagentRunResponse | null> {
  const [parentMessages, taskNotifications] = await Promise.all([
    sessionService.getSessionMessages(sessionId),
    sessionService.getSessionTaskNotifications(sessionId),
  ])
  const resolution = resolveSubagentRunFromMessages(parentMessages, toolUseId)
  if (!resolution) return null

  const notification = taskNotifications.find((candidate) => candidate.toolUseId === toolUseId)
  const transcriptMessages = resolution.agentId
    ? await sessionService.getSubagentTranscriptMessages(sessionId, resolution.agentId)
    : []
  const truncated = truncateSubagentMessages(transcriptMessages)
  const transcriptUsage = usageFromTranscriptMessages(transcriptMessages)
  const usage = mergeUsage(resolution.usage, transcriptUsage)
  const latestTranscriptTimestamp = latestTimestamp(
    ...transcriptMessages.map((message) => (
      isRecord(message) && typeof message.timestamp === 'string'
        ? message.timestamp
        : undefined
    )),
  )

  return {
    sessionId,
    toolUseId,
    agentId: resolution.agentId,
    ...(notification?.taskId ? { taskId: notification.taskId } : {}),
    status: statusFromResolution(resolution, notification),
    ...(resolution.description ? { description: resolution.description } : {}),
    ...(resolution.prompt ? { prompt: resolution.prompt } : {}),
    ...(notification?.summary ? { summary: notification.summary } : {}),
    ...(notification?.result || resolution.result
      ? { result: notification?.result || resolution.result }
      : {}),
    ...(notification?.outputFile ? { outputFile: notification.outputFile } : {}),
    ...(usage ? { usage } : {}),
    messages: truncated.messages,
    truncated: truncated.truncated,
    ...(latestTimestamp(resolution.updatedAt, notification?.timestamp, latestTranscriptTimestamp)
      ? { updatedAt: latestTimestamp(resolution.updatedAt, notification?.timestamp, latestTranscriptTimestamp) }
      : {}),
    source: transcriptMessages.length > 0 ? 'subagent-jsonl' : 'session-history',
  }
}
