import { api } from './client'
import type { MessageEntry } from '../types/session'

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

export const subagentsApi = {
  getRunByTool(sessionId: string, toolUseId: string) {
    return api.get<SubagentRunResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/subagents/by-tool/${encodeURIComponent(toolUseId)}`,
    )
  },
}
