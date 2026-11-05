/**
 * Main system-prompt preference — a user-level override for the session's base
 * system prompt (the "You are Claude Code / an interactive agent that helps
 * users…" text plus the behaviour rules that follow it).
 *
 * This is distinct from `orchestrationPromptPreferencesService`: those three
 * prompts are per-mode ADDENDA appended to the default prompt, while this one
 * REPLACES the default prompt wholesale via `--system-prompt-file`.
 *
 * Replacing — rather than appending — is a deliberate, lossy choice: the
 * built-in prompt is assembled at runtime from a dozen sections, several of
 * which depend on the session (working directory, git state, platform, model,
 * memory, skills, language, output style). Setting an override therefore drops
 * every one of them, including the environment block. That is why the settings
 * UI shows a standing warning rather than a soft one.
 *
 * Storage: ~/.claude/cc-haha/system-prompt.json
 *   { "schemaVersion": 1, "custom"?: string }
 *
 * A present, non-empty string means the user replaced the prompt. A missing key
 * means "use the built-in default".
 *
 * Follows the OrchestrationPromptPreferencesService pattern deliberately: static
 * write lock, tmp-file + rename atomic write, recoverable read (corrupt JSON is
 * quarantined rather than silently reading as "no override").
 */

import * as path from 'node:path'
import { getCcHahaDir } from '../../utils/envUtils.js'
import { ApiError } from '../middleware/errorHandler.js'
import { readRecoverableJsonFile } from './recoverableJsonFile.js'
import { ensurePersistentStorageUpgraded } from './persistentStorageMigrations.js'
import { writeFileAtomic } from '../storage/atomicWrite.js'

const CURRENT_SCHEMA_VERSION = 1

/**
 * Ceiling for the prompt. The file channel has no argv limit, so this is not
 * about the OS — it is a guard against pasting something so large that it
 * swamps the context window on every turn of every session.
 */
export const MAX_SYSTEM_PROMPT_CHARS = 200_000

export type SystemPromptPreferences = {
  schemaVersion: number
  custom?: string
}

export type ResolvedSystemPrompt = {
  /** The user's override, or null when the built-in prompt is in effect. */
  custom: string | null
  isCustom: boolean
}

function normalizePreferences(value: unknown): SystemPromptPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const normalized: SystemPromptPreferences = { schemaVersion: CURRENT_SCHEMA_VERSION }
  const entry = record.custom
  if (entry !== undefined && entry !== null) {
    // A non-string override is a shape error, not something to silently drop:
    // falling back to the built-in would hide a corrupted file.
    if (typeof entry !== 'string') return null
    if (entry.trim().length > 0) normalized.custom = entry
  }
  return normalized
}

export class SystemPromptPreferencesService {
  private static writeLocks = new Map<string, Promise<void>>()

  private getPreferencesPath(): string {
    return path.join(getCcHahaDir(), 'system-prompt.json')
  }

  private async withWriteLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const previousWrite = SystemPromptPreferencesService.writeLocks.get(filePath) ?? Promise.resolve()
    const nextWrite = previousWrite.catch(() => {}).then(task)
    const trackedWrite = nextWrite.then(() => {}, () => {})

    SystemPromptPreferencesService.writeLocks.set(filePath, trackedWrite)

    try {
      return await nextWrite
    } finally {
      if (SystemPromptPreferencesService.writeLocks.get(filePath) === trackedWrite) {
        SystemPromptPreferencesService.writeLocks.delete(filePath)
      }
    }
  }

  private async writePreferences(preferences: SystemPromptPreferences): Promise<void> {
    const filePath = this.getPreferencesPath()
    try {
      await writeFileAtomic(filePath, `${JSON.stringify(preferences, null, 2)}\n`, {
        snapshot: true,
      })
    } catch (error) {
      throw ApiError.internal(`Failed to write system-prompt.json: ${error}`)
    }
  }

  async readPreferences(): Promise<SystemPromptPreferences> {
    await ensurePersistentStorageUpgraded()
    return readRecoverableJsonFile({
      filePath: this.getPreferencesPath(),
      label: 'cc-haha system prompt preferences',
      defaultValue: { schemaVersion: CURRENT_SCHEMA_VERSION },
      normalize: normalizePreferences,
    })
  }

  /** Resolve the override to the text the CLI should receive, or null for the built-in. */
  async getResolvedPrompt(): Promise<ResolvedSystemPrompt> {
    const preferences = await this.readPreferences()
    const custom = preferences.custom ?? null
    return { custom, isCustom: custom !== null }
  }

  async setPrompt(text: string): Promise<void> {
    if (typeof text !== 'string') {
      throw ApiError.badRequest('"text" must be a string')
    }
    if (text.length > MAX_SYSTEM_PROMPT_CHARS) {
      throw ApiError.badRequest(
        `Prompt is too long (${text.length} characters). The limit is ${MAX_SYSTEM_PROMPT_CHARS}.`,
      )
    }
    // Whitespace-only is the same intent as "no override"; treat it as a reset
    // so the UI can never persist a state that reads as custom but renders blank.
    if (text.trim().length === 0) {
      await this.clearPrompt()
      return
    }

    const filePath = this.getPreferencesPath()
    await this.withWriteLock(filePath, async () => {
      await this.writePreferences({ schemaVersion: CURRENT_SCHEMA_VERSION, custom: text })
    })
  }

  async clearPrompt(): Promise<void> {
    const filePath = this.getPreferencesPath()
    await this.withWriteLock(filePath, async () => {
      await this.writePreferences({ schemaVersion: CURRENT_SCHEMA_VERSION })
    })
  }
}

export const systemPromptPreferencesService = new SystemPromptPreferencesService()
