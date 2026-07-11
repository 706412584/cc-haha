import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SAFE_INHERITED_ENV_NAMES = new Set([
  'CI',
  'COMSPEC',
  'GITHUB_ACTIONS',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'RUNNER_ARCH',
  'RUNNER_OS',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
])

export function createOfflineTestEnvironment(
  overrides: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const safeName of SAFE_INHERITED_ENV_NAMES) {
    const entry = Object.entries(source).find(([name]) => name.toUpperCase() === safeName)
    if (entry?.[1] !== undefined) {
      environment[safeName] = entry[1]
    }
  }

  return {
    ...environment,
    ...overrides,
  }
}

export function createSandboxedTestEnvironment(
  sandboxHome: string,
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
) {
  const configHome = join(sandboxHome, '.config')
  const dataHome = join(sandboxHome, '.local', 'share')
  const cacheHome = join(sandboxHome, '.cache')
  const stateHome = join(sandboxHome, '.local', 'state')
  const tempHome = join(sandboxHome, 'tmp')
  for (const directory of [configHome, dataHome, cacheHome, stateHome, tempHome]) {
    mkdirSync(directory, { recursive: true })
  }

  return createOfflineTestEnvironment({
    HOME: sandboxHome,
    USERPROFILE: sandboxHome,
    APPDATA: configHome,
    LOCALAPPDATA: join(sandboxHome, '.local'),
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    CODEX_HOME: join(sandboxHome, '.codex'),
    GH_CONFIG_DIR: join(configHome, 'gh'),
    CLAUDE_CONFIG_DIR: join(sandboxHome, '.claude'),
    TEMP: tempHome,
    TMP: tempHome,
    TMPDIR: tempHome,
    BUN_OPTIONS: '--no-env-file',
    CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
    NODE_ENV: 'test',
    ...overrides,
  }, source)
}
