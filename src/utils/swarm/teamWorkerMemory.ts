import { join, sep } from 'path'
import { getFsImplementation } from '../fsOperations.js'
import {
  buildMemoryLines,
  ENTRYPOINT_NAME,
  ensureMemoryDirExists,
  truncateEntrypointContent,
} from '../../memdir/memdir.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { isEnvDefinedFalsy } from '../envUtils.js'

/**
 * Shared memory for Agent Teams members, local to this machine.
 *
 * Upstream ships a "team memory" system, but it is server-synced (Anthropic
 * OAuth + a github.com remote) and gated behind the TEAMMEM build flag plus a
 * GrowthBook flag this fork never receives — so none of it runs here. What
 * Agent Teams actually needs is narrower: one memory directory per project
 * that every member reads and writes across team sessions, with no server
 * involved. That is what this module builds.
 *
 * The directory is `<auto-memory>/team/` — the same path convention upstream
 * uses — so it inherits the existing write carve-out (isAutoMemPath covers
 * everything under the auto-memory root) and follows the project identity
 * rules (canonical git root, so worktrees share one directory).
 */

/** Set to 0/false to turn shared team memory off. */
const TEAM_MEMORY_ENV = 'CC_HAHA_TEAM_MEMORY'

/**
 * Whether shared team memory is active for this session. Both gates must
 * pass: auto memory on (the parent system), and the fork switch not off.
 */
export function isTeamWorkerMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) return false
  return !isEnvDefinedFalsy(process.env[TEAM_MEMORY_ENV])
}

/**
 * The shared directory, with a trailing separator like getAutoMemPath().
 * Exported for tests and for the write-permission carve-out check.
 */
export function getTeamWorkerMemoryDir(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}

/**
 * Build the system-prompt section that tells a team member about the shared
 * memory: where it is, what belongs there, and how to keep the index. Returns
 * null when the feature is off.
 *
 * Synchronous by design — QueryEngine builds its system prompt inside an
 * async path but before the first model call; the directory is created
 * fire-and-forget here (FileWriteTool also mkdirs a missing parent, so the
 * model's first write cannot lose a race).
 */
export async function buildTeamWorkerMemoryPrompt(): Promise<string | null> {
  if (!isTeamWorkerMemoryEnabled()) return null
  const memoryDir = getTeamWorkerMemoryDir()
  void ensureMemoryDirExists(memoryDir)

  const entrypoint = join(memoryDir, ENTRYPOINT_NAME)
  const fs = getFsImplementation()
  let entrypointContent = ''
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
  } catch {
    // No index yet — the prompt explains how to start one.
  }

  const lines = buildMemoryLines('Shared team memory', memoryDir, [
    '- This memory is shared by every member of this team and by future teams on this project. Write for them, not for yourself: durable project knowledge (conventions, decisions, pitfalls, test commands, gotchas) rather than task status or notes that only make sense right now.',
    '- Before starting a task, check this memory for guidance that already applies — a previous member may have solved exactly this problem.',
    '- Never store secrets, credentials, or anything the user marked private.',
    '- Task status belongs in the shared task list, not here.',
  ])

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)
    lines.push(`## ${ENTRYPOINT_NAME}`, '', t.content)
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      '',
      `This ${ENTRYPOINT_NAME} is currently empty. When you save the first shared memory, create it and add one index line.`,
    )
  }

  return lines.join('\n')
}
