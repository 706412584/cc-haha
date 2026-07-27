/**
 * Skill root directories — the single source of truth for where skills live.
 *
 * Two flavors coexist:
 *  - `claude`: our native `.claude/skills` layout
 *  - `agents`: the cross-client `.agents/skills` convention (https://agentskills.io),
 *    also scanned by OpenAI Codex, Cursor, Gemini CLI, and opencode. Skills
 *    installed by any of those tools become visible here, and vice versa.
 *
 * The `.agents` user root is deliberately anchored at `$HOME` rather than at
 * CLAUDE_CONFIG_DIR: it is a shared space owned by no single client, and
 * following our own config dir would put us out of step with every other tool
 * that reads it.
 *
 * Within a single scope, `.claude` is listed before `.agents` so that first-wins
 * dedup keeps the user's own skills authoritative — installing a same-named
 * skill from another tool never silently shadows one of theirs.
 */

import { homedir } from 'os'
import { join, resolve } from 'path'
import { statSync } from 'fs'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../utils/envUtils.js'
import { isFsInaccessible } from '../utils/errors.js'
import { walkProjectDirsUpToHome } from '../utils/markdownConfigLoader.js'
// Import as module object so spyOn works in tests (direct imports bypass spies)
import * as settingsModule from '../utils/settings/settings.js'

export type SkillRootFlavor = 'claude' | 'agents'

export type SkillRoot = {
  /** Absolute path to the skills directory */
  path: string
  flavor: SkillRootFlavor
  /**
   * Identifies the scope this root belongs to. Roots sharing a scopeKey are
   * alternate spellings of the same location, so a same-named skill appearing
   * in two of them is a collision rather than a legitimate override.
   */
  scopeKey: string
}

/** Directory name for the cross-client Agent Skills convention. */
export const AGENT_SKILLS_DIR = '.agents'

/**
 * Whether `.agents/skills` directories are scanned.
 *
 * Enabled by default. Turn off via `disableAgentSkillsDirectory` in settings.json
 * or the CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR env var. When disabled, no
 * `.agents` root is produced at all, so there is not even a failed stat call.
 */
export function isAgentSkillsDirectoryEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR)) {
    return false
  }
  try {
    return settingsModule.getSettings_DEPRECATED().disableAgentSkillsDirectory !== true
  } catch {
    // Settings unavailable (early startup, corrupt file) — default to enabled.
    return true
  }
}

function directoryExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (e: unknown) {
    if (!isFsInaccessible(e)) throw e
    return false
  }
}

/**
 * The user's home directory, preferring $HOME/$USERPROFILE over os.homedir().
 *
 * Node's os.homedir() consults $HOME on every call, but Bun snapshots it at
 * process start — so under Bun a runtime change to $HOME would otherwise be
 * invisible. Reading the env var first gives both runtimes Node's documented
 * behavior, which is what callers (and tests) expect.
 */
function resolveHomeDir(): string {
  const fromEnv =
    process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME
  const home = fromEnv !== undefined && fromEnv !== '' ? fromEnv : homedir()
  return resolve(home).normalize('NFC')
}

/**
 * The user-level `.agents/skills` path, anchored at the home directory.
 * Exported so the change detector and diagnostics agree on it.
 */
export function getUserAgentSkillsDir(): string {
  return join(resolveHomeDir(), AGENT_SKILLS_DIR, 'skills')
}

/**
 * User-level skill roots, `.claude` first.
 *
 * Unlike the project variants these are not existence-filtered: the loader
 * tolerates a missing directory (one readdir that fails), and filtering here
 * would make the roots vary between calls in a way callers don't expect.
 */
export function getUserSkillRoots(): SkillRoot[] {
  const roots: SkillRoot[] = [
    {
      path: join(getClaudeConfigHomeDir(), 'skills'),
      flavor: 'claude',
      scopeKey: 'user',
    },
  ]

  if (isAgentSkillsDirectoryEnabled()) {
    roots.push({
      path: getUserAgentSkillsDir(),
      flavor: 'agents',
      scopeKey: 'user',
    })
  }

  return roots
}

/**
 * Project-level skill roots from cwd up to the git root, most specific first.
 *
 * Only existing directories are returned, matching getProjectDirsUpToHome.
 * Each directory level is its own scope, so `pkg/.claude/skills/foo` and
 * `pkg/.agents/skills/foo` collide while `pkg/...` and `repo-root/...` don't.
 */
export function getProjectSkillRoots(cwd: string): SkillRoot[] {
  const agentsEnabled = isAgentSkillsDirectoryEnabled()
  const roots: SkillRoot[] = []

  for (const dir of walkProjectDirsUpToHome(cwd)) {
    const scopeKey = `project:${dir}`

    const claudeRoot = join(dir, '.claude', 'skills')
    if (directoryExists(claudeRoot)) {
      roots.push({ path: claudeRoot, flavor: 'claude', scopeKey })
    }

    if (agentsEnabled) {
      const agentsRoot = join(dir, AGENT_SKILLS_DIR, 'skills')
      if (directoryExists(agentsRoot)) {
        roots.push({ path: agentsRoot, flavor: 'agents', scopeKey })
      }
    }
  }

  return roots
}

/**
 * Skill roots inside an `--add-dir` directory.
 *
 * Not existence-filtered — mirrors the previous behavior of handing
 * `<dir>/.claude/skills` straight to the loader.
 */
export function getAddDirSkillRoots(dir: string): SkillRoot[] {
  const scopeKey = `add-dir:${dir}`
  const roots: SkillRoot[] = [
    { path: join(dir, '.claude', 'skills'), flavor: 'claude', scopeKey },
  ]

  if (isAgentSkillsDirectoryEnabled()) {
    roots.push({
      path: join(dir, AGENT_SKILLS_DIR, 'skills'),
      flavor: 'agents',
      scopeKey,
    })
  }

  return roots
}

/**
 * Whether a skill may take a name another skill already claimed.
 *
 * A name is one slash command, so it resolves to exactly one file however many
 * roots spell it — and both the CLI loader and the desktop slash command list
 * settle that with this rule, so the menu never describes one skill while
 * running another.
 *
 * `.claude` outranks `.agents` in every scope, including across them: this is
 * the Claude Code CLI, so a skill installed for us stays authoritative over one
 * another client dropped into the shared `.agents` space. Any other pairing
 * leaves the incumbent in place, which hands the decision to the caller's root
 * order (managed → user → project, each most-specific-first → --add-dir).
 * `undefined` marks a root with no flavor — plugin and legacy `/commands/`
 * entries — and those neither displace nor get displaced on flavor alone.
 */
export function outranksClaimedSkill(
  claimed: SkillRootFlavor | undefined,
  candidate: SkillRootFlavor | undefined,
): boolean {
  return candidate === 'claude' && claimed === 'agents'
}

/**
 * Both flavors of skills directory nested under a single directory, used by
 * on-demand monorepo discovery. `.claude` first, existence unchecked (the
 * caller stats them and caches hits and misses alike).
 */
export function getNestedSkillDirCandidates(dir: string): string[] {
  const candidates = [join(dir, '.claude', 'skills')]
  if (isAgentSkillsDirectoryEnabled()) {
    candidates.push(join(dir, AGENT_SKILLS_DIR, 'skills'))
  }
  return candidates
}
