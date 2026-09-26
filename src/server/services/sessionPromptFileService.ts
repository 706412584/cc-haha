/**
 * Per-session system-prompt addendum files.
 *
 * The orchestration mode prompts (and the one-shot hand-off summary) are passed
 * to the CLI through `--append-system-prompt-file` rather than
 * `--append-system-prompt`. Two reasons:
 *
 *  1. Windows `CreateProcessW` caps the whole command line at 32767 characters.
 *     The three mode prompts are already 4-13KB, so a user-authored prompt could
 *     silently blow the limit and fail the spawn. A file path is O(1).
 *  2. `--append-system-prompt` is a scalar option, so passing it twice makes the
 *     last one win — the hand-off summary used to silently displace the mode
 *     prompt. Merging both into one file makes the combination explicit.
 *
 * `src/main.tsx` already registers `--append-system-prompt-file` and reads it
 * with readFileSync, and rejects being given both flags at once, so the CLI side
 * needs no changes.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { getCcHahaDir } from '../../utils/envUtils.js'

/**
 * Session ids are generated as UUIDs, but this module receives them from WS/HTTP
 * input, so validate before interpolating one into a path. The allowlist rejects
 * path separators, `..`, and drive letters without needing a traversal check.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/

/** Default age before a leftover file is considered abandoned (24 hours). */
const DEFAULT_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000

function assertSafeSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`Unsafe session id for prompt file: ${JSON.stringify(sessionId)}`)
  }
  return sessionId
}

function getSessionPromptsDir(): string {
  return path.join(getCcHahaDir(), 'session-prompts')
}

function getSessionPromptFilePath(sessionId: string): string {
  return path.join(getSessionPromptsDir(), `${assertSafeSessionId(sessionId)}.txt`)
}

/**
 * Join the mode addendum and the hand-off summary into one file body.
 * Mode prompt first so the mode's framing leads; hand-off context follows.
 * `\n\n` matches the separator `src/main.tsx` uses when it appends the teammate
 * addendum.
 *
 * Whitespace-only parts are dropped, but surviving parts are passed through
 * verbatim — the prompt text is the user's (or the built-in default's) and must
 * not be rewritten on its way to the model.
 */
export function composeAppendSystemPrompt(
  parts: Array<string | undefined | null>,
): string | null {
  const present = parts.filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  )
  return present.length > 0 ? present.join('\n\n') : null
}

/**
 * Write the session's combined addendum and return its absolute path.
 * Returns null when there is nothing to append, so callers can skip the flag
 * entirely rather than pointing the CLI at an empty file.
 */
export async function writeSessionAppendPromptFile(
  sessionId: string,
  content: string,
): Promise<string | null> {
  if (content.trim().length === 0) return null

  const filePath = getSessionPromptFilePath(sessionId)
  const tmpFile = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  try {
    await fs.writeFile(tmpFile, content, 'utf-8')
    await fs.rename(tmpFile, filePath)
  } catch (error) {
    await fs.unlink(tmpFile).catch(() => {})
    throw error
  }

  return filePath
}

/**
 * Remove one session's file. Best-effort: a missing file is the normal case
 * (no mode active), and a failure here must never block session teardown.
 */
export async function removeSessionAppendPromptFile(sessionId: string): Promise<void> {
  let filePath: string
  try {
    filePath = getSessionPromptFilePath(sessionId)
  } catch {
    return
  }
  await fs.unlink(filePath).catch(() => {})
}

/**
 * Delete files left behind by a hard kill (the server never got to run its
 * teardown). Correctness does not depend on this: a leftover file is only ever
 * read by its own session id, and a restart rewrites it. This is housekeeping.
 */
export async function sweepStaleSessionPromptFiles(
  maxAgeMs: number = DEFAULT_SWEEP_MAX_AGE_MS,
): Promise<number> {
  const dir = getSessionPromptsDir()
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }

  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(filePath)
      if (stat.mtimeMs >= cutoff) continue
      await fs.unlink(filePath)
      removed += 1
    } catch {
      // Racing delete or transient fs error — leave it for the next sweep.
    }
  }
  return removed
}

export const _SESSION_PROMPT_INTERNALS = {
  SAFE_SESSION_ID,
  getSessionPromptsDir,
  getSessionPromptFilePath,
} as const
