import * as React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Text } from '../../ink.js';
import { truncateToWidth } from '../format.js';
import type { MCPToolResult } from '../mcpValidation.js';

/**
 * Tool-call argument shape for the Codex-compatible computer-use face
 * (blueprint §7). The model addresses UI elements by `element_index` from the
 * most recent get_app_state tree; `app` selects the target; the remaining keys
 * are per-tool (value / action / direction / pages / key / text / x,y / from,to).
 */
type CuToolInput = Record<string, unknown> & {
  app?: string;
  element_index?: string | number;
  value?: string;
  action?: string;
  direction?: string;
  pages?: number;
  key?: string;
  text?: string;
  x?: number;
  y?: number;
  from?: { x?: number; y?: number };
  to?: { x?: number; y?: number };
};

function fmtPoint(p: { x?: number; y?: number } | undefined): string {
  return p && typeof p.x === 'number' && typeof p.y === 'number'
    ? `(${p.x}, ${p.y})`
    : '';
}

/** A short " on <App>" suffix when the call named a target app. */
function appSuffix(app: unknown): string {
  return typeof app === 'string' && app !== '' ? ` on ${app}` : '';
}

/** Render the element_index (string or int) as "#N", or '' when absent. */
function fmtIndex(idx: string | number | undefined): string {
  if (idx === undefined || idx === null || idx === '') return '';
  return `#${idx}`;
}

/**
 * One-line dim result summary keyed by tool name. The ten Codex tools all
 * return the refreshed app state, so the meaningful per-tool receipt is the
 * action verb; get_app_state / list_apps summarize what they fetched.
 */
const RESULT_SUMMARY: Readonly<Partial<Record<string, string>>> = {
  list_apps: 'Listed apps',
  get_app_state: 'Read state',
  click: 'Clicked',
  perform_secondary_action: 'Performed action',
  set_value: 'Set value',
  select_text: 'Selected text',
  scroll: 'Scrolled',
  drag: 'Dragged',
  press_key: 'Pressed',
  type_text: 'Typed',
};

/**
 * Rendering overrides for `mcp__computer-use__*` tools (Codex 10-tool face).
 * Spread into the MCP tool object in `client.ts` after the default
 * `userFacingName`, so these win. Mirror of `getClaudeInChromeMCPToolOverrides`.
 */
export function getComputerUseMCPRenderingOverrides(toolName: string): {
  userFacingName: () => string;
  renderToolUseMessage: (input: Record<string, unknown>, options: {
    verbose: boolean;
  }) => React.ReactNode;
  renderToolResultMessage: (output: MCPToolResult, progressMessages: unknown[], options: {
    verbose: boolean;
  }) => React.ReactNode;
} {
  return {
    userFacingName() {
      return `Computer Use[${toolName}]`;
    },
    // AssistantToolUseMessage.tsx contract: null hides the ENTIRE row, '' shows
    // the tool name without "(args)". Every path below returns '' when there's
    // nothing to show — never null.
    renderToolUseMessage(input: CuToolInput) {
      switch (toolName) {
        case 'list_apps':
          return '';

        case 'get_app_state':
          // " on Finder" when targeted; bare (frontmost) otherwise.
          return typeof input.app === 'string' && input.app !== ''
            ? input.app
            : '';

        case 'click': {
          // Prefer the element index; fall back to the coordinate.
          const idx = fmtIndex(input.element_index);
          const where = idx || fmtPoint({ x: input.x, y: input.y });
          return `${where}${appSuffix(input.app)}`.trim();
        }

        case 'perform_secondary_action': {
          const idx = fmtIndex(input.element_index);
          const action = typeof input.action === 'string' ? input.action : '';
          return [action, idx].filter(Boolean).join(' ');
        }

        case 'set_value': {
          const idx = fmtIndex(input.element_index);
          const value =
            typeof input.value === 'string'
              ? `"${truncateToWidth(input.value, 40)}"`
              : '';
          return [idx, value].filter(Boolean).join(' ');
        }

        case 'select_text': {
          const idx = fmtIndex(input.element_index);
          const text =
            typeof input.text === 'string'
              ? `"${truncateToWidth(input.text, 40)}"`
              : '';
          // The mode matters to the reader: selecting a run and parking the
          // caret beside it look identical without it.
          const selection =
            typeof input.selection_type === 'string' ? input.selection_type : '';
          return [idx, text, selection].filter(Boolean).join(' ');
        }

        case 'scroll': {
          const idx = fmtIndex(input.element_index);
          return [
            typeof input.direction === 'string' ? input.direction : '',
            typeof input.pages === 'number' ? `×${input.pages}` : '',
            idx,
          ]
            .filter(Boolean)
            .join(' ');
        }

        case 'drag':
          return `${fmtPoint(input.from)} → ${fmtPoint(input.to)}`.trim();

        case 'press_key':
          return typeof input.key === 'string' ? input.key : '';

        case 'type_text':
          return typeof input.text === 'string'
            ? `"${truncateToWidth(input.text, 40)}"`
            : '';

        default:
          return '';
      }
    },

    renderToolResultMessage(output, _progress, {
      verbose
    }) {
      if (verbose || typeof output !== 'object' || output === null) return null;

      // Non-verbose: one-line dim summary, like Chrome's pattern.
      const summary = RESULT_SUMMARY[toolName];
      if (!summary) return null;
      return <MessageResponse height={1}>
          <Text dimColor>{summary}</Text>
        </MessageResponse>;
    }
  };
}
