import vm from 'vm'
import {
  WORKFLOW_DATE_BANNED_MESSAGE,
  WORKFLOW_IMPORT_BANNED_MESSAGE,
  WORKFLOW_RANDOM_BANNED_MESSAGE,
} from './constants.js'

export type WorkflowCompileResult =
  | { ok: true; vmScript: vm.Script }
  | { ok: false; error: string }

/**
 * Remove the two sources of nondeterminism that would break resume.
 *
 * A resumed run replays cached agent results in start order. A script whose
 * control flow depends on wall-clock time or randomness would take a different
 * branch on replay and silently consume the wrong cache entries, so both are
 * made to throw at the first call rather than shimmed into something plausible.
 *
 * Installed on the context (not prepended to the script) so `globalThis.Date`
 * and an aliased `const r = Math.random` are covered too.
 */
export function installDeterminismGuards(context: vm.Context): void {
  vm.runInContext(
    `(() => {
      const dateMessage = ${JSON.stringify(WORKFLOW_DATE_BANNED_MESSAGE)}
      const randomMessage = ${JSON.stringify(WORKFLOW_RANDOM_BANNED_MESSAGE)}
      const RealDate = Date
      globalThis.Date = new Proxy(RealDate, {
        construct(target, argv, newTarget) {
          if (argv.length === 0) throw new Error(dateMessage)
          return Reflect.construct(target, argv, newTarget === undefined ? target : newTarget)
        },
        get(target, prop, receiver) {
          if (prop === 'now') throw new Error(dateMessage)
          return Reflect.get(target, prop, receiver)
        },
      })
      Math.random = () => {
        throw new Error(randomMessage)
      }
    })()`,
    context,
    { filename: 'workflow-guards.js' },
  )
}

/**
 * Compile a script body into a `vm.Script` that evaluates to a promise.
 *
 * The body runs inside an async IIFE so a bare top-level `return` resolves the
 * run and `await` works without the script declaring anything. Dynamic
 * `import()` is refused at the module-resolution hook rather than by a lint
 * pass, so there is no spelling of it that gets through.
 */
export function compileWorkflowScript(
  scriptBody: string,
): WorkflowCompileResult {
  const source = `(async () => {\n${scriptBody}\n})()`
  try {
    const vmScript = new vm.Script(source, {
      filename: 'workflow.js',
      importModuleDynamically: () => {
        throw new Error(WORKFLOW_IMPORT_BANNED_MESSAGE)
      },
    })
    return { ok: true, vmScript }
  } catch (error) {
    return {
      ok: false,
      error: `SyntaxError: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
