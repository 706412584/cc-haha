import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  subagentsApi,
  type SubagentRunResponse,
  type SubagentRunStatus,
} from '../api/subagents'
import { buildRenderModel, MessageBlock } from '../components/chat/MessageList'
import { ToolCallGroup } from '../components/chat/ToolCallGroup'
import { Badge, type Tone as BadgeTone } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../i18n'
import { mapHistoryMessagesToUiMessages, useChatStore } from '../stores/chatStore'
import type { AgentTaskNotification, UIMessage } from '../types/chat'

type TranslationFn = ReturnType<typeof useTranslation>
const LIVE_RUN_REFRESH_MS = 2000

export function SubagentRunPage({
  sourceSessionId,
  toolUseId,
  taskId,
  title,
}: {
  sourceSessionId: string
  toolUseId: string
  taskId?: string
  title: string
}) {
  const t = useTranslation()
  const [data, setData] = useState<SubagentRunResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const discoveredTaskId = useChatStore((state) => {
    const session = state.sessions[sourceSessionId]
    const liveTask = Object.values(session?.backgroundAgentTasks ?? {})
      .find((candidate) => candidate.toolUseId === toolUseId)
    return liveTask?.taskId ?? session?.agentTaskNotifications?.[toolUseId]?.taskId
  })
  const resolvedTaskId = taskId ?? discoveredTaskId

  const load = useCallback(async (options?: { resetData?: boolean }) => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    setError(null)
    if (options?.resetData) setData(null)
    try {
      const nextData = await subagentsApi.getRunByTool(sourceSessionId, toolUseId, resolvedTaskId)
      if (requestIdRef.current !== requestId) return
      setData(nextData)
    } catch (err) {
      if (requestIdRef.current !== requestId) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestIdRef.current !== requestId) return
      setLoading(false)
    }
  }, [resolvedTaskId, sourceSessionId, toolUseId])

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
            <h1
              className="min-w-0 truncate text-[16.5px] font-semibold leading-tight text-[var(--color-text-primary)]"
              style={{ fontFamily: 'var(--font-headline)' }}
            >
              {title}
            </h1>
            {data ? <StatusBadge status={data.status} t={t} /> : null}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
            {sourceSessionId} / {toolUseId}
          </p>
        </div>
        {/* The icon spins in place while loading rather than using IconButton's
            `loading` prop, which would swap RefreshCw for the generic Spinner. */}
        <IconButton
          icon={<RefreshCw size={15} strokeWidth={2.2} aria-hidden="true" className={loading ? 'animate-spin' : undefined} />}
          label={t('subagentRun.refresh')}
          showTooltip={false}
          size="md"
          tone="muted"
          onClick={() => void load()}
          disabled={loading}
        />
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading && !data ? (
          <div role="status" className="text-sm text-[var(--color-text-tertiary)]">{t('subagentRun.loading')}</div>
        ) : null}
        {error ? (
          <div role="alert" className="rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3 py-2 text-sm text-[var(--color-on-error-container)]">
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
            <span>{t('subagentRun.task')}: <span className="font-mono">{data.taskId}</span></span>
          </>
        ) : null}
        <span aria-hidden="true">/</span>
        <span>{t('subagentRun.updated')}: <span className="font-mono tabular-nums">{formatTimestamp(data.updatedAt)}</span></span>
        {data.usage?.totalTokens ? (
          <>
            <span aria-hidden="true">/</span>
            <span className="font-mono tabular-nums">{t('common.tokens', { count: formatNumber(data.usage.totalTokens) })}</span>
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
        <h2
          className="mb-2 text-[13.5px] font-semibold text-[var(--color-text-secondary)]"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          {t('subagentRun.transcript')}
        </h2>
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-tertiary)]">
          {t('subagentRun.noTranscript')}
        </div>
      </section>
    )
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2
          className="text-[13.5px] font-semibold text-[var(--color-text-secondary)]"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          {t('subagentRun.transcript')}
        </h2>
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
    <Badge tone={statusTone(status)} size="xs" bordered>
      {getSubagentStatusLabel(status, t)}
    </Badge>
  )
}

function statusTone(status: SubagentRunStatus): BadgeTone {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'stopped') return 'danger'
  if (status === 'running') return 'brand'
  return 'neutral'
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
