import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation, type TranslationKey } from '../../i18n'
import { formatTokenCount } from '../../lib/formatTokenCount'
import { formatDurationSeconds } from '../../lib/backgroundTasks'

function translateServerVerb(
  t: (key: TranslationKey) => string,
  verb: string,
): string {
  const key = `serverVerb.${verb}` as TranslationKey
  const translated = t(key)
  return translated === key ? verb : translated
}

function formatRetrySeconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000))
}

function formatErrorType(errorType: string | undefined): string | null {
  if (!errorType) return null
  return errorType
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function StreamingIndicator() {
  const t = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
  const chatState = sessionState?.chatState ?? 'idle'
  const statusVerb = sessionState?.statusVerb ?? ''
  const apiRetry = sessionState?.apiRetry ?? null
  const streamingFallback = sessionState?.streamingFallback ?? null
  const elapsedSeconds = sessionState?.elapsedSeconds ?? 0
  // chars ÷ 4 estimates output tokens for this turn, mirroring the CLI spinner.
  const streamingTokens = Math.round((sessionState?.streamingResponseChars ?? 0) / 4)

  useEffect(() => {
    if (!apiRetry) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [apiRetry?.receivedAt, apiRetry?.retryDelayMs])

  if (apiRetry) {
    const remainingMs = Math.max(0, apiRetry.retryDelayMs - (now - apiRetry.receivedAt))
    const statusText = apiRetry.errorStatus !== null
      ? t('chat.retry.httpStatus', { status: apiRetry.errorStatus })
      : formatErrorType(apiRetry.errorType) ?? t('chat.retry.networkError')
    const detailText = apiRetry.errorMessage?.trim()

    return (
      <div
        data-testid="api-retry-indicator"
        role="status"
        aria-live="polite"
        className="mb-2 flex w-full max-w-[min(720px,100%)] flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-2 text-xs text-[var(--color-on-warning-container)] shadow-[var(--shadow-card)]"
      >
        <RefreshCw size={14} strokeWidth={2.2} className="shrink-0 animate-spin text-[var(--color-warning)]" aria-hidden="true" />
        <span className="font-medium">{t('chat.retry.title')}</span>
        {/*
          Neutral rather than `tone="warning"`: these chips sit on the warning
          container itself, so a warning-tinted chip would disappear into it,
          and the warning accent as foreground on that fill measures 2.66:1 in
          the light theme (see components/AGENTS.md §3.2).
        */}
        <Badge mono pill={false} bordered className="leading-none">
          {t('chat.retry.attempt', { attempt: apiRetry.attempt, max: apiRetry.maxRetries })}
        </Badge>
        <Badge mono pill={false} bordered className="leading-none">
          {statusText}
        </Badge>
        <span>
          {remainingMs > 0
            ? t('chat.retry.waiting', { seconds: formatRetrySeconds(remainingMs) })
            : t('chat.retry.retrying')}
        </span>
        {detailText && (
          <span className="min-w-0 max-w-full truncate opacity-80" title={detailText}>
            {detailText}
          </span>
        )}
      </div>
    )
  }

  if (streamingFallback) {
    // 预期内的降级等待（非错误）：非流式响应一次性返回，期间无增量输出。
    // 用中性样式的轻提示 + 回合计时，与 api_retry 的警示横幅区分开。
    return (
      <div
        data-testid="streaming-fallback-indicator"
        role="status"
        aria-live="polite"
        className="mb-2 flex w-fit items-center gap-[9px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 py-2 text-[13.5px] text-[var(--color-text-secondary)]"
      >
        <RefreshCw size={13} strokeWidth={2.2} className="shrink-0 animate-spin text-[var(--color-text-secondary)]" aria-hidden="true" />
        <span className="font-medium text-[var(--color-text-primary)]">
          {t('chat.fallback.title')}
        </span>
        <span className="text-[12.5px] text-[var(--color-text-tertiary)]">
          {t('chat.fallback.detail')}
        </span>
        {elapsedSeconds > 0 && (
          <span className="text-[12.5px] text-[var(--color-text-tertiary)]">
            {formatDurationSeconds(elapsedSeconds, t)}
          </span>
        )}
      </div>
    )
  }

  let verb: string
  if (statusVerb) {
    verb = translateServerVerb(t, statusVerb)
  } else {
    verb = chatState === 'thinking'
      ? t('serverVerb.Thinking')
      : chatState === 'compacting'
        ? t('serverVerb.Compacting conversation')
      : chatState === 'tool_executing'
        ? t('serverVerb.Running')
        : t('serverVerb.Working')
  }

  return (
    <div className="mb-2 flex w-fit items-center gap-[9px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 py-2 text-[13.5px] text-[var(--color-text-secondary)]">
      <span className="animate-pulse-dot text-[var(--color-brand)]" aria-hidden="true">✦</span>
      <span className="font-medium text-[var(--color-text-primary)]">{verb}...</span>
      {elapsedSeconds > 0 && (
        <span>{formatDurationSeconds(elapsedSeconds, t)}</span>
      )}
      {streamingTokens > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-[12.5px]">
            ↓ {t('common.tokens', { count: formatTokenCount(streamingTokens) })}
          </span>
        </>
      )}
    </div>
  )
}
