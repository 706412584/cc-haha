import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  subagentsApi,
  type SubagentRunResponse,
  type SubagentRunStatus,
} from '../api/subagents'
import { buildRenderModel, MessageBlock } from '../components/chat/MessageList'
import { ToolCallGroup } from '../components/chat/ToolCallGroup'
import { useTranslation } from '../i18n'
import { mapHistoryMessagesToUiMessages } from '../stores/chatStore'
import type { AgentTaskNotification, UIMessage } from '../types/chat'

type TranslationFn = ReturnType<typeof useTranslation>
const LIVE_RUN_REFRESH_MS = 2000

export function SubagentRunPage({
  sourceSessionId,
  toolUseId,
  title,
}: {
  sourceSessionId: string
  toolUseId: string
  title: string
}) {
  const t = useTranslation()
  const [data, setData] = useState<SubagentRunResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const load = useCallback(async (options?: { resetData?: boolean }) => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    setError(null)
    if (options?.resetData) setData(null)
    try {
      const nextData = await subagentsApi.getRunByTool(sourceSessionId, toolUseId)
      if (requestIdRef.current !== requestId) return
      setData(nextData)
    } catch (err) {
      if (requestIdRef.current !== requestId) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestIdRef.current !== requestId) return
      setLoading(false)
    }
  }, [sourceSessionId, toolUseId])

  useEffect(() => {
    void load({ resetData: true })
  }, [load])

  useEffect(() => {
    if (data?.status !== 'running' || loading) return

    const timer = window.setTimeout(() => {
      void load()
    }, LIVE_RUN_REFRESH_MS)

    return () => window.clearTimeout(timer)
  }, [data?.status, load, loading])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate text-sm font-semibold text-[var(--color-text-primary)]">{title}</h1>
            {data ? <StatusBadge status={data.status} t={t} /> : null}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
            {sourceSessionId} / {toolUseId}
          </p>
        </div>
        <button
          type="button"
          aria-label={t('subagentRun.refresh')}
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw size={15} strokeWidth={2.2} aria-hidden="true" className={loading ? 'animate-spin' : undefined} />
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading && !data ? (
          <div role="status" className="text-sm text-[var(--color-text-tertiary)]">{t('subagentRun.loading')}</div>
        ) : null}
        {error ? (
          <div role="alert" className="rounded-[var(--radius-md)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 px-3 py-2 text-sm text-[var(--color-error)]">
            {error}
          </div>
        ) : null}
        {data ? (
          <SubagentRunDetails data={data} />
        ) : null}
      </main>
    </div>
  )
}

function SubagentRunDetails({ data }: { data: SubagentRunResponse }) {
  const t = useTranslation()

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
        <span>{t('subagentRun.source')}: {sourceLabel(data.source, t)}</span>
        <span aria-hidden="true">/</span>
        <span>{t('subagentRun.agent')}: {data.agentId ?? t('subagentRun.unknown')}</span>
        {data.description ? (
          <>
            <span aria-hidden="true">/</span>
            <span>{data.description}</span>
          </>
        ) : null}
        {data.taskId ? (
          <>
            <span aria-hidden="true">/</span>
            <span>{t('subagentRun.task')}: {data.taskId}</span>
          </>
        ) : null}
        <span aria-hidden="true">/</span>
        <span>{t('subagentRun.updated')}: {formatTimestamp(data.updatedAt)}</span>
        {data.usage?.totalTokens ? (
          <>
            <span aria-hidden="true">/</span>
            <span>{t('common.tokens', { count: formatNumber(data.usage.totalTokens) })}</span>
          </>
        ) : null}
        {data.outputFile ? (
          <>
            <span aria-hidden="true">/</span>
            <span className="min-w-0 truncate font-mono" title={data.outputFile}>{t('subagentRun.output')}: {data.outputFile}</span>
          </>
        ) : null}
      </div>

      <ConversationSection data={data} />
    </div>
  )
}

const EMPTY_AGENT_TASK_NOTIFICATIONS: Record<string, AgentTaskNotification> = {}

function ConversationSection({ data }: { data: SubagentRunResponse }) {
  const t = useTranslation()
  const conversationMessages = useMemo(() => buildSubagentConversationMessages(data), [data])
  const renderModel = useMemo(() => buildRenderModel(conversationMessages), [conversationMessages])

  if (renderModel.renderItems.length === 0) {
    return (
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-normal text-[var(--color-text-tertiary)]">{t('subagentRun.transcript')}</h2>
        <div className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-tertiary)]">
          {t('subagentRun.noTranscript')}
        </div>
      </section>
    )
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-normal text-[var(--color-text-tertiary)]">{t('subagentRun.transcript')}</h2>
        {data.truncated ? (
          <span className="text-[11px] text-[var(--color-text-tertiary)]">{t('subagentRun.truncated')}</span>
        ) : null}
      </div>
      <div data-testid="subagent-conversation" className="space-y-3">
        {renderModel.renderItems.map((item) => {
          if (item.kind === 'tool_group') {
            return (
              <ToolCallGroup
                key={item.id}
                toolCalls={item.toolCalls}
                resultMap={renderModel.toolResultMap}
                childToolCallsByParent={renderModel.childToolCallsByParent}
                agentTaskNotifications={EMPTY_AGENT_TASK_NOTIFICATIONS}
                showOpenRun={false}
                isStreaming={false}
              />
            )
          }

          const toolResult = item.message.type === 'tool_use'
            ? renderModel.toolResultMap.get(item.message.toolUseId)
            : null

          return (
            <MessageBlock
              key={item.message.id}
              message={item.message}
              activeThinkingId={null}
              agentTaskNotifications={EMPTY_AGENT_TASK_NOTIFICATIONS}
              toolResult={toolResult}
            />
          )
        })}
      </div>
    </section>
  )
}

function StatusBadge({ status, t }: { status: SubagentRunStatus; t: TranslationFn }) {
  return (
    <span className={`rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-normal ${statusToneClass(status)}`}>
      {getSubagentStatusLabel(status, t)}
    </span>
  )
}

function statusToneClass(status: SubagentRunStatus) {
  if (status === 'completed') {
    return 'border-[var(--color-success)]/25 bg-[var(--color-success)]/10 text-[var(--color-success)]'
  }
  if (status === 'failed' || status === 'stopped') {
    return 'border-[var(--color-error)]/30 bg-[var(--color-error)]/5 text-[var(--color-error)]'
  }
  if (status === 'running') {
    return 'border-[var(--color-brand)]/25 bg-[var(--color-brand)]/10 text-[var(--color-brand)]'
  }
  return 'border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-text-tertiary)]'
}

function sourceLabel(source: SubagentRunResponse['source'], t: TranslationFn) {
  if (source === 'subagent-jsonl') return t('subagentRun.source.transcript')
  if (source === 'session-history') return t('subagentRun.source.sessionHistory')
  if (source === 'live-task') return t('subagentRun.source.liveTask')
  return t('subagentRun.source.none')
}

function getSubagentStatusLabel(status: SubagentRunStatus, t: TranslationFn) {
  switch (status) {
    case 'completed':
      return t('subagentRun.status.completed')
    case 'failed':
      return t('subagentRun.status.failed')
    case 'stopped':
      return t('subagentRun.status.stopped')
    case 'running':
      return t('subagentRun.status.running')
    case 'unknown':
      return t('subagentRun.status.unknown')
  }
}

function formatNumber(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '-'
}

function formatTimestamp(value: string | undefined) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function timestampMs(value: string | undefined) {
  if (!value) return Date.now()
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : Date.now()
}

function normalizedText(value: string | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function hasPromptMessage(messages: UIMessage[], prompt: string) {
  const normalizedPrompt = normalizedText(prompt)
  if (!normalizedPrompt) return false

  return messages.some((message) => (
    message.type === 'user_text' &&
    normalizedText(message.content) === normalizedPrompt
  ))
}

function buildSubagentConversationMessages(data: SubagentRunResponse): UIMessage[] {
  const transcriptMessages = mapHistoryMessagesToUiMessages(data.messages, { includeTeammateMessages: true })
  const messages = [...transcriptMessages]
  const prompt = data.prompt?.trim()
  const baseTimestamp = timestampMs(data.updatedAt)

  if (prompt && !hasPromptMessage(transcriptMessages, prompt)) {
    messages.unshift({
      id: `subagent-prompt-${data.toolUseId}`,
      type: 'user_text',
      content: prompt,
      timestamp: baseTimestamp - 1,
    })
  }

  const resultText = (data.result || data.summary)?.trim()
  if (transcriptMessages.length === 0 && resultText) {
    messages.push({
      id: `subagent-result-message-${data.toolUseId}`,
      type: 'assistant_text',
      content: resultText,
      timestamp: baseTimestamp,
    })
  }

  return messages
}
