/**
 * OpenAI-compatible endpoints commonly enforce a 64-character limit on
 * function names (`^[a-zA-Z0-9_-]{1,64}$`), while MCP tools surfaced through
 * the Anthropic protocol routinely exceed it (e.g.
 * `mcp__plugin_x_sce-editor-mcp__spark2_runtime_call_tool`, 67 chars). The
 * request side renames such tools to a bounded wire name; the response side
 * maps the wire name back so the client only ever sees original names.
 */

import { createHash } from 'node:crypto'

export const MAX_WIRE_TOOL_NAME_LENGTH = 64

/** Wire prefix — keeps renamed tools visually distinguishable in upstream traces. */
const TRUNCATED_WIRE_PREFIX = 'truncated__'
const WIRE_HASH_LENGTH = 8

export function isOverLengthToolName(name: string): boolean {
  return name.length > MAX_WIRE_TOOL_NAME_LENGTH
}

/**
 * Carries the request-side renames through to the response side of a single
 * proxy call. One instance per proxied request; pass it to both the request
 * transform and the response/stream transform.
 */
export class ToolNameWireMap {
  private readonly wireToOriginal = new Map<string, string>()

  /** Rename for the wire if needed; short names pass through unchanged. */
  toWire(name: string): string {
    if (!isOverLengthToolName(name)) return name
    const digest = createHash('sha256').update(name).digest('hex').slice(0, WIRE_HASH_LENGTH)
    const wire = `${TRUNCATED_WIRE_PREFIX}${digest}`
    // The digest is deterministic per original name; the rare collision maps
    // both originals to the same wire name — the first registration wins.
    if (!this.wireToOriginal.has(wire)) this.wireToOriginal.set(wire, name)
    return wire
  }

  /** Restore the original name on the response side; unknown names pass through. */
  fromWire(name: string): string {
    return this.wireToOriginal.get(name) ?? name
  }
}
