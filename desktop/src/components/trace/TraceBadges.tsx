import type { ReactNode } from 'react'
import {
  AlertTriangle,
  Bot,
  CircleDot,
  Clock3,
  FileJson2,
  GitBranch,
  MessageSquareText,
  RadioTower,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { useTranslation } from '../../i18n'
import type { TraceSpan, TraceSpanStatus } from '../../lib/traceViewModel'

type TraceTranslator = ReturnType<typeof useTranslation>

export function TypeIcon({ span, size = 14 }: { span: TraceSpan; size?: number }) {
  const { icon, className } = iconForSpan(span, size)
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${className}`} aria-hidden="true">
      {icon}
    </span>
  )
}

/**
 * Three tiers of ink, so a glance at the timeline separates the model from
 * everything else: clay for LLM calls, secondary ink for content (messages,
 * tool invocations), tertiary for structure and lifecycle.
 *
 * The spec calls the message icons "blue-grey", but `--color-info` resolves to
 * the same clay as `--color-brand` in five of the six themes, which would erase
 * the LLM signal. Secondary ink is the closest thing that holds in all six.
 */
function iconForSpan(span: TraceSpan, size: number): { icon: ReactNode; className: string } {
  const tertiary = 'text-[var(--color-text-tertiary)]'
  const secondary = 'text-[var(--color-text-secondary)]'
  switch (span.kind) {
    case 'llm':
      return { icon: <Sparkles size={size} strokeWidth={2} />, className: 'text-[var(--color-brand)]' }
    case 'tool':
      return { icon: <Wrench size={size} strokeWidth={2} />, className: secondary }
    case 'tool_result':
      return { icon: <Wrench size={size} strokeWidth={2} />, className: tertiary }
    case 'turn':
      return { icon: <GitBranch size={size} strokeWidth={2} />, className: tertiary }
    case 'session':
      return { icon: <RadioTower size={size} strokeWidth={2} />, className: tertiary }
    case 'event':
      return span.status === 'error'
        ? { icon: <AlertTriangle size={size} strokeWidth={2} />, className: 'text-[var(--color-error)]' }
        : { icon: <CircleDot size={size} strokeWidth={2} />, className: tertiary }
    case 'message':
      if (span.message?.type === 'assistant') {
        return { icon: <Bot size={size} strokeWidth={2} />, className: secondary }
      }
      if (span.message?.type === 'system') {
        return { icon: <FileJson2 size={size} strokeWidth={2} />, className: tertiary }
      }
      return { icon: <MessageSquareText size={size} strokeWidth={2} />, className: secondary }
    default:
      return { icon: <FileJson2 size={size} strokeWidth={2} />, className: tertiary }
  }
}

export function StatusGlyph({ status }: { status: TraceSpanStatus }) {
  if (status === 'error') {
    return <AlertTriangle size={13} strokeWidth={2} className="shrink-0 text-[var(--color-error)]" aria-hidden="true" />
  }
  if (status === 'pending') {
    return <Clock3 size={13} strokeWidth={2} className="shrink-0 animate-pulse-dot text-[var(--color-warning)]" aria-hidden="true" />
  }
  return null
}

export function StatusPill({ status }: { status: TraceSpanStatus }) {
  const t = useTranslation()
  const tone = status === 'error' ? 'danger' : status === 'pending' ? 'warning' : 'success'
  const label = status === 'error'
    ? t('trace.status.error')
    : status === 'pending'
      ? t('trace.status.pending')
      : t('trace.status.ok')
  return <Badge tone={tone} size="sm" pill={false}>{label}</Badge>
}

export function MetaChip({
  label,
  value,
  tone = 'default',
  title,
}: {
  label: string
  value: string
  tone?: 'default' | 'danger'
  title?: string
}) {
  return (
    <span
      className="inline-flex min-w-0 items-baseline gap-1.5 text-[12.5px]"
      {...(title ? { title } : {})}
    >
      <span className="shrink-0 text-[var(--color-text-secondary)]">{label}</span>
      <span className={`truncate font-mono font-semibold ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>
        {value}
      </span>
    </span>
  )
}

/**
 * The live chip. The breathing dot lives beside it in the header (and carries
 * the health color), so this one is a plain tinted chip — two pulsing dots on
 * the same line read as two different signals.
 */
export function LiveBadge() {
  const t = useTranslation()
  return (
    <Badge tone="success" size="sm" pill={false}>
      {t('trace.live')}
    </Badge>
  )
}

export function spanDisplayTitle(span: TraceSpan, t: TraceTranslator): string {
  if (span.kind === 'message' && span.message) {
    switch (span.message.type) {
      case 'user': return t('trace.message.user')
      case 'assistant': return t('trace.message.assistant')
      case 'system': return t('trace.message.system')
      case 'tool_use': return t('trace.message.toolRequest')
      case 'tool_result': return t('trace.message.toolResult')
      default: return span.message.type
    }
  }
  if (span.kind === 'llm') {
    return span.call?.model ?? span.call?.provider?.name ?? t('trace.modelCall')
  }
  if (span.kind === 'tool') {
    return span.toolName ?? span.title
  }
  if (span.kind === 'tool_result') {
    return span.status === 'error' ? t('trace.toolError') : t('trace.toolResult')
  }
  if (span.kind === 'event' && span.event) {
    return traceEventPhaseLabel(span.event.phase, t)
  }
  if (span.kind === 'turn') {
    return turnDisplayTitle(span.title, (span.turnIndex ?? 0) + 1, t)
  }
  return span.title
}

export function turnDisplayTitle(title: string, oneBasedIndex: number, t: TraceTranslator): string {
  if (title === 'Session activity') return t('trace.sessionActivity')
  const match = title.match(/^Turn (\d+)$/)
  if (match) return t('trace.turnLabel', { index: match[1]! })
  if (!title.trim()) return t('trace.turnLabel', { index: oneBasedIndex })
  return title
}

export function traceEventPhaseLabel(phase: string, t: TraceTranslator): string {
  switch (phase) {
    case 'api_call_started': return t('trace.event.apiCallStarted')
    case 'api_call_completed': return t('trace.event.apiCallCompleted')
    case 'api_call_failed': return t('trace.event.apiCallFailed')
    case 'api_call_aborted': return t('trace.event.apiCallAborted')
    case 'response_capture_failed': return t('trace.event.responseCaptureFailed')
    case 'upstream_fetch_started': return t('trace.event.upstreamFetchStarted')
    case 'upstream_fetch_completed': return t('trace.event.upstreamFetchCompleted')
    case 'upstream_fetch_failed': return t('trace.event.upstreamFetchFailed')
    default:
      return phase
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
  }
}
