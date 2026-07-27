import { describe, expect, it } from 'bun:test'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { permissionPromptToolResultToPermissionDecision } from './PermissionPromptToolResultSchema.js'

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

const tool = { name: 'Write' } as Tool

describe('permissionPromptToolResultToPermissionDecision', () => {
  it('leaves the turn running when a deny omits interrupt', () => {
    const context = makeContext()

    const decision = permissionPromptToolResultToPermissionDecision(
      { behavior: 'deny', message: 'nope' },
      tool,
      { file_path: '/tmp/a.sh' },
      context,
    )

    expect(decision.behavior).toBe('deny')
    // The denial has to survive as a tool_result so the model can see it and
    // write a closing reply. Aborting here ends the turn silently instead.
    expect(context.abortController.signal.aborted).toBe(false)
  })

  it('aborts the turn when a deny explicitly asks to interrupt', () => {
    const context = makeContext()

    permissionPromptToolResultToPermissionDecision(
      { behavior: 'deny', message: 'nope', interrupt: true },
      tool,
      { file_path: '/tmp/a.sh' },
      context,
    )

    expect(context.abortController.signal.aborted).toBe(true)
  })

  it('never aborts on allow', () => {
    const context = makeContext()

    const decision = permissionPromptToolResultToPermissionDecision(
      { behavior: 'allow', updatedInput: {} },
      tool,
      { file_path: '/tmp/a.sh' },
      context,
    )

    expect(decision.behavior).toBe('allow')
    // An empty updatedInput means "use the original" (mobile push responses).
    expect((decision as { updatedInput: unknown }).updatedInput).toEqual({
      file_path: '/tmp/a.sh',
    })
    expect(context.abortController.signal.aborted).toBe(false)
  })
})
