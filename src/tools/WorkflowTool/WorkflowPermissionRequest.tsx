import React, { useCallback, useMemo, useState } from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { PermissionDialog } from '../../components/permissions/PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
  type ToolAnalyticsContext,
} from '../../components/permissions/PermissionPrompt.js'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'
import { PermissionRuleExplanation } from '../../components/permissions/PermissionRuleExplanation.js'
import {
  type UnaryEvent,
  usePermissionRequestLogging,
} from '../../components/permissions/hooks.js'
import { Box, Text } from '../../ink.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { recordWorkflowAutoModeConsent } from '../../utils/workflows/autoModeConsent.js'
import { parseWorkflowScript } from '../../utils/workflows/meta.js'
import type { WorkflowMeta } from '../../utils/workflows/types.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'

type WorkflowOptionValue = 'yes' | 'yes-always' | 'view' | 'no'

/**
 * Approval dialog shown before a dynamic workflow starts.
 *
 * The point of the dialog is the phase list: it is the only preview the user
 * gets of how many agents are about to run and what they will do, and it is
 * the last decision point — once the run starts, its subagents' file edits are
 * auto-approved.
 */
export function WorkflowPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  const { toolUseConfirm, onDone, onReject, workerBadge } = props

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({ completion_type: 'tool_use_single', language_name: 'none' }),
    [],
  )
  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const input = toolUseConfirm.input as {
    script?: string
    name?: string
    scriptPath?: string
    args?: unknown
  }
  const script = typeof input.script === 'string' ? input.script : undefined
  const meta = useMemo(() => readMeta(input.script), [input.script])
  const workflowName = meta?.name ?? input.name ?? 'workflow'
  const description = meta?.description
  const phases = meta?.phases ?? []
  const originalCwd = getOriginalCwd()
  const showAlwaysAllow = shouldShowAlwaysAllowOptions() && Boolean(input.name)
  const [showScript, setShowScript] = useState(false)

  const options = useMemo<PermissionPromptOption<WorkflowOptionValue>[]>(() => {
    const built: PermissionPromptOption<WorkflowOptionValue>[] = [
      { label: 'Yes, run it', value: 'yes', feedbackConfig: { type: 'accept' } },
    ]
    if (showAlwaysAllow) {
      built.push({
        label: (
          <Text>
            Yes, and don&apos;t ask again for <Text bold>{workflowName}</Text> in{' '}
            <Text bold>{originalCwd}</Text>
          </Text>
        ),
        value: 'yes-always',
      })
    }
    if (script && !showScript) {
      built.push({ label: 'View raw script', value: 'view' })
    }
    built.push({ label: 'No', value: 'no', feedbackConfig: { type: 'reject' } })
    return built
  }, [showAlwaysAllow, workflowName, originalCwd, script, showScript])

  const toolAnalyticsContext = useMemo<ToolAnalyticsContext>(
    () => ({
      toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
      isMcp: toolUseConfirm.tool.isMcp ?? false,
    }),
    [toolUseConfirm.tool.name, toolUseConfirm.tool.isMcp],
  )

  const isAutoMode =
    toolUseConfirm.toolUseContext.getAppState().toolPermissionContext.mode ===
    'auto'

  const handleSelect = useCallback(
    (value: WorkflowOptionValue, feedback?: string) => {
      // In auto mode a Yes of either kind is the one-time consent — after this
      // the launch prompt stops appearing.
      if (isAutoMode && (value === 'yes' || value === 'yes-always')) {
        recordWorkflowAutoModeConsent()
      }
      switch (value) {
        case 'yes':
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
          onDone()
          break
        case 'yes-always':
          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [
                { toolName: WORKFLOW_TOOL_NAME, ruleContent: workflowName },
              ],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ])
          onDone()
          break
        case 'view':
          // Stay in the dialog: the whole point is to read the script and then
          // decide, so this must not resolve the permission either way.
          setShowScript(true)
          break
        case 'no':
          toolUseConfirm.onReject(feedback)
          onReject()
          onDone()
          break
      }
    },
    [toolUseConfirm, onDone, onReject, workflowName, isAutoMode],
  )

  const handleCancel = useCallback(() => {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  return (
    <PermissionDialog
      title={`Run workflow "${workflowName}"?`}
      workerBadge={workerBadge}
    >
      <Text>
        A workflow spawns many subagents in the background. Their file edits are
        auto-approved and the run can use a large number of tokens.
      </Text>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {description ? <Text dimColor>{description}</Text> : null}
        {phases.length > 0 ? (
          <Box flexDirection="column" marginTop={description ? 1 : 0}>
            <Text dimColor>Phases:</Text>
            {phases.map((phase, index) => (
              <Text key={`${phase.title}-${index}`} dimColor>
                {`  ${index + 1}. ${phase.title}`}
                {phase.detail ? ` — ${phase.detail}` : ''}
              </Text>
            ))}
          </Box>
        ) : null}
        {input.scriptPath ? (
          <Box marginTop={1}>
            <Text dimColor>{`Script: ${input.scriptPath}`}</Text>
          </Box>
        ) : null}
        {showScript && script ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Raw script:</Text>
            <Text>{clipScript(script)}</Text>
          </Box>
        ) : null}
      </Box>

      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={toolAnalyticsContext}
        />
      </Box>
    </PermissionDialog>
  )
}

const SCRIPT_PREVIEW_LINES = 60

/** Long scripts are clipped: the dialog must stay smaller than the terminal. */
function clipScript(script: string): string {
  const lines = script.split('\n')
  if (lines.length <= SCRIPT_PREVIEW_LINES) return script
  const remaining = lines.length - SCRIPT_PREVIEW_LINES
  return (
    `${lines.slice(0, SCRIPT_PREVIEW_LINES).join('\n')}\n` +
    `… ${remaining} more lines — the full script is persisted under the session directory`
  )
}

/**
 * Read the script's `meta` for the preview.
 *
 * Parsing can fail here — the tool has not validated the script yet — and a
 * bad script should still reach the tool so the model sees the real parse
 * error, not a silent refusal in the dialog.
 */
function readMeta(script: string | undefined): WorkflowMeta | undefined {
  if (!script) return undefined
  const parsed = parseWorkflowScript(script)
  return 'error' in parsed ? undefined : parsed.meta
}
