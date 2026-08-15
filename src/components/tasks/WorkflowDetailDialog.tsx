import figures from 'figures'
import React, { useCallback, useMemo, useState } from 'react'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { DeepImmutable } from '../../types/utils.js'
import { getLargeWorkflowWarning } from '../../utils/workflows/enabled.js'
import type {
  WorkflowAgentEvent,
  WorkflowProgressEvent,
} from '../../utils/workflows/types.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { getTaskStatusColor, getTaskStatusIcon } from './taskStatusUtils.js'

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: () => void
  onBack?: () => void
  onKill?: () => void
  onPause?: () => void
  onSkipAgent?: (agentKey: string) => void
  onRetryAgent?: (agentKey: string) => void
  onSave?: () => void
  /** `null` until the user presses Tab; then the destination they picked. */
  saveScope?: 'user' | 'project' | null
  onToggleSaveScope?: () => void
  /** Suppresses the large-run advisory — ultracode already opts in to scale. */
  ultracode?: boolean
}

type AgentFilter = 'all' | 'running' | 'done' | 'error'
const AGENT_FILTERS: AgentFilter[] = ['all', 'running', 'done', 'error']

/** Rows visible in the agent list before it scrolls. */
const VISIBLE_AGENTS = 12
/** Log lines shown at the run level. */
const VISIBLE_LOGS = 6

type PhaseGroup = {
  index: number
  title: string
  agents: WorkflowAgentEvent[]
}

/**
 * Live progress view for one dynamic workflow run.
 *
 * Three levels: the run (phases with totals), a phase (its agents), and one
 * agent (its prompt, model, and result). The whole thing is derived from the
 * task's `workflowProgress` rows — the runtime is the single source of truth
 * and this component holds no state beyond where the cursor is.
 */
export function WorkflowDetailDialog({
  workflow,
  onDone,
  onBack,
  onKill,
  onPause,
  onSkipAgent,
  onRetryAgent,
  onSave,
  saveScope,
  onToggleSaveScope,
  ultracode,
}: Props): React.ReactNode {
  const elapsed = useElapsedTime(
    workflow.startTime,
    workflow.status === 'running',
    1000,
    0,
  )
  const [selectedPhase, setSelectedPhase] = useState<number | null>(null)
  const [selectedAgentIndex, setSelectedAgentIndex] = useState<number | null>(
    null,
  )
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState<AgentFilter>('all')

  const { phases, orphanAgents, logs } = useMemo(
    () => groupProgress(workflow.workflowProgress as WorkflowProgressEvent[]),
    [workflow.workflowProgress],
  )

  const activePhase =
    selectedPhase === null
      ? null
      : (phases.find(phase => phase.index === selectedPhase) ??
        (selectedPhase === 0
          ? { index: 0, title: 'Ungrouped', agents: orphanAgents }
          : null))

  const visibleAgents = useMemo(
    () => (activePhase ? applyFilter(activePhase.agents, filter) : []),
    [activePhase, filter],
  )

  const selectedAgent =
    selectedAgentIndex === null
      ? null
      : (visibleAgents.find(agent => agent.index === selectedAgentIndex) ?? null)

  const rowCount =
    activePhase === null
      ? phases.length + (orphanAgents.length > 0 ? 1 : 0)
      : visibleAgents.length

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const key = event.key
      if (key === 'up' || key === 'k') {
        event.preventDefault()
        setCursor(prev => Math.max(0, prev - 1))
        return
      }
      if (key === 'down' || key === 'j') {
        event.preventDefault()
        setCursor(prev => Math.min(Math.max(0, rowCount - 1), prev + 1))
        return
      }
      if (key === 'return' || key === 'right') {
        event.preventDefault()
        if (selectedAgent) return
        if (activePhase === null) {
          const rows =
            orphanAgents.length > 0
              ? [...phases, { index: 0, title: 'Ungrouped', agents: orphanAgents }]
              : phases
          const target = rows[cursor]
          if (target) {
            setSelectedPhase(target.index)
            setCursor(0)
          }
          return
        }
        const target = visibleAgents[cursor]
        if (target) setSelectedAgentIndex(target.index)
        return
      }
      if (key === 'escape' || key === 'left') {
        event.preventDefault()
        if (selectedAgentIndex !== null) {
          setSelectedAgentIndex(null)
          return
        }
        if (selectedPhase !== null) {
          setSelectedPhase(null)
          setCursor(0)
          return
        }
        if (onBack) onBack()
        else onDone()
        return
      }
      if (key === 'f' && activePhase !== null) {
        event.preventDefault()
        setFilter(prev => {
          const next = AGENT_FILTERS[(AGENT_FILTERS.indexOf(prev) + 1) % AGENT_FILTERS.length]
          return next ?? 'all'
        })
        setCursor(0)
        return
      }
      if (key === 'x') {
        event.preventDefault()
        if (selectedAgent && onSkipAgent) {
          onSkipAgent(agentKey(workflow.workflowRunId, selectedAgent.index))
          return
        }
        if (workflow.status === 'running' && onKill) onKill()
        return
      }
      if (key === 'r' && selectedAgent && onRetryAgent) {
        event.preventDefault()
        onRetryAgent(agentKey(workflow.workflowRunId, selectedAgent.index))
        return
      }
      if (key === 'p' && workflow.status === 'running' && onPause) {
        event.preventDefault()
        onPause()
        return
      }
      if (key === 'tab' && onToggleSaveScope) {
        event.preventDefault()
        onToggleSaveScope()
        return
      }
      if (key === 's' && onSave) {
        event.preventDefault()
        onSave()
        return
      }
      if (key === ' ') {
        event.preventDefault()
        onDone()
      }
    },
    [
      activePhase,
      cursor,
      onBack,
      onDone,
      onKill,
      onPause,
      onRetryAgent,
      onSave,
      onSkipAgent,
      onToggleSaveScope,
      orphanAgents,
      phases,
      rowCount,
      selectedAgent,
      selectedAgentIndex,
      selectedPhase,
      visibleAgents,
      workflow.status,
      workflow.workflowRunId,
    ],
  )

  const statusColor = getTaskStatusColor(workflow.status)
  const statusIcon = getTaskStatusIcon(workflow.status)
  const started = phases
    .flatMap(phase => phase.agents)
    .concat(orphanAgents)
    .filter(agent => agent.state !== 'start').length
  const largeWarning =
    workflow.status === 'running'
      ? getLargeWorkflowWarning({
          scheduledAgents: workflow.agentCount,
          startedAgents: started,
          totalTokens: workflow.totalTokens,
          ultracodeActive: ultracode === true,
        })
      : undefined

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Box flexDirection="column" borderStyle="round" borderColor="permission" paddingX={1}>
        <Box>
          <Text bold>{workflow.workflowName ?? 'Dynamic workflow'}</Text>
          <Text dimColor>{`  ${workflow.workflowRunId}`}</Text>
        </Box>
        {workflow.summary ? <Text dimColor>{workflow.summary}</Text> : null}
        <Box marginTop={1}>
          <Text color={statusColor}>{`${statusIcon} ${workflow.status}`}</Text>
          <Text dimColor>
            {`  ·  ${workflow.agentCount} agents  ·  ${formatTokens(workflow.totalTokens)} tok  ·  ${workflow.totalToolCalls} tools  ·  ${formatElapsed(elapsed)}`}
          </Text>
        </Box>
        {workflow.error ? (
          <Box marginTop={1}>
            <Text color="error">{workflow.error}</Text>
          </Box>
        ) : null}
        {largeWarning ? (
          <Box marginTop={1}>
            <Text color="warning">
              {`⚠ Large workflow — ${describeLargeWarning(largeWarning)}. Press x to stop.`}
            </Text>
          </Box>
        ) : null}

        <Box flexDirection="column" marginTop={1}>
          {selectedAgent ? (
            <AgentDetail agent={selectedAgent} />
          ) : activePhase ? (
            <AgentList
              phase={activePhase}
              agents={visibleAgents}
              cursor={cursor}
              filter={filter}
            />
          ) : (
            <PhaseList
              phases={phases}
              orphanAgents={orphanAgents}
              cursor={cursor}
            />
          )}
        </Box>

        {!activePhase && logs.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Log</Text>
            {logs.slice(-VISIBLE_LOGS).map((line, index) => (
              <Text key={`${index}-${line.slice(0, 12)}`} dimColor>
                {`  ${line}`}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>

      <Byline>
        <KeyboardShortcutHint shortcut="↑/↓" action="select" />
        <KeyboardShortcutHint shortcut="Enter/→" action="open" />
        <KeyboardShortcutHint shortcut="←/Esc" action="back" />
        {activePhase ? <KeyboardShortcutHint shortcut="f" action={`filter: ${filter}`} /> : null}
        {workflow.status === 'running' && onPause ? (
          <KeyboardShortcutHint shortcut="p" action="pause" />
        ) : null}
        {selectedAgent && onSkipAgent ? (
          <KeyboardShortcutHint shortcut="x" action="skip agent" />
        ) : workflow.status === 'running' && onKill ? (
          <KeyboardShortcutHint shortcut="x" action="stop" />
        ) : null}
        {selectedAgent && onRetryAgent ? (
          <KeyboardShortcutHint shortcut="r" action="restart" />
        ) : null}
        {onSave ? (
          <KeyboardShortcutHint
            shortcut="s"
            action={`save to ${saveScope ?? 'project'}`}
          />
        ) : null}
        {onToggleSaveScope ? (
          <KeyboardShortcutHint shortcut="Tab" action="save location" />
        ) : null}
      </Byline>
    </Box>
  )
}

function PhaseList({
  phases,
  orphanAgents,
  cursor,
}: {
  phases: PhaseGroup[]
  orphanAgents: WorkflowAgentEvent[]
  cursor: number
}): React.ReactNode {
  const rows =
    orphanAgents.length > 0
      ? [...phases, { index: 0, title: 'Ungrouped', agents: orphanAgents }]
      : phases
  if (rows.length === 0) {
    return <Text dimColor>Waiting for the first agent…</Text>
  }
  return (
    <Box flexDirection="column">
      {rows.map((phase, rowIndex) => {
        const totals = summarize(phase.agents)
        const selected = rowIndex === cursor
        return (
          <Box key={`${phase.index}-${phase.title}`}>
            <Text color={selected ? 'permission' : undefined}>
              {`${selected ? figures.pointer : ' '} ${phase.title}`}
            </Text>
            <Text dimColor>
              {`  ${totals.done}/${phase.agents.length} done`}
              {totals.errors > 0 ? `  ${totals.errors} failed` : ''}
              {`  ·  ${formatTokens(totals.tokens)} tok`}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

function AgentList({
  phase,
  agents,
  cursor,
  filter,
}: {
  phase: PhaseGroup
  agents: WorkflowAgentEvent[]
  cursor: number
  filter: AgentFilter
}): React.ReactNode {
  if (agents.length === 0) {
    return <Text dimColor>{`No ${filter} agents in ${phase.title}.`}</Text>
  }
  const start = Math.max(0, Math.min(cursor - VISIBLE_AGENTS + 1, agents.length - VISIBLE_AGENTS))
  const window = agents.slice(Math.max(0, start), Math.max(0, start) + VISIBLE_AGENTS)
  return (
    <Box flexDirection="column">
      <Text dimColor>{`${phase.title} — ${agents.length} agent(s), filter: ${filter}`}</Text>
      {window.map(agent => {
        const selected = agent.index === agents[cursor]?.index
        return (
          <Box key={agent.index}>
            <Text color={selected ? 'permission' : undefined}>
              {`${selected ? figures.pointer : ' '} ${agentIcon(agent)} ${agent.label}`}
            </Text>
            <Text dimColor>
              {agent.cached ? '  cached' : ''}
              {agent.tokens ? `  ${formatTokens(agent.tokens)} tok` : ''}
              {agent.toolCalls ? `  ${agent.toolCalls} tools` : ''}
              {agent.error ? `  ${agent.error}` : ''}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

function AgentDetail({ agent }: { agent: WorkflowAgentEvent }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>{`${agentIcon(agent)} ${agent.label}`}</Text>
      <Text dimColor>
        {[
          agent.model ? `model ${agent.model}` : null,
          agent.agentType ? `agent ${agent.agentType}` : null,
          agent.isolation ? `isolation ${agent.isolation}` : null,
          agent.agentId ? `id ${agent.agentId}` : null,
        ]
          .filter(Boolean)
          .join('  ·  ')}
      </Text>
      <Text dimColor>
        {`${formatTokens(agent.tokens ?? 0)} tok  ·  ${agent.toolCalls ?? 0} tools`}
        {agent.durationMs ? `  ·  ${Math.round(agent.durationMs / 1000)}s` : ''}
      </Text>
      {agent.promptPreview ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Prompt</Text>
          <Text>{agent.promptPreview}</Text>
        </Box>
      ) : null}
      {agent.resultPreview ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Result</Text>
          <Text>{agent.resultPreview}</Text>
        </Box>
      ) : null}
      {agent.error ? (
        <Box marginTop={1}>
          <Text color="error">{agent.error}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * Fold the flat progress stream into phases.
 *
 * Agents that ran before any `phase()` call have no `phaseIndex`; they are
 * collected separately rather than dropped, so a script that never calls
 * `phase()` still shows all its work.
 */
function groupProgress(events: readonly WorkflowProgressEvent[]): {
  phases: PhaseGroup[]
  orphanAgents: WorkflowAgentEvent[]
  logs: string[]
} {
  const phaseByIndex = new Map<number, PhaseGroup>()
  const orphanAgents: WorkflowAgentEvent[] = []
  const logs: string[] = []

  for (const event of events) {
    if (event.type === 'workflow_phase') {
      if (!phaseByIndex.has(event.index)) {
        phaseByIndex.set(event.index, {
          index: event.index,
          title: event.title,
          agents: [],
        })
      }
      continue
    }
    if (event.type === 'workflow_log') {
      logs.push(event.message)
      continue
    }
    if (event.phaseIndex === undefined) {
      orphanAgents.push(event)
      continue
    }
    const phase = phaseByIndex.get(event.phaseIndex) ?? {
      index: event.phaseIndex,
      title: event.phaseTitle ?? `Phase ${event.phaseIndex}`,
      agents: [],
    }
    phase.agents.push(event)
    phaseByIndex.set(event.phaseIndex, phase)
  }

  return {
    phases: [...phaseByIndex.values()].sort((a, b) => a.index - b.index),
    orphanAgents,
    logs,
  }
}

function applyFilter(
  agents: WorkflowAgentEvent[],
  filter: AgentFilter,
): WorkflowAgentEvent[] {
  switch (filter) {
    case 'running':
      return agents.filter(
        agent => agent.state === 'start' || agent.state === 'progress',
      )
    case 'done':
      return agents.filter(agent => agent.state === 'done')
    case 'error':
      return agents.filter(agent => agent.state === 'error')
    default:
      return agents
  }
}

function summarize(agents: WorkflowAgentEvent[]): {
  done: number
  errors: number
  tokens: number
} {
  let done = 0
  let errors = 0
  let tokens = 0
  for (const agent of agents) {
    if (agent.state === 'done') done++
    if (agent.state === 'error') errors++
    tokens += agent.tokens ?? 0
  }
  return { done, errors, tokens }
}

function agentIcon(agent: WorkflowAgentEvent): string {
  switch (agent.state) {
    case 'done':
      return figures.tick
    case 'error':
      return figures.cross
    case 'progress':
      return figures.play
    default:
      return figures.bullet
  }
}

function describeLargeWarning(
  warning: NonNullable<ReturnType<typeof getLargeWorkflowWarning>>,
): string {
  const parts: string[] = []
  if (warning.axis !== 'tokens') {
    parts.push(
      `${warning.scheduledAgents} agents scheduled (over ${warning.agentCap}${warning.capFromGuideline ? ', from your size guideline' : ''})`,
    )
  }
  if (warning.axis !== 'agents') {
    parts.push(
      `projected ${formatTokens(warning.projectedTokens)} tokens (over ${formatTokens(warning.tokenCap)})`,
    )
  }
  return parts.join(' and ')
}

/** Agent controller key, mirroring the harness's `${runId}-${index}`. */
function agentKey(runId: string, index: number): string {
  return `${runId}-${index}`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}
