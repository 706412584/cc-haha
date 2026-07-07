import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/xml.js'

type TaskNotificationStatus = 'completed' | 'failed' | 'stopped'

export type ParsedTaskNotification = {
  taskId: string
  toolUseId?: string
  taskType?: string
  outputFile: string
  status?: TaskNotificationStatus
  summary: string
  result?: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
}

function getTagValue(text: string, tag: string): string | undefined {
  return text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]
}

function normalizeStatus(rawStatus: string | undefined): TaskNotificationStatus | undefined {
  if (rawStatus === 'killed') return 'stopped'
  if (rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped') {
    return rawStatus
  }
  return undefined
}

export function parseTaskNotificationXml(text: string): ParsedTaskNotification {
  const usageContent = getTagValue(text, 'usage') ?? ''
  const totalTokens = getTagValue(usageContent, 'total_tokens')
  const toolUses = getTagValue(usageContent, 'tool_uses')
  const durationMs = getTagValue(usageContent, 'duration_ms')

  return {
    taskId: getTagValue(text, TASK_ID_TAG) ?? '',
    toolUseId: getTagValue(text, TOOL_USE_ID_TAG),
    taskType: getTagValue(text, TASK_TYPE_TAG),
    outputFile: getTagValue(text, OUTPUT_FILE_TAG) ?? '',
    status: normalizeStatus(getTagValue(text, STATUS_TAG)),
    summary: getTagValue(text, SUMMARY_TAG) ?? '',
    result: getTagValue(text, 'result'),
    usage:
      totalTokens && toolUses
        ? {
            total_tokens: parseInt(totalTokens, 10),
            tool_uses: parseInt(toolUses, 10),
            duration_ms: durationMs ? parseInt(durationMs, 10) : 0,
          }
        : undefined,
  }
}

export function shouldForwardTaskNotificationToModel(
  _notification: ParsedTaskNotification,
  _options: { structuredOutput: boolean },
): boolean {
  return true
}
