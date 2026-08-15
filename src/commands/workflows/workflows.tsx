import figures from 'figures'
import React, { useCallback, useMemo, useState } from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Byline } from '../../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import {
  getTaskStatusColor,
  getTaskStatusIcon,
} from '../../components/tasks/taskStatusUtils.js'
import { WorkflowDetailDialog } from '../../components/tasks/WorkflowDetailDialog.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import {
  buildResumePrompt,
  killWorkflowTask,
  pauseWorkflowTask,
  retryWorkflowAgent,
  skipWorkflowAgent,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { DeepImmutable } from '../../types/utils.js'
import { saveWorkflowScript } from '../../utils/workflows/save.js'

/**
 * `/workflows` — list this session's dynamic workflow runs and open one.
 *
 * Separate from `/tasks` on purpose: a workflow's interesting state is its
 * phase/agent tree, which the generic background-task list cannot show, and
 * during a large run the workflow rows would bury every other task.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <WorkflowsDialog toolUseContext={context} onDone={onDone} />
}

function WorkflowsDialog({
  toolUseContext,
  onDone,
}: {
  toolUseContext: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const appState = toolUseContext.getAppState()
  const setAppState = toolUseContext.setAppState
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const [saveScope, setSaveScope] = useState<'user' | 'project' | null>(null)

  const runs = useMemo(() => {
    const all = Object.values(appState.tasks ?? {}).filter(
      (task): task is DeepImmutable<LocalWorkflowTaskState> =>
        task.type === 'local_workflow',
    )
    // Newest first: during a long session the run you just started is the one
    // you came here to watch.
    return [...all].sort((a, b) => b.startTime - a.startTime)
  }, [appState.tasks])

  const selected = selectedId
    ? (runs.find(run => run.id === selectedId) ?? null)
    : null

  const close = useCallback(() => onDone(), [onDone])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (selected) return
      const key = event.key
      if (key === 'up') {
        event.preventDefault()
        setCursor(prev => Math.max(0, prev - 1))
        return
      }
      if (key === 'down') {
        event.preventDefault()
        setCursor(prev => Math.min(Math.max(0, runs.length - 1), prev + 1))
        return
      }
      if (key === 'return' || key === 'right') {
        event.preventDefault()
        const run = runs[cursor]
        if (run) setSelectedId(run.id)
        return
      }
      if (key === 'x') {
        event.preventDefault()
        const run = runs[cursor]
        if (run && run.status === 'running') killWorkflowTask(run.id, setAppState)
        return
      }
      if (key === 'escape' || key === 'left' || key === ' ') {
        event.preventDefault()
        close()
      }
    },
    [close, cursor, runs, selected, setAppState],
  )

  if (selected) {
    return (
      <WorkflowDetailDialog
        workflow={selected}
        onDone={close}
        onBack={() => setSelectedId(null)}
        onKill={
          selected.status === 'running'
            ? () => killWorkflowTask(selected.id, setAppState)
            : undefined
        }
        onPause={
          selected.status === 'running'
            ? () => {
                if (pauseWorkflowTask(selected.id, setAppState)) {
                  onDone(buildResumePrompt(selected as LocalWorkflowTaskState), {
                    display: 'system',
                  })
                }
              }
            : undefined
        }
        onSkipAgent={
          selected.status === 'running'
            ? key => skipWorkflowAgent(selected.id, key, setAppState)
            : undefined
        }
        onRetryAgent={
          selected.status === 'running'
            ? key => retryWorkflowAgent(selected.id, key, setAppState)
            : undefined
        }
        ultracode={appState.ultracode === true}
        saveScope={saveScope}
        onToggleSaveScope={() =>
          setSaveScope(prev =>
            prev === null ? 'project' : prev === 'project' ? 'user' : 'project',
          )
        }
        onSave={async () => {
          const scope = saveScope ?? 'project'
          const result = await saveWorkflowScript({
            script: selected.script,
            scope,
          })
          onDone(
            'error' in result
              ? `Could not save workflow: ${result.error}`
              : `Saved /${result.name} to ${result.filePath}`,
            { display: 'system' },
          )
        }}
      />
    )
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="permission"
        paddingX={1}
      >
        <Text bold>Dynamic workflows</Text>
        {runs.length === 0 ? (
          <Text dimColor>
            No workflow runs in this session. Ask Claude to &quot;use a
            workflow&quot;, or run a saved one with /&lt;name&gt;.
          </Text>
        ) : (
          runs.map((run, index) => {
            const isSelected = index === cursor
            return (
              <Box key={run.id}>
                <Text color={isSelected ? 'permission' : undefined}>
                  {`${isSelected ? figures.pointer : ' '} `}
                </Text>
                <Text color={getTaskStatusColor(run.status)}>
                  {getTaskStatusIcon(run.status)}
                </Text>
                <Text>{` ${run.workflowName ?? 'workflow'}`}</Text>
                <Text dimColor>
                  {`  ${run.agentCount} agents · ${run.totalTokens} tok · ${run.status}`}
                </Text>
              </Box>
            )
          })
        )}
      </Box>
      <Byline>
        <KeyboardShortcutHint shortcut="↑/↓" action="select" />
        <KeyboardShortcutHint shortcut="Enter" action="open" />
        <KeyboardShortcutHint shortcut="x" action="stop" />
        <KeyboardShortcutHint shortcut="Esc" action="close" />
      </Byline>
    </Box>
  )
}
