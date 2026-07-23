import { conversationService } from './conversationService.js'
import { updateSessionSlashCommands } from '../ws/handler.js'

export type SessionComponentReloadSummary = {
  applied: boolean
  reason?: 'not_running' | 'failed'
  commands: number
  agents: number
  plugins: number
  mcpServers: number
  errors: number
  error?: string
}

/**
 * Refresh the disk-backed commands, agents, plugins, and MCP state captured by
 * an already-running CLI session. The control request updates the session in
 * place, so callers do not need to restart or replace the conversation.
 */
export async function reloadSessionComponents(
  sessionId: string,
): Promise<SessionComponentReloadSummary> {
  if (!conversationService.hasSession(sessionId)) {
    return emptySummary('not_running')
  }

  try {
    const response = await conversationService.requestControl(
      sessionId,
      { subtype: 'reload_plugins' },
      120_000,
    )
    const commands = Array.isArray(response.commands) ? response.commands : []
    const normalizedCommands = updateSessionSlashCommands(sessionId, commands)

    return {
      applied: true,
      commands: normalizedCommands.length,
      agents: Array.isArray(response.agents) ? response.agents.length : 0,
      plugins: Array.isArray(response.plugins) ? response.plugins.length : 0,
      mcpServers: Array.isArray(response.mcpServers) ? response.mcpServers.length : 0,
      errors: typeof response.error_count === 'number' ? response.error_count : 0,
    }
  } catch (error) {
    return {
      ...emptySummary('failed'),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function emptySummary(
  reason: 'not_running' | 'failed',
): SessionComponentReloadSummary {
  return {
    applied: false,
    reason,
    commands: 0,
    agents: 0,
    plugins: 0,
    mcpServers: 0,
    errors: 0,
  }
}
