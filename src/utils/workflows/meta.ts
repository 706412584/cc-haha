import { parse } from 'acorn'
import { simple as walkSimple } from 'acorn-walk'
import { WORKFLOW_SCRIPT_MAX_BYTES } from './constants.js'
import type { WorkflowMeta, WorkflowPhaseMeta } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any
/* eslint-enable @typescript-eslint/no-explicit-any */

export type WorkflowParseResult =
  | { meta: WorkflowMeta; scriptBody: string }
  | { error: string }

export type WorkflowRenameResult =
  | { script: string }
  | { error: string }

const PLAIN_JS_HINT =
  'Workflow scripts must be plain JavaScript — common causes are TypeScript syntax ' +
  '(type annotations, interfaces, generics) and broken string quoting or escaping.'

const CARET_WINDOW = 80

const ACORN_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
} as const

/**
 * Split a workflow script into its `meta` literal and the executable body.
 *
 * `meta` must be the very first statement and a pure literal: the discovery
 * path reads it for every saved workflow at `/` autocomplete time, so it can
 * never be allowed to run code or reference anything outside itself.
 */
export function parseWorkflowScript(script: string): WorkflowParseResult {
  if (Buffer.byteLength(script, 'utf8') > WORKFLOW_SCRIPT_MAX_BYTES) {
    return { error: `Script exceeds ${WORKFLOW_SCRIPT_MAX_BYTES} bytes` }
  }

  let program: AnyNode
  try {
    program = parse(script, ACORN_OPTIONS as never)
  } catch (error) {
    return { error: formatParseError(error, script) }
  }

  const first = program.body[0]
  if (!first || first.type !== 'ExportNamedDeclaration' || !isMetaExport(first)) {
    return {
      error:
        '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
    }
  }

  const init = first.declaration.declarations[0].init
  let literal: unknown
  try {
    literal = evaluateObjectLiteral(init)
  } catch (error) {
    return {
      error: `meta must be a pure literal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  const validated = validateMeta(literal)
  if ('error' in validated) return validated

  // Drop the trailing `;` and the newline that ended the export so line
  // numbers in runtime stack traces line up with the body the user wrote.
  const scriptBody = script.slice(first.end).replace(/^[;\s]*\n/, '').trimStart()
  return { meta: validated.meta, scriptBody }
}

/**
 * Rename the command exported by a workflow without touching matching text in
 * its description or executable body.
 *
 * Saved workflows are discovered from `meta.name`, not their filename. The
 * desktop therefore needs to update the parsed metadata whenever a user picks
 * a different `/name`; a text replacement would also rewrite prompts and
 * descriptions that happen to mention the old name.
 */
export function renameWorkflowScript(
  script: string,
  name: string,
): WorkflowRenameResult {
  const parsed = parseWorkflowScript(script)
  if ('error' in parsed) return parsed

  const nameError = validateWorkflowName(name)
  if (nameError) return { error: nameError }

  let program: AnyNode
  try {
    program = parse(script, ACORN_OPTIONS as never)
  } catch (error) {
    return { error: formatParseError(error, script) }
  }
  const init = program.body[0].declaration.declarations[0].init
  const nameProperties = init.properties.filter(
    (property: AnyNode) =>
      property.type === 'Property' &&
      !property.computed &&
      ((property.key.type === 'Identifier' && property.key.name === 'name') ||
        (property.key.type === 'Literal' && property.key.value === 'name')),
  )
  const property = nameProperties.at(-1)
  if (!property) return { error: 'meta.name must be a non-empty string' }

  const original = script.slice(property.value.start, property.value.end)
  const quote = original.startsWith("'") ? "'" : '"'
  const renamed = `${script.slice(0, property.value.start)}${quote}${name}${quote}${script.slice(property.value.end)}`
  const reparsed = parseWorkflowScript(renamed)
  if ('error' in reparsed) return reparsed
  return { script: renamed }
}

/**
 * True when the script reads `Date.now()`, `new Date()` or `Math.random()`.
 * Those are unavailable at runtime (they would make a resume replay diverge),
 * so the caller surfaces a targeted hint instead of a bare TypeError.
 */
export function usesBannedNondeterminism(script: string): boolean {
  let found = false
  try {
    const program = parse(script, ACORN_OPTIONS as never)
    walkSimple(program as never, {
      MemberExpression(node: AnyNode) {
        if (
          node.computed ||
          node.object.type !== 'Identifier' ||
          node.property.type !== 'Identifier'
        ) {
          return
        }
        const object = node.object.name
        const property = node.property.name
        if (
          (object === 'Date' && property === 'now') ||
          (object === 'Math' && property === 'random')
        ) {
          found = true
        }
      },
      NewExpression(node: AnyNode) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'Date' &&
          node.arguments.length === 0
        ) {
          found = true
        }
      },
    })
  } catch {
    return false
  }
  return found
}

function isMetaExport(node: AnyNode): boolean {
  const declaration = node.declaration
  if (!declaration || declaration.type !== 'VariableDeclaration') return false
  if (declaration.kind !== 'const' || declaration.declarations.length !== 1) {
    return false
  }
  const declarator = declaration.declarations[0]
  return (
    declarator.id.type === 'Identifier' &&
    declarator.id.name === 'meta' &&
    declarator.init?.type === 'ObjectExpression'
  )
}

/**
 * Evaluate an ObjectExpression made only of literals. Anything that could
 * observe or mutate the outside world (identifiers, calls, spread, getters)
 * throws, which the caller reports as "meta must be a pure literal".
 */
function evaluateObjectLiteral(node: AnyNode): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const property of node.properties) {
    if (property.type === 'SpreadElement') {
      throw new Error('spread not allowed in meta')
    }
    if (property.kind !== 'init' || property.method) {
      throw new Error('only plain key: value pairs are allowed in meta')
    }
    let key: string
    if (property.computed) {
      throw new Error('computed keys not allowed in meta')
    } else if (property.key.type === 'Identifier') {
      key = property.key.name
    } else if (property.key.type === 'Literal') {
      key = String(property.key.value)
    } else {
      throw new Error('unsupported key in meta')
    }
    result[key] = evaluateLiteral(property.value)
  }
  return result
}

function evaluateLiteral(node: AnyNode): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value
    case 'ArrayExpression':
      return node.elements.map((element: AnyNode) => {
        if (element === null) throw new Error('sparse arrays not allowed')
        if (element.type === 'SpreadElement') {
          throw new Error('spread not allowed in meta')
        }
        return evaluateLiteral(element)
      })
    case 'ObjectExpression':
      return evaluateObjectLiteral(node)
    case 'TemplateLiteral': {
      if (node.expressions.length > 0) {
        throw new Error('template interpolation not allowed in meta')
      }
      return node.quasis
        .map((quasi: AnyNode) => quasi.value.cooked ?? '')
        .join('')
    }
    case 'UnaryExpression': {
      if (node.operator === '-' && node.argument.type === 'Literal') {
        return -(node.argument.value as number)
      }
      throw new Error(`unsupported expression: ${node.operator}`)
    }
    default:
      throw new Error(`unsupported expression: ${node.type}`)
  }
}

function validateMeta(
  value: unknown,
): { meta: WorkflowMeta } | { error: string } {
  if (typeof value !== 'object' || value === null) {
    return { error: 'meta must be an object literal' }
  }
  const raw = value as Record<string, unknown>
  const name = raw.name
  const nameError = validateWorkflowName(name)
  if (nameError) return { error: nameError }
  const description = raw.description
  if (typeof description !== 'string' || description.trim() === '') {
    return { error: 'meta.description must be a non-empty string' }
  }

  const meta: WorkflowMeta = { name: name as string, description }
  if (typeof raw.whenToUse === 'string') meta.whenToUse = raw.whenToUse
  if (typeof raw.title === 'string') meta.title = raw.title
  if (typeof raw.model === 'string') meta.model = raw.model

  if (raw.phases !== undefined) {
    if (!Array.isArray(raw.phases)) {
      return { error: 'meta.phases must be an array' }
    }
    const phases: WorkflowPhaseMeta[] = []
    for (const entry of raw.phases) {
      if (typeof entry !== 'object' || entry === null) {
        return { error: 'each meta.phases entry must be an object' }
      }
      const phase = entry as Record<string, unknown>
      if (typeof phase.title !== 'string' || phase.title.trim() === '') {
        return { error: 'each meta.phases entry needs a non-empty title' }
      }
      const parsed: WorkflowPhaseMeta = { title: phase.title }
      if (typeof phase.detail === 'string') parsed.detail = phase.detail
      if (typeof phase.model === 'string') parsed.model = phase.model
      phases.push(parsed)
    }
    meta.phases = phases
  }

  return { meta }
}

function validateWorkflowName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'meta.name must be a non-empty string'
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    return `meta.name '${value}' must start with a letter or digit and contain only letters, digits, '-' and '_'`
  }
  return undefined
}

function formatParseError(error: unknown, script: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const loc = hasLoc(error) ? error.loc : undefined
  const line = loc ? script.split('\n')[loc.line - 1] : undefined
  if (!loc || line === undefined) {
    return `Script parse error: ${message}. ${PLAIN_JS_HINT}`
  }
  const column = Math.max(0, Math.min(loc.column, line.length))
  const start = Math.max(
    0,
    Math.min(column - Math.floor(CARET_WINDOW / 2), line.length - CARET_WINDOW),
  )
  const excerpt = line.slice(start, start + CARET_WINDOW)
  const caret = `${' '.repeat(column - start)}^`
  return `Script parse error: ${message}\n${excerpt}\n${caret}\n${PLAIN_JS_HINT}`
}

function hasLoc(
  error: unknown,
): error is { loc: { line: number; column: number } } {
  if (typeof error !== 'object' || error === null || !('loc' in error)) {
    return false
  }
  const loc = (error as { loc: unknown }).loc
  return (
    typeof loc === 'object' &&
    loc !== null &&
    'line' in loc &&
    typeof (loc as { line: unknown }).line === 'number' &&
    'column' in loc &&
    typeof (loc as { column: unknown }).column === 'number'
  )
}
