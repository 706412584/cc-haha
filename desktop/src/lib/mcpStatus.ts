import type { Tone } from '@/components/ui/Badge'
import type { McpServerRecord } from '@/types/mcp'

/**
 * The single mapping from an MCP server status to a badge color.
 *
 * There used to be two copies — one in `pages/McpSettings.tsx`, one in
 * `chat/LocalSlashCommandPanel.tsx` — and they had drifted: the panel's copy
 * had no `checking` branch and returned an empty class string, so a server that
 * was mid-check rendered as a styled pill in settings and as bare text in the
 * slash panel. Anything that colors an MCP status goes through here.
 */
export function mcpStatusTone(status: McpServerRecord['status']): Tone {
  switch (status) {
    case 'connected':
      return 'success'
    case 'needs-auth':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'checking':
    case 'disabled':
      return 'neutral'
  }
}
