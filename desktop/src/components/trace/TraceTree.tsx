import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { SearchField } from '@/components/ui/SearchField'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useTranslation } from '../../i18n'
import { previewTraceValue, type TraceSpan, type TraceViewModel } from '../../lib/traceViewModel'
import { formatDurationMs } from '../../lib/trace/formatters'
import { StatusGlyph, TypeIcon, spanDisplayTitle, turnDisplayTitle } from './TraceBadges'

export type TraceTreeFilter = 'all' | 'llm' | 'tool' | 'error'

const TRACE_TREE_FILTERS: readonly TraceTreeFilter[] = ['all', 'llm', 'tool', 'error']

type TreeRow = {
  span: TraceSpan
  depth: number
}

type TreeGroup = {
  turnId: string
  turnSpan: TraceSpan
  rows: TreeRow[]
  errorCount: number
}

export function TraceTree({
  viewModel,
  selectedId,
  onSelect,
}: {
  viewModel: TraceViewModel
  selectedId: string | null
  onSelect: (spanId: string) => void
}) {
  const t = useTranslation()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TraceTreeFilter>('all')
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(
    () => buildTreeGroups(viewModel, filter, query),
    [viewModel, filter, query],
  )

  const navigableIds = useMemo(() => {
    const ids: string[] = []
    for (const group of groups) {
      ids.push(group.turnId)
      if (collapsedTurns.has(group.turnId)) continue
      for (const row of group.rows) ids.push(row.span.id)
    }
    return ids
  }, [groups, collapsedTurns])

  useEffect(() => {
    if (!selectedId) return
    const container = scrollRef.current
    if (!container) return
    const row = container.querySelector<HTMLElement>(`[data-span-id="${CSS.escape(selectedId)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (navigableIds.length === 0) return
    event.preventDefault()
    const currentIndex = selectedId ? navigableIds.indexOf(selectedId) : -1
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(navigableIds.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1)
    const nextId = navigableIds[nextIndex]
    if (nextId && nextId !== selectedId) onSelect(nextId)
  }

  const toggleTurn = (turnId: string) => {
    setCollapsedTurns((previous) => {
      const next = new Set(previous)
      if (next.has(turnId)) next.delete(turnId)
      else next.add(turnId)
      return next
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface-container-low)]" data-testid="trace-tree">
      <div className="shrink-0 border-b border-[var(--color-border)] px-4 pb-2.5 pt-3.5">
        <SearchField
          value={query}
          onChange={setQuery}
          label={t('trace.searchSpans')}
          // Without this the clear button falls back to the field's own name,
          // so both carry the same accessible label.
          clearLabel={t('common.clearSearch')}
          placeholder={t('trace.searchSpans')}
          size="md"
        />
        <SegmentedControl<TraceTreeFilter>
          items={TRACE_TREE_FILTERS.map((value) => ({ value, label: filterLabel(value, t) }))}
          value={filter}
          onChange={setFilter}
          label={t('trace.filter.aria')}
          size="sm"
          className="mt-2.5"
        />
      </div>
      <div
        ref={scrollRef}
        role="tree"
        aria-label={t('trace.tree.aria')}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto pb-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
      >
        {groups.length > 0 ? (
          groups.map((group) => (
            <TurnGroup
              key={group.turnId}
              group={group}
              collapsed={collapsedTurns.has(group.turnId)}
              selectedId={selectedId}
              onSelect={onSelect}
              onToggle={() => toggleTurn(group.turnId)}
            />
          ))
        ) : (
          <EmptyState description={t('trace.noMatchingSpans')} variant="plain" size="md" />
        )}
      </div>
    </div>
  )
}

function TurnGroup({
  group,
  collapsed,
  selectedId,
  onSelect,
  onToggle,
}: {
  group: TreeGroup
  collapsed: boolean
  selectedId: string | null
  onSelect: (spanId: string) => void
  onToggle: () => void
}) {
  const t = useTranslation()
  const turnSpan = group.turnSpan
  const selected = selectedId === group.turnId
  const turnNumber = (turnSpan.turnIndex ?? 0) + 1
  const turnLabel = t('trace.turnLabel', { index: turnNumber })
  const preview = turnPreview(turnSpan, t)

  return (
    <section>
      <div
        className={`sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] py-1.5 pl-2.5 pr-4 ${
          selected ? 'shadow-[inset_3px_0_0_var(--color-brand)]' : ''
        }`}
      >
        <IconButton
          icon={collapsed
            ? <ChevronRight size={13} strokeWidth={2} />
            : <ChevronDown size={13} strokeWidth={2} />}
          label={t('trace.tree.toggleTurn')}
          size="2xs"
          tone="muted"
          aria-expanded={!collapsed}
          onClick={onToggle}
        />
        <button
          type="button"
          onClick={() => onSelect(group.turnId)}
          data-span-id={group.turnId}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
        >
          <span className={`shrink-0 text-[13px] font-semibold ${
            selected ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'
          }`}>
            {turnLabel}
          </span>
          {preview && preview !== turnLabel ? (
            <span className="truncate text-[12.5px] text-[var(--color-text-tertiary)]">{preview}</span>
          ) : null}
        </button>
        {group.errorCount > 0 ? (
          <span className="shrink-0 font-mono text-[11px] font-semibold text-[var(--color-error)]">
            {group.errorCount}
          </span>
        ) : null}
      </div>
      {!collapsed ? group.rows.map((row) => (
        <TreeRowButton
          key={row.span.id}
          row={row}
          selected={selectedId === row.span.id}
          onSelect={() => onSelect(row.span.id)}
        />
      )) : null}
    </section>
  )
}

function TreeRowButton({ row, selected, onSelect }: { row: TreeRow; selected: boolean; onSelect: () => void }) {
  const t = useTranslation()
  const span = row.span
  const preview = rowPreview(span)
  const duration = span.durationMs !== undefined ? formatDurationMs(span.durationMs) : null

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      aria-level={row.depth + 1}
      data-span-id={span.id}
      onClick={onSelect}
      className={`trace-row-cv relative flex h-[34px] w-full items-center gap-2 pr-4 text-left transition-colors ${
        selected
          ? 'bg-[var(--color-surface-hover)]'
          : 'hover:bg-[var(--color-surface-hover)]'
      }`}
      style={{ paddingLeft: `${16 + row.depth * 14}px` }}
    >
      {selected ? <span className="absolute inset-y-0 left-0 w-[3px] bg-[var(--color-brand)]" aria-hidden="true" /> : null}
      <TypeIcon span={span} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={`shrink-0 truncate text-[13.5px] font-semibold ${
          selected ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'
        }`}>
          {spanDisplayTitle(span, t)}
        </span>
        {preview ? (
          <span className="truncate text-[12.5px] text-[var(--color-text-tertiary)]">{preview}</span>
        ) : null}
        {span.isSidechain ? (
          <span className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-1 text-[10px] text-[var(--color-text-tertiary)]">
            {t('trace.sidechain')}
          </span>
        ) : null}
      </span>
      {duration ? (
        <span className="shrink-0 font-mono text-[12px] text-[var(--color-text-tertiary)]">{duration}</span>
      ) : null}
      <StatusGlyph status={span.status} />
    </button>
  )
}

function rowPreview(span: TraceSpan): string | null {
  if (span.kind === 'message' || span.kind === 'event') {
    const preview = span.subtitle
    return preview && preview !== 'empty' ? preview : null
  }
  return null
}

function turnPreview(turnSpan: TraceSpan, t: ReturnType<typeof useTranslation>): string {
  return turnDisplayTitle(turnSpan.title, (turnSpan.turnIndex ?? 0) + 1, t)
}

function buildTreeGroups(viewModel: TraceViewModel, filter: TraceTreeFilter, query: string): TreeGroup[] {
  const visibleIds = filterSpanIds(viewModel, filter, query)
  const depthById = computeDepths(viewModel)
  const groupsByTurn = new Map<string, TreeGroup>()
  const groups: TreeGroup[] = []

  for (const id of viewModel.orderedSpanIds) {
    const span = viewModel.spansById.get(id)
    if (!span) continue
    if (span.kind === 'session') continue
    if (span.kind === 'turn') {
      const group: TreeGroup = { turnId: span.id, turnSpan: span, rows: [], errorCount: 0 }
      groupsByTurn.set(span.id, group)
      groups.push(group)
      continue
    }
    if (span.kind === 'tool_result') continue
    if (span.isLifecycleNoise === true) continue
    if (!visibleIds.has(span.id)) continue
    const turnId = `turn:${span.turnIndex ?? 0}`
    const group = groupsByTurn.get(turnId)
    if (!group) continue
    // Depth relative to the turn header: session=0, turn=1, direct child=2.
    const depth = Math.max(0, (depthById.get(span.id) ?? 2) - 2)
    group.rows.push({ span, depth })
    if (span.status === 'error') group.errorCount += 1
  }

  return groups.filter((group) => group.rows.length > 0 || (!query.trim() && filter === 'all'))
}

function filterSpanIds(viewModel: TraceViewModel, filter: TraceTreeFilter, query: string): Set<string> {
  const normalizedQuery = query.trim().toLowerCase()
  const matched = new Set<string>()
  for (const span of viewModel.spans) {
    const filterMatch =
      filter === 'all' ||
      (filter === 'llm' && span.kind === 'llm') ||
      (filter === 'tool' && (span.kind === 'tool' || span.kind === 'tool_result')) ||
      (filter === 'error' && span.status === 'error')
    const queryMatch = !normalizedQuery || spanSearchText(span).includes(normalizedQuery)
    if (filterMatch && queryMatch) {
      includeWithAncestors(viewModel, span.id, matched)
    }
  }
  return matched
}

function includeWithAncestors(viewModel: TraceViewModel, spanId: string, target: Set<string>) {
  let current = viewModel.spansById.get(spanId)
  while (current) {
    target.add(current.id)
    current = current.parentId ? viewModel.spansById.get(current.parentId) : undefined
  }
}

function spanSearchText(span: TraceSpan): string {
  return [
    span.title,
    span.subtitle,
    span.kind,
    span.status,
    span.toolName,
    span.toolUseId,
    span.call?.model,
    span.call?.provider?.name,
    span.call?.request.url,
    span.event?.phase,
    span.event?.message,
    span.event?.provider?.name,
    previewTraceValue(span.raw, 500),
  ].filter(Boolean).join(' ').toLowerCase()
}

function computeDepths(viewModel: TraceViewModel): Map<string, number> {
  const depths = new Map<string, number>()
  const visit = (id: string, depth: number) => {
    depths.set(id, depth)
    const span = viewModel.spansById.get(id)
    if (!span) return
    for (const childId of span.childIds) visit(childId, depth + 1)
  }
  visit(viewModel.rootId, 0)
  return depths
}

function filterLabel(filter: TraceTreeFilter, t: ReturnType<typeof useTranslation>): string {
  switch (filter) {
    case 'llm': return t('trace.filter.llm')
    case 'tool': return t('trace.filter.tools')
    case 'error': return t('trace.filter.errors')
    default: return t('trace.filter.all')
  }
}
