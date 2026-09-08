/**
 * Transcript rendering for the Codex 10-tool computer-use face. Guards that the
 * use-message arg summaries and the result summaries cover exactly the ten
 * semantic tools (no stale pixel-tool cases) and format their args sensibly.
 */
import { describe, expect, test } from 'bun:test'
import { getComputerUseMCPRenderingOverrides } from './toolRendering.js'

function useMsg(tool: string, input: Record<string, unknown>): unknown {
  return getComputerUseMCPRenderingOverrides(tool).renderToolUseMessage(input, {
    verbose: false,
  })
}

describe('getComputerUseMCPRenderingOverrides — userFacingName', () => {
  test('wraps the tool name', () => {
    expect(getComputerUseMCPRenderingOverrides('get_app_state').userFacingName()).toBe(
      'Computer Use[get_app_state]',
    )
  })
})

describe('renderToolUseMessage — Codex tools', () => {
  test('list_apps renders nothing (bare enumeration)', () => {
    expect(useMsg('list_apps', {})).toBe('')
  })

  test('get_app_state shows the target app, or nothing for frontmost', () => {
    expect(useMsg('get_app_state', { app: 'Finder' })).toBe('Finder')
    expect(useMsg('get_app_state', {})).toBe('')
  })

  test('click shows element index (#N) and target app', () => {
    expect(useMsg('click', { element_index: '4', app: 'Finder' })).toBe('#4 on Finder')
    expect(useMsg('click', { element_index: 7 })).toBe('#7')
  })

  test('click falls back to coordinate when no index', () => {
    expect(useMsg('click', { x: 10, y: 20 })).toBe('(10, 20)')
  })

  test('perform_secondary_action shows action name + index', () => {
    expect(useMsg('perform_secondary_action', { action: 'Raise', element_index: '0' })).toBe(
      'Raise #0',
    )
  })

  test('set_value shows index + truncated value', () => {
    expect(useMsg('set_value', { element_index: 3, value: 'hello' })).toBe('#3 "hello"')
  })

  test('scroll shows direction, pages, index', () => {
    expect(useMsg('scroll', { direction: 'down', pages: 2, element_index: 5 })).toBe(
      'down ×2 #5',
    )
    expect(useMsg('scroll', { direction: 'up' })).toBe('up')
  })

  test('drag shows from → to points', () => {
    expect(useMsg('drag', { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).toBe('(1, 2) → (3, 4)')
  })

  test('press_key shows the chord', () => {
    expect(useMsg('press_key', { key: 'super+c' })).toBe('super+c')
  })

  test('type_text shows the quoted text', () => {
    expect(useMsg('type_text', { text: 'hi there' })).toBe('"hi there"')
  })

  test('select_text shows the opaque handle, text, and selection mode', () => {
    expect(
      useMsg('select_text', {
        element_index: 'g21:4',
        text: 'brown',
        selection_type: 'cursor_after',
      }),
    ).toBe('#g21:4 "brown" cursor_after')
  })

  test('unknown / absent args degrade to empty string (never null)', () => {
    expect(useMsg('click', {})).toBe('')
    expect(useMsg('set_value', {})).toBe('')
    expect(useMsg('press_key', {})).toBe('')
  })

  test('no stale pixel tool produces a summary', () => {
    // Deleted tools (left_click, screenshot, request_access, …) hit the default
    // arm: empty string, no crash.
    for (const dead of [
      'left_click',
      'double_click',
      'screenshot',
      'request_access',
      'list_granted_applications',
      'computer_batch',
    ]) {
      expect(useMsg(dead, { coordinate: [1, 2] })).toBe('')
    }
  })
})

describe('renderToolResultMessage — summaries', () => {
  const overrides = (tool: string) => getComputerUseMCPRenderingOverrides(tool)

  test('verbose returns null (defer to default verbose rendering)', () => {
    expect(
      overrides('click').renderToolResultMessage({} as never, [], { verbose: true }),
    ).toBeNull()
  })

  test('each Codex tool has a non-verbose summary node', () => {
    for (const tool of [
      'list_apps',
      'get_app_state',
      'click',
      'perform_secondary_action',
      'set_value',
      'scroll',
      'select_text',
      'drag',
      'press_key',
      'type_text',
    ]) {
      const node = overrides(tool).renderToolResultMessage({} as never, [], { verbose: false })
      expect(node).not.toBeNull()
    }
  })

  test('a deleted/unknown tool yields no summary (null)', () => {
    expect(
      overrides('left_click').renderToolResultMessage({} as never, [], { verbose: false }),
    ).toBeNull()
  })
})
