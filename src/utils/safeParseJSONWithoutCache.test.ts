import { describe, expect, it } from 'bun:test'
import { safeParseJSON, safeParseJSONWithoutCache } from './json.js'

describe('safeParseJSONWithoutCache', () => {
  it('parses valid JSON and returns null for invalid input', () => {
    expect(safeParseJSONWithoutCache('{"a":1}')).toEqual({ a: 1 })
    expect(safeParseJSONWithoutCache('not json', false)).toBeNull()
    expect(safeParseJSONWithoutCache(null)).toBeNull()
    expect(safeParseJSONWithoutCache('')).toBeNull()
  })

  it('returns a fresh object per call, never the shared cache entry', () => {
    const content = '{"mcpServers":{"shared":{"command":"npx"}}}'

    const cached = safeParseJSON(content, false)
    const fresh = safeParseJSONWithoutCache(content, false)
    expect(fresh).not.toBe(cached)

    // Mutating the fresh copy must not leak into later cached parses —
    // this exact leak made removed MCP servers reappear as deleted in every
    // byte-identical .mcp.json (GH #1126).
    delete (fresh as { mcpServers: Record<string, unknown> }).mcpServers.shared
    const cachedAgain = safeParseJSON(content, false) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(cachedAgain.mcpServers)).toEqual(['shared'])
  })

  it('two uncached calls never share structure', () => {
    const content = '{"nested":{"list":[1,2]}}'
    const first = safeParseJSONWithoutCache(content) as { nested: { list: number[] } }
    const second = safeParseJSONWithoutCache(content) as { nested: { list: number[] } }
    first.nested.list.push(3)
    expect(second.nested.list).toEqual([1, 2])
  })
})
