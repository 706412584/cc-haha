import vm from 'vm'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import { compileWorkflowScript, installDeterminismGuards } from './compile.js'
import {
  WORKFLOW_MAX_COLLECTED_LOGS,
  WORKFLOW_SYNC_TIMEOUT_MS,
} from './constants.js'
import { describeThrown } from './errors.js'
import {
  createWorkflowHarness,
  createWorkflowSharedCounters,
  type WorkflowHarness,
  type WorkflowHarnessParams,
  type WorkflowSharedCounters,
} from './harness.js'
import type { WorkflowJournal, WorkflowJournalSnapshot } from './journal.js'
import { parseWorkflowScript } from './meta.js'
import type {
  WorkflowMeta,
  WorkflowProgressEvent,
  WorkflowRunOutcome,
  WorkflowTokenBudget,
} from './types.js'

export type WorkflowExecutionParams = {
  vmScript: vm.Script
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  runId: string
  /** `meta.name`, persisted with each agent so a finished run is identifiable. */
  workflowName: string
  args?: unknown
  seedPhaseTitles?: string[]
  tokenBudget?: WorkflowTokenBudget
  journal?: WorkflowJournal
  journalSnapshot?: WorkflowJournalSnapshot
  onProgress?: (event: WorkflowProgressEvent) => void
  onAgentController: (
    agentKey: string,
    controller: AbortController | undefined,
  ) => void
  /** Runs a saved workflow inline; `undefined` disables the `workflow()` global. */
  runNestedWorkflow?: (nameOrRef: unknown, args: unknown) => Promise<unknown>
  syncTimeoutMs?: number
  /** Overridable so tests can drive a whole run without a live model. */
  runAgentImpl?: WorkflowHarnessParams['runAgentImpl']
  /** Concurrency and agent-index counters, shared with any nested run. */
  shared?: WorkflowSharedCounters
}

/**
 * Execute a compiled workflow script and return its result.
 *
 * The script runs in a `node:vm` context that holds nothing but the harness
 * globals. Every value that crosses the boundary is rebuilt on the far side:
 * handing VM code a live host object would expose `obj.constructor.constructor`
 * — the host `Function` constructor — and with it the whole process.
 */
export async function executeWorkflowScript(
  params: WorkflowExecutionParams,
): Promise<WorkflowRunOutcome> {
  const startedAt = Date.now()
  const logs: string[] = []
  const abortSignal = params.toolUseContext.abortController?.signal

  const emit = (event: WorkflowProgressEvent): void => {
    if (
      event.type === 'workflow_log' &&
      logs.length < WORKFLOW_MAX_COLLECTED_LOGS
    ) {
      logs.push(event.message)
    }
    params.onProgress?.(event)
  }

  const harness = createWorkflowHarness({
    toolUseContext: params.toolUseContext,
    canUseTool: params.canUseTool,
    runId: params.runId,
    workflowName: params.workflowName,
    emit,
    seedPhaseTitles: params.seedPhaseTitles,
    tokenBudget: params.tokenBudget,
    journal: params.journal,
    journalSnapshot: params.journalSnapshot,
    onAgentController: params.onAgentController,
    abortSignal,
    runAgentImpl: params.runAgentImpl,
    shared: params.shared ?? createWorkflowSharedCounters(),
  })

  const sandbox = createWorkflowSandbox({
    harness,
    tokenBudget: params.tokenBudget,
    args: params.args,
    emit,
    abortSignal,
    runNestedWorkflow: params.runNestedWorkflow,
  })

  let detachAbort: (() => void) | undefined
  try {
    const pending = params.vmScript.runInContext(sandbox.context, {
      timeout: params.syncTimeoutMs ?? WORKFLOW_SYNC_TIMEOUT_MS,
    })
    const settled = sandbox.awaitInVm(pending) as Promise<{ v: unknown }>
    settled.catch(() => {})

    let raced: { v: unknown }
    if (abortSignal) {
      raced = await Promise.race([
        settled,
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new Error('Workflow aborted'))
          if (abortSignal.aborted) onAbort()
          else {
            abortSignal.addEventListener('abort', onAbort, { once: true })
            detachAbort = () =>
              abortSignal.removeEventListener('abort', onAbort)
          }
        }),
      ])
    } else {
      raced = await settled
    }

    const result = sandbox.exportValue(raced.v)
    await params.journal?.flush()
    return {
      result,
      agentCount: harness.getAgentCount(),
      logs,
      failures: harness.getFailures(),
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const message = describeError(error)
    logForDebugging(`Workflow ${params.runId} script error: ${message}`)
    await params.journal?.flush().catch(() => {})
    return {
      result: null,
      agentCount: harness.getAgentCount(),
      logs,
      failures: harness.getFailures(),
      durationMs: Date.now() - startedAt,
      error: message,
    }
  } finally {
    detachAbort?.()
    sandbox.dispose()
  }
}

type SandboxParams = {
  harness: WorkflowHarness
  tokenBudget?: WorkflowTokenBudget
  args?: unknown
  emit: (event: WorkflowProgressEvent) => void
  abortSignal?: AbortSignal
  runNestedWorkflow?: (nameOrRef: unknown, args: unknown) => Promise<unknown>
}

type WorkflowSandbox = {
  context: vm.Context
  awaitInVm: (value: unknown) => Promise<{ v: unknown }>
  exportValue: (value: unknown) => unknown
  dispose: () => void
}

function createWorkflowSandbox(params: SandboxParams): WorkflowSandbox {
  const { harness, tokenBudget, emit, abortSignal, runNestedWorkflow } = params

  // codeGeneration off: `eval` and `new Function` inside the script would
  // otherwise reconstruct anything the sandbox withholds.
  const context = vm.createContext(Object.create(null) as object, {
    codeGeneration: { strings: false, wasm: false },
  })
  installDeterminismGuards(context)

  const evalInVm = <T>(source: string): T =>
    vm.runInContext(source, context, { filename: 'workflow-bridge.js' }) as T

  const awaitInVm = evalInVm<(value: unknown) => Promise<{ v: unknown }>>(
    '(async v => ({ __proto__: null, v: await v }))',
  )
  const parseInVm = evalInVm<(json: string) => unknown>('(json => JSON.parse(json))')
  const stringifyInVm = evalInVm<(value: unknown) => string | undefined>(
    '(value => JSON.stringify(value, (_k, v) => typeof v === "function" ? undefined : v))',
  )
  const newArrayInVm = evalInVm<(length: number) => unknown[]>(
    '(length => new Array(length))',
  )
  const setIndexInVm = evalInVm<
    (array: unknown, index: number, value: unknown) => void
  >('((array, index, value) => { array[index] = value })')
  // Host functions are never exposed directly: the script would reach the host
  // realm through `fn.constructor`. Each one is re-wrapped by a VM arrow whose
  // closure holds the host reference out of reach.
  const wrapAsyncInVm = evalInVm<
    (hostFn: (...args: unknown[]) => Promise<unknown>) => unknown
  >('(hostFn => async (...args) => hostFn(...args))')
  const wrapSyncInVm = evalInVm<(hostFn: (...args: unknown[]) => void) => unknown>(
    '(hostFn => (...args) => { hostFn(...args) })',
  )

  /** Rebuild a host value inside the VM realm. */
  const intake = (value: unknown): unknown => {
    if (value === undefined) return undefined
    if (value === null) return null
    const primitive = typeof value
    if (primitive === 'string' || primitive === 'number' || primitive === 'boolean') {
      return value
    }
    let json: string | undefined
    try {
      json = JSON.stringify(value)
    } catch {
      json = undefined
    }
    if (json === undefined) return null
    return parseInVm(json)
  }

  /** Rebuild a VM array of already-VM elements without copying the elements. */
  const intakeArray = (values: unknown[]): unknown[] => {
    const array = newArrayInVm(values.length)
    for (let i = 0; i < values.length; i++) setIndexInVm(array, i, values[i])
    return array
  }

  const timers = new Set<NodeJS.Timeout>()
  const clearAllTimers = (): void => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
  abortSignal?.addEventListener('abort', clearAllTimers, { once: true })

  const defineGlobal = (name: string, value: unknown): void => {
    Object.defineProperty(context, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }

  defineGlobal(
    'agent',
    wrapAsyncInVm(async (prompt, opts) =>
      intake(await harness.agent(prompt, opts)),
    ),
  )
  defineGlobal(
    'parallel',
    wrapAsyncInVm(async thunks => intakeArray(await harness.parallel(thunks))),
  )
  defineGlobal(
    'pipeline',
    wrapAsyncInVm(async (items, ...stages) =>
      intakeArray(await harness.pipeline(items, ...stages)),
    ),
  )
  defineGlobal('log', wrapSyncInVm(message => harness.log(message)))
  defineGlobal('phase', wrapSyncInVm(title => harness.phase(title)))
  defineGlobal(
    'workflow',
    wrapAsyncInVm(async (nameOrRef, args) => {
      if (!runNestedWorkflow) {
        throw new Error('workflow() is not available in this run')
      }
      return intake(await runNestedWorkflow(nameOrRef, args))
    }),
  )

  // budget is built inside the VM so `budget.spent.constructor` resolves to the
  // VM's Function, not the host's.
  const makeBudget = evalInVm<
    (
      total: number | null,
      spent: () => number,
      remaining: () => number,
    ) => unknown
  >(
    '((total, spent, remaining) => Object.freeze({ __proto__: null, total, spent: () => spent(), remaining: () => remaining() }))',
  )
  defineGlobal(
    'budget',
    makeBudget(
      tokenBudget?.total ?? null,
      () => tokenBudget?.getTurnSpent() ?? 0,
      () =>
        tokenBudget?.total == null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, tokenBudget.total - tokenBudget.getTurnSpent()),
    ),
  )

  const makeConsole = evalInVm<(write: (line: string) => void) => unknown>(
    `(write => {
      const render = args => args.map(a => {
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) ?? String(a) } catch { return '[object]' }
      }).join(' ')
      const emit = (...args) => { write(render(args)) }
      return Object.freeze({ __proto__: null, log: emit, info: emit, warn: emit, error: emit, debug: emit })
    })`,
  )
  defineGlobal(
    'console',
    makeConsole(line => emit({ type: 'workflow_log', message: line })),
  )

  const makeTimers = evalInVm<
    (
      set: (callback: unknown, ms: unknown) => unknown,
      clear: (handle: unknown) => void,
    ) => { setTimeout: unknown; clearTimeout: unknown }
  >(
    `((set, clear) => ({
      __proto__: null,
      setTimeout: (callback, ms) => set(callback, ms),
      clearTimeout: handle => { clear(handle) },
    }))`,
  )
  const vmTimers = makeTimers(
    (callback, ms) => {
      if (typeof callback !== 'function') return 0
      const delay = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0
      const timer = setTimeout(() => {
        timers.delete(timer)
        try {
          ;(callback as () => void)()
        } catch (error) {
          logForDebugging(`workflow setTimeout callback threw: ${describeError(error)}`)
        }
      }, Math.max(0, delay))
      timer.unref?.()
      timers.add(timer)
      return timer
    },
    handle => {
      if (handle && typeof handle === 'object') {
        clearTimeout(handle as NodeJS.Timeout)
        timers.delete(handle as NodeJS.Timeout)
      }
    },
  )
  defineGlobal('setTimeout', vmTimers.setTimeout)
  defineGlobal('clearTimeout', vmTimers.clearTimeout)

  if (params.args !== undefined) {
    const json = JSON.stringify(params.args)
    defineGlobal('args', json === undefined ? undefined : parseInVm(json))
  } else {
    defineGlobal('args', undefined)
  }

  return {
    context,
    awaitInVm,
    exportValue(value: unknown): unknown {
      if (typeof value === 'function') {
        throw new Error('workflow result cannot be a function')
      }
      if (value === undefined) return null
      const json = stringifyInVm(value)
      if (json === undefined) return null
      return JSON.parse(json) as unknown
    },
    dispose: clearAllTimers,
  }
}

const describeError = describeThrown

/**
 * Parse + compile a script in one step. Used by the tool, the resume path, and
 * the tests so all three reject the same scripts for the same reasons.
 */
export function prepareWorkflowScript(
  script: string,
): PreparedWorkflowScript {
  const parsed = parseWorkflowScript(script)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  const compiled = compileWorkflowScript(parsed.scriptBody)
  if (!compiled.ok) return { ok: false, error: compiled.error }
  return {
    ok: true,
    meta: parsed.meta,
    scriptBody: parsed.scriptBody,
    vmScript: compiled.vmScript,
  }
}

export type PreparedWorkflowScript =
  | {
      ok: true
      meta: WorkflowMeta
      scriptBody: string
      vmScript: vm.Script
    }
  | { ok: false; error: string }
