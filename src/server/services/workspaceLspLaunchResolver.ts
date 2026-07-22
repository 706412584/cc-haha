import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { isInBundledMode } from '../../utils/bundledMode.js'
import type { KnownLanguageServerLaunchDescriptor } from './knownLanguageServers.js'

export type WorkspaceLspLaunchPlan = {
  command: string
  args: string[]
  shell: false
  displayCommand: string
}

export class WorkspaceLspPrerequisiteError extends Error {
  readonly reason = 'prereq-missing' as const
}

type ResolveOptions = {
  workspaceRoot: string
  descriptor: KnownLanguageServerLaunchDescriptor
  compiled?: boolean
  execPath?: string
  prefixRoots?: readonly string[]
  localRoots?: readonly string[]
}

export async function resolveWorkspaceLspLaunch(
  options: ResolveOptions,
): Promise<WorkspaceLspLaunchPlan> {
  const packageRoot = await locatePackageRoot(options)
  if (!packageRoot) {
    throw new WorkspaceLspPrerequisiteError(
      `${options.descriptor.label} is not installed`,
    )
  }

  const entry = await resolvePackageBin(
    packageRoot,
    options.descriptor.packageName,
    options.descriptor.binName,
  )
  const execPath = options.execPath ?? process.execPath
  const presetArgs = [...options.descriptor.presetArgs]
  return options.compiled ?? isInBundledMode()
    ? {
        command: execPath,
        args: ['lsp', '--package-root', packageRoot, '--entry', entry, '--', ...presetArgs],
        shell: false,
        displayCommand: options.descriptor.binName,
      }
    : {
        command: execPath,
        args: [entry, ...presetArgs],
        shell: false,
        displayCommand: options.descriptor.binName,
      }
}

export function resolveExplicitWorkspaceLspLaunch(
  command: string,
  args: readonly string[],
): WorkspaceLspLaunchPlan {
  return {
    command,
    args: [...args],
    shell: false,
    displayCommand: path.basename(command),
  }
}

async function locatePackageRoot(options: ResolveOptions): Promise<string | null> {
  const candidates = new Set<string>()
  for (const root of options.localRoots ?? defaultLocalRoots(options.workspaceRoot)) {
    candidates.add(path.join(root, 'node_modules', options.descriptor.packageName))
  }
  for (const prefix of options.prefixRoots ?? defaultNpmPrefixRoots()) {
    candidates.add(path.join(prefix, 'node_modules', options.descriptor.packageName))
    candidates.add(path.join(prefix, 'lib', 'node_modules', options.descriptor.packageName))
  }

  for (const candidate of candidates) {
    try {
      const canonical = await fs.realpath(candidate)
      const stat = await fs.stat(canonical)
      if (stat.isDirectory()) return canonical
    } catch {
      // Missing and unreadable roots are ordinary prerequisite misses.
    }
  }
  return null
}

function defaultLocalRoots(workspaceRoot: string): string[] {
  return [workspaceRoot, process.cwd(), process.env.CLAUDE_APP_ROOT]
    .filter((value): value is string => Boolean(value))
}

function defaultNpmPrefixRoots(): string[] {
  const values = [process.env.NPM_CONFIG_PREFIX]
  if (process.platform === 'win32') {
    if (process.env.APPDATA) values.push(path.join(process.env.APPDATA, 'npm'))
  } else {
    if (process.env.HOME) values.push(path.join(process.env.HOME, '.npm-global'))
    values.push('/usr/local')
  }
  return values.filter((value): value is string => Boolean(value))
}

async function resolvePackageBin(
  packageRoot: string,
  expectedPackageName: string,
  binName: string,
): Promise<string> {
  const packageJsonPath = path.join(packageRoot, 'package.json')
  let manifest: { name?: unknown; bin?: unknown }
  try {
    manifest = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
      name?: unknown
      bin?: unknown
    }
  } catch {
    throw new WorkspaceLspPrerequisiteError(`${binName} package metadata is unavailable`)
  }
  if (manifest.name !== expectedPackageName) {
    throw new WorkspaceLspPrerequisiteError(`${binName} package metadata does not match`)
  }

  const bin = typeof manifest.bin === 'string'
    ? manifest.bin
    : isStringRecord(manifest.bin)
      ? manifest.bin[binName]
      : undefined
  if (typeof bin !== 'string' || !bin) {
    throw new WorkspaceLspPrerequisiteError(`${binName} package executable is unavailable`)
  }
  if (path.isAbsolute(bin) || bin.split(/[\\/]+/).includes('..')) {
    throw new WorkspaceLspPrerequisiteError(`${binName} package executable is invalid`)
  }
  if (!/\.(?:js|cjs|mjs)$/i.test(bin)) {
    throw new WorkspaceLspPrerequisiteError(`${binName} package executable is not JavaScript`)
  }

  const lexicalEntry = path.resolve(packageRoot, bin)
  let canonicalRoot: string
  let canonicalEntry: string
  try {
    canonicalRoot = await fs.realpath(packageRoot)
    canonicalEntry = await fs.realpath(lexicalEntry)
    if (!(await fs.stat(canonicalEntry)).isFile()) throw new Error('not a file')
  } catch {
    throw new WorkspaceLspPrerequisiteError(`${binName} package executable is unavailable`)
  }
  if (!isContained(canonicalRoot, canonicalEntry)) {
    throw new WorkspaceLspPrerequisiteError(`${binName} package executable escapes its package`)
  }
  return canonicalEntry
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}
