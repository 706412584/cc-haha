import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import type { PermissionMode } from '../../types/permissions.js'
import { resolveScriptForTesting, WorkflowTool } from './WorkflowTool.js'

function makeContext(options: {
  mode?: PermissionMode
  isNonInteractiveSession?: boolean
  allowRules?: string[]
  ultracode?: boolean
}): ToolUseContext {
  const permissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: options.mode ?? 'default',
    ...(options.allowRules
      ? {
          alwaysAllowRules: {
            localSettings: options.allowRules.map(
              content => `${WorkflowTool.name}(${content})`,
            ),
          },
        }
      : {}),
  }
  return {
    options: {
      isNonInteractiveSession: options.isNonInteractiveSession ?? false,
    },
    getAppState: () =>
      ({
        toolPermissionContext: permissionContext,
        ultracode: options.ultracode ?? false,
      }) as unknown as AppState,
  } as unknown as ToolUseContext
}

describe('WorkflowTool.checkPermissions', () => {
  test('asks before starting a run in default mode', async () => {
    const result = await WorkflowTool.checkPermissions(
      { name: 'deep-research' },
      makeContext({ mode: 'default' }),
    )
    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') return
    expect(result.message).toContain('spawn many subagents')
    // The "don't ask again" option needs a rule to write.
    expect(result.suggestions?.[0]).toMatchObject({
      type: 'addRules',
      behavior: 'allow',
      destination: 'localSettings',
    })
  })

  test('still asks in acceptEdits — a run auto-approves its agents edits', async () => {
    const result = await WorkflowTool.checkPermissions(
      { name: 'deep-research' },
      makeContext({ mode: 'acceptEdits' }),
    )
    expect(result.behavior).toBe('ask')
  })

  test('ultracode skips the launch prompt — it is a standing opt-in', async () => {
    const result = await WorkflowTool.checkPermissions(
      { name: 'deep-research' },
      makeContext({ mode: 'default', ultracode: true }),
    )
    expect(result.behavior).toBe('allow')
  })

  test('allows without prompting under bypassPermissions', async () => {
    const result = await WorkflowTool.checkPermissions(
      { name: 'deep-research' },
      makeContext({ mode: 'bypassPermissions' }),
    )
    expect(result.behavior).toBe('allow')
  })

  test('allows in a non-interactive session, where nobody can answer', async () => {
    const result = await WorkflowTool.checkPermissions(
      { script: "export const meta = { name: 'x', description: 'y' }\n" },
      makeContext({ isNonInteractiveSession: true }),
    )
    expect(result.behavior).toBe('allow')
  })

  test('an allow rule for one workflow does not cover another', async () => {
    const context = makeContext({ allowRules: ['deep-research'] })
    const allowed = await WorkflowTool.checkPermissions(
      { name: 'deep-research' },
      context,
    )
    expect(allowed.behavior).toBe('allow')

    const other = await WorkflowTool.checkPermissions(
      { name: 'something-else' },
      context,
    )
    expect(other.behavior).toBe('ask')
  })

  test('an inline script has no rule to match, so it always asks', async () => {
    const result = await WorkflowTool.checkPermissions(
      { script: "export const meta = { name: 'x', description: 'y' }\n" },
      makeContext({ allowRules: ['x'] }),
    )
    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') return
    expect(result.suggestions).toBeUndefined()
  })
})

describe('resolveScript', () => {
  test('a named workflow carries no scriptPath, so the run gets a session copy', async () => {
    const resolved = await resolveScriptForTesting({ name: 'deep-research' })
    expect('script' in resolved && resolved.script).toContain('export const meta')
    // Pointing the run at ~/.claude/workflows/<name>.js would make it write
    // back over the user's file, and a later resume would replay whatever that
    // file says rather than what actually ran.
    expect(
      (resolved as { scriptPath?: string }).scriptPath,
    ).toBeUndefined()
  })

  test('an explicit scriptPath is preserved so a resume reads the edited file', async () => {
    const resolved = await resolveScriptForTesting({
      scriptPath: '/definitely/not/here.js',
    })
    expect('error' in resolved && resolved.error).toContain('Failed to read')
  })
})

describe('WorkflowTool.call', () => {
  test('rejects a call with no script, scriptPath, or name', async () => {
    await expect(
      WorkflowTool.call(
        {},
        makeContext({ mode: 'bypassPermissions' }),
        (() => {}) as never,
        {} as never,
      ),
    ).rejects.toThrow('requires one of `script`, `scriptPath`, or `name`')
  })

  test('surfaces the parse error for a script without a leading meta export', async () => {
    await expect(
      WorkflowTool.call(
        { script: 'const x = 1\n' },
        makeContext({ mode: 'bypassPermissions' }),
        (() => {}) as never,
        {} as never,
      ),
    ).rejects.toThrow('must be the FIRST statement')
  })

  test('points at plain JavaScript when the body has TypeScript syntax', async () => {
    await expect(
      WorkflowTool.call(
        {
          script:
            "export const meta = { name: 'x', description: 'y' }\nconst files: string[] = []\n",
        },
        makeContext({ mode: 'bypassPermissions' }),
        (() => {}) as never,
        {} as never,
      ),
    ).rejects.toThrow('plain JavaScript')
  })


  test('reports a missing named workflow with the available list', async () => {
    await expect(
      WorkflowTool.call(
        { name: 'no-such-workflow' },
        makeContext({ mode: 'bypassPermissions' }),
        (() => {}) as never,
        {} as never,
      ),
    ).rejects.toThrow("Unknown workflow 'no-such-workflow'")
  })
})
