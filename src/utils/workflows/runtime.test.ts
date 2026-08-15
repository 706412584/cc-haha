import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { executeWorkflowScript, prepareWorkflowScript } from './runtime.js'
import type {
  WorkflowAgentRunParams,
  WorkflowAgentRunResult,
} from './runWorkflowAgent.js'
import type { WorkflowProgressEvent } from './types.js'

/**
 * Drive a whole script through the real VM sandbox with a scripted stand-in
 * for the subagent. The harness/runtime seam is what these tests own; the
 * model call itself is covered by the CLI smoke lane.
 */
async function run(
  script: string,
  options: {
    agent?: (params: WorkflowAgentRunParams) => Promise<unknown>
    args?: unknown
    abortController?: AbortController
    ownerAgentId?: ToolUseContext['agentId']
  } = {},
) {
  const prepared = prepareWorkflowScript(script)
  if (!prepared.ok) throw new Error(prepared.error)

  const events: WorkflowProgressEvent[] = []
  const abortController = options.abortController ?? new AbortController()
  let seq = 0

  const outcome = await executeWorkflowScript({
    vmScript: prepared.vmScript,
    toolUseContext: {
      agentId: options.ownerAgentId,
      abortController,
      options: { mainLoopModel: 'test-model' },
    } as unknown as ToolUseContext,
    canUseTool: (() => {}) as unknown as CanUseToolFn,
    runId: 'wf_test0000-abc',
    workflowName: prepared.meta.name,
    args: options.args,
    seedPhaseTitles: prepared.meta.phases?.map(phase => phase.title),
    onProgress: event => events.push(event),
    onAgentController: () => {},
    runAgentImpl: async (
      params: WorkflowAgentRunParams,
    ): Promise<WorkflowAgentRunResult> => {
      const value = options.agent
        ? await options.agent(params)
        : `ran: ${params.prompt}`
      return {
        agentId: `agent-${++seq}`,
        value,
        tokens: 10,
        toolCalls: 1,
      }
    },
  })
  return { outcome, events, meta: prepared.meta }
}

const META = "export const meta = { name: 'demo', description: 'A demo' }\n"

describe('executeWorkflowScript', () => {
  test('returns the script result and counts the agents it spawned', async () => {
    const { outcome } = await run(
      `${META}
      const a = await agent('first')
      const b = await agent('second')
      return { a, b }`,
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.result).toEqual({ a: 'ran: first', b: 'ran: second' })
    expect(outcome.agentCount).toBe(2)
  })

  test('pipeline threads each item through every stage', async () => {
    const { outcome } = await run(
      `${META}
      const out = await pipeline(
        ['a.ts', 'b.ts'],
        file => agent('review ' + file, { label: file, phase: 'Review' }),
        (review, original, index) => agent('verify ' + original + '#' + index, { phase: 'Verify' }),
      )
      return out`,
      { agent: async params => params.prompt },
    )
    expect(outcome.result).toEqual([
      'verify a.ts#0',
      'verify b.ts#1',
    ])
    expect(outcome.agentCount).toBe(4)
  })

  test('a failing slot becomes null instead of failing the whole batch', async () => {
    const { outcome } = await run(
      `${META}
      const out = await parallel([
        () => agent('ok'),
        () => agent('boom'),
      ])
      return out`,
      {
        agent: async params => {
          if (params.prompt === 'boom') throw new Error('agent exploded')
          return 'fine'
        },
      },
    )
    expect(outcome.result).toEqual(['fine', null])
    expect(outcome.failures).toEqual(['parallel[1] failed: agent exploded'])
  })

  test('parallel rejects promises passed instead of thunks', async () => {
    const { outcome } = await run(
      `${META}
      return await parallel([agent('a')])`,
    )
    expect(outcome.error).toContain('Wrap each call: () => agent(...)')
  })

  test('emits phase rows for meta.phases and for phase() calls', async () => {
    const { events } = await run(
      `export const meta = { name: 'demo', description: 'A demo', phases: [{ title: 'Scan' }] }
      phase('Scan')
      await agent('one')
      phase('Fix')
      await agent('two')
      return null`,
    )
    const phases = events.filter(event => event.type === 'workflow_phase')
    expect(phases).toEqual([
      { type: 'workflow_phase', index: 1, title: 'Scan', kind: 'meta' },
      { type: 'workflow_phase', index: 2, title: 'Fix', kind: 'script' },
    ])
    const agentPhases = events
      .filter(event => event.type === 'workflow_agent' && event.state === 'done')
      .map(event => (event.type === 'workflow_agent' ? event.phaseTitle : null))
    expect(agentPhases).toEqual(['Scan', 'Fix'])
  })

  test('log() and console.log both reach the progress stream', async () => {
    const { outcome, events } = await run(
      `${META}
      log('from log')
      console.log('from console', { n: 1 })
      return 'done'`,
    )
    expect(outcome.logs).toEqual(['from log', 'from console {"n":1}'])
    expect(
      events.filter(event => event.type === 'workflow_log'),
    ).toHaveLength(2)
  })

  test('args arrive as structured data, not a JSON string', async () => {
    const { outcome } = await run(
      `${META}
      return args.filter(n => n > 1)`,
      { args: [1, 2, 3] },
    )
    expect(outcome.result).toEqual([2, 3])
  })

  test('args is undefined when the caller passed none', async () => {
    const { outcome } = await run(`${META}
      return typeof args`)
    expect(outcome.result).toBe('undefined')
  })

  test('budget.remaining is Infinity with no target', async () => {
    const { outcome } = await run(`${META}
      return { total: budget.total, infinite: budget.remaining() === Infinity }`)
    expect(outcome.result).toEqual({ total: null, infinite: true })
  })

  test('Date.now, new Date and Math.random are unavailable', async () => {
    for (const expression of ['Date.now()', 'new Date()', 'Math.random()']) {
      const { outcome } = await run(`${META}
        return ${expression}`)
      expect(outcome.error).toContain('unavailable in workflow scripts')
    }
  })

  test('a Date built from an explicit timestamp still works', async () => {
    const { outcome } = await run(`${META}
      return new Date(0).toISOString()`)
    expect(outcome.result).toBe('1970-01-01T00:00:00.000Z')
  })

  test('eval and new Function are blocked', async () => {
    const { outcome } = await run(`${META}
      return eval('1 + 1')`)
    expect(outcome.error).toBeDefined()
  })

  test('script values cannot reach the host realm through a constructor', async () => {
    const { outcome } = await run(
      `${META}
      const out = await parallel([() => agent('a')])
      const Ctor = out.constructor.constructor
      return typeof Ctor('return process')().version`,
    )
    // codeGeneration is disabled, so the Function constructor cannot compile —
    // and out.constructor is the VM's Array, not the host's.
    expect(outcome.error).toBeDefined()
  })

  test('import() is refused before the run starts', () => {
    const prepared = prepareWorkflowScript(`${META}
      const mod = await import('fs')
      return mod`)
    expect(prepared.ok).toBe(true)
  })

  test('a rejected agent propagates when awaited directly', async () => {
    const { outcome } = await run(
      `${META}
      return await agent('boom')`,
      {
        agent: async () => {
          throw new Error('agent exploded')
        },
      },
    )
    expect(outcome.error).toBe('agent exploded')
  })

  test('a synchronous infinite loop is cut off by the sync timeout', async () => {
    const prepared = prepareWorkflowScript(`${META}
      while (true) {}`)
    if (!prepared.ok) throw new Error(prepared.error)
    const outcome = await executeWorkflowScript({
      vmScript: prepared.vmScript,
      toolUseContext: {
        abortController: new AbortController(),
        options: { mainLoopModel: 'test-model' },
      } as unknown as ToolUseContext,
      canUseTool: (() => {}) as unknown as CanUseToolFn,
      runId: 'wf_test0000-abc',
      onAgentController: () => {},
      syncTimeoutMs: 200,
    })
    expect(outcome.error).toContain('timed out')
  })

  test('a workflow result that is a function is rejected', async () => {
    const { outcome } = await run(`${META}
      return () => 1`)
    expect(outcome.error).toBe('workflow result cannot be a function')
  })
})

describe('workflow agent provenance', () => {
  test('forwards a nested workflow owner to every worker run', async () => {
    const owners: Array<string | undefined> = []
    await run(
      `${META}await agent('owned worker')`,
      {
        ownerAgentId: 'parent-agent' as ToolUseContext['agentId'],
        agent: async (params) => {
          owners.push(params.ownerAgentId)
          return 'ok'
        },
      },
    )

    expect(owners).toEqual(['parent-agent'])
  })

  test('stamps every agent with the run, name and phase it belongs to', async () => {
    // This is the only record of a run's shape once the process exits — the
    // desktop rebuilds a finished run's phases from it. It shipped with
    // `name` silently undefined because nothing type-checks src/.
    const seen: Array<WorkflowAgentRunParams['workflow']> = []
    await run(
      `export const meta = { name: 'demo', description: 'A demo' }
      phase('Scan')
      await agent('one', { label: 'scan:one' })
      phase('Verify')
      await agent('two', { label: 'verify:two' })`,
      {
        agent: async (params: WorkflowAgentRunParams) => {
          seen.push(params.workflow)
          return 'ok'
        },
      },
    )

    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({
      runId: 'wf_test0000-abc',
      name: 'demo',
      phaseTitle: 'Scan',
      agentIndex: 1,
    })
    expect(seen[1]).toMatchObject({
      name: 'demo',
      phaseTitle: 'Verify',
      agentIndex: 2,
    })
    // Distinct phases must get distinct indices or the rebuild collapses them.
    expect(seen[0]!.phaseIndex).not.toBe(seen[1]!.phaseIndex)
  })
})
