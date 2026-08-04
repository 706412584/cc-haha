import fs from 'node:fs/promises'
import path from 'node:path'

export type SidecarMode = 'server' | 'cli' | 'adapters' | 'lsp'

const EXPLICIT_MODES = new Set<SidecarMode>(['server', 'cli', 'adapters', 'lsp'])
const DESKTOP_CLI_NAMES = new Set(['claude-haha', 'claude-haha.exe'])

export function resolveSidecarInvocation(
  rawArgs: string[],
  execPath: string = process.execPath,
  envAppRoot: string | null = process.env.CLAUDE_APP_ROOT ?? null,
): {
  mode: SidecarMode | null
  restArgs: string[]
  defaultAppRoot: string | null
} {
  const explicitMode = rawArgs[0]
  if (explicitMode && EXPLICIT_MODES.has(explicitMode as SidecarMode)) {
    return {
      mode: explicitMode as SidecarMode,
      restArgs: rawArgs.slice(1),
      defaultAppRoot: envAppRoot,
    }
  }

  const execName = path.basename(execPath).toLowerCase()
  if (DESKTOP_CLI_NAMES.has(execName)) {
    return {
      mode: 'cli',
      restArgs: rawArgs,
      defaultAppRoot: envAppRoot ?? path.dirname(execPath),
    }
  }

  return {
    mode: null,
    restArgs: rawArgs,
    defaultAppRoot: envAppRoot,
  }
}

export function parseLspLauncherArgs(rawArgs: string[]): {
  packageRoot: string
  entry: string
  args: string[]
} {
  if (rawArgs[0] !== '--package-root' || !rawArgs[1]) {
    throw new Error('claude-sidecar lsp requires --package-root <path>')
  }
  if (rawArgs[2] !== '--entry' || !rawArgs[3]) {
    throw new Error('claude-sidecar lsp requires --entry <path>')
  }
  if (rawArgs[4] !== '--') {
    throw new Error('claude-sidecar lsp requires -- before server arguments')
  }
  return { packageRoot: rawArgs[1], entry: rawArgs[3], args: rawArgs.slice(5) }
}

export async function validateLspEntry(
  entry: string,
  expectedPackageRoot?: string,
): Promise<string> {
  const canonicalEntry = await fs.realpath(entry)
  let current = path.dirname(canonicalEntry)
  let canonicalRoot: string | null = null
  while (true) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(current, 'package.json'), 'utf8')) as {
        name?: unknown
      }
      if (typeof parsed.name === 'string' && parsed.name) {
        canonicalRoot = await fs.realpath(current)
        break
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    const parent = path.dirname(current)
    if (parent === current) throw new Error('claude-sidecar lsp entry has no package root')
    current = parent
  }
  if (expectedPackageRoot) {
    const expectedRoot = await fs.realpath(expectedPackageRoot)
    if (expectedRoot !== canonicalRoot) {
      throw new Error('claude-sidecar lsp package root does not match')
    }
  }
  const relative = path.relative(canonicalRoot, canonicalEntry)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !/\.(?:js|cjs|mjs)$/i.test(canonicalEntry) ||
    !(await fs.stat(canonicalEntry)).isFile()
  ) {
    throw new Error('claude-sidecar lsp entry is outside its package')
  }
  return canonicalEntry
}

export function parseLauncherArgs(
  rawArgs: string[],
  defaultAppRoot: string | null = process.env.CLAUDE_APP_ROOT ?? null,
): { appRoot: string; args: string[] } {
  const nextArgs: string[] = []
  let appRoot: string | null = defaultAppRoot

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]
    if (arg === '--app-root') {
      appRoot = rawArgs[index + 1] ?? null
      index += 1
      continue
    }
    nextArgs.push(arg!)
  }

  if (!appRoot) {
    throw new Error('Missing --app-root for claude-sidecar')
  }

  return { appRoot, args: nextArgs }
}
