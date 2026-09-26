/**
 * Orchestration prompt preferences — user-level overrides for the three
 * per-session orchestration mode prompts (coordinator / Solo / RE).
 *
 * The mode toggles themselves stay per-session (see ws/handler.ts); only the
 * prompt TEXT is a user-level preference, because "what this mode looks like"
 * is a global choice, not a per-conversation one. A mode switch restarts the
 * CLI, so reading the preference globally keeps the text stable across that
 * restart.
 *
 * Storage: ~/.claude/cc-haha/orchestration-prompts.json
 *   { "schemaVersion": 1, "coordinator"?: string, "solo"?: string, "re"?: string }
 *
 * A present, non-empty string means the user replaced that mode's prompt
 * wholesale. A missing key means "use the built-in default".
 *
 * Follows the DesktopUiPreferencesService pattern deliberately: static write
 * lock, tmp-file + rename atomic write, recoverable read (corrupt JSON is
 * quarantined rather than losing every other mode's override).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { getCcHahaDir } from '../../utils/envUtils.js'
import { ApiError } from '../middleware/errorHandler.js'
import { readRecoverableJsonFile } from './recoverableJsonFile.js'
import { ensurePersistentStorageUpgraded } from './persistentStorageMigrations.js'

const CURRENT_SCHEMA_VERSION = 1

/**
 * Ceiling for one mode's prompt. The file channel has no argv limit, so this
 * is not about the OS — it is a guard against pasting something so large that
 * it swamps the context window on every turn of every session in that mode.
 */
export const MAX_PROMPT_CHARS = 200_000

export const ORCHESTRATION_PROMPT_MODES = ['coordinator', 'solo', 're'] as const

export type OrchestrationPromptMode = (typeof ORCHESTRATION_PROMPT_MODES)[number]

export type OrchestrationPromptPreferences = {
  schemaVersion: number
  coordinator?: string
  solo?: string
  re?: string
}

export type ResolvedOrchestrationPrompt = {
  /** The built-in text, always present so the UI can offer it as a starting point. */
  default: string
  /** The user's override, or null when the default is in effect. */
  custom: string | null
  /** What the CLI will actually receive. */
  effective: string
  isCustom: boolean
}

export type AllOrchestrationPrompts = Record<OrchestrationPromptMode, ResolvedOrchestrationPrompt>

function isMode(value: string): value is OrchestrationPromptMode {
  return (ORCHESTRATION_PROMPT_MODES as readonly string[]).includes(value)
}

export function assertOrchestrationPromptMode(value: string): OrchestrationPromptMode {
  if (!isMode(value)) {
    throw ApiError.badRequest(
      `Unknown orchestration prompt mode: "${value}". Expected one of ${ORCHESTRATION_PROMPT_MODES.join(', ')}.`,
    )
  }
  return value
}

/**
 * Built-in defaults. Loaded lazily for the two pipeline prompts because their
 * modules are gated behind the COORDINATOR_MODE bundle flag and would
 * otherwise be pulled into builds that do not enable it — the same reason
 * conversationService.ts uses a lazy require for them.
 */
function getDefaultPrompt(mode: OrchestrationPromptMode): string {
  if (mode === 'coordinator') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ORCHESTRATION_SYSTEM_PROMPT } =
      require('../orchestrationPrompt.js') as typeof import('../orchestrationPrompt.js')
    return ORCHESTRATION_SYSTEM_PROMPT
  }
  if (mode === 'solo') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSoloPipelineSystemPrompt } =
      require('../../coordinator/soloPipelinePrompt.js') as typeof import('../../coordinator/soloPipelinePrompt.js')
    return getSoloPipelineSystemPrompt()
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getReverseEngineeringPipelineSystemPrompt } =
    require('../../coordinator/reverseEngineeringPipelinePrompt.js') as typeof import('../../coordinator/reverseEngineeringPipelinePrompt.js')
  return getReverseEngineeringPipelineSystemPrompt()
}

function normalizePreferences(value: unknown): OrchestrationPromptPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const normalized: OrchestrationPromptPreferences = { schemaVersion: CURRENT_SCHEMA_VERSION }
  for (const mode of ORCHESTRATION_PROMPT_MODES) {
    const entry = record[mode]
    if (entry === undefined || entry === null) continue
    // A non-string override is a shape error, not something to silently drop:
    // falling back to the default would hide a corrupted file.
    if (typeof entry !== 'string') return null
    if (entry.trim().length === 0) continue
    normalized[mode] = entry
  }
  return normalized
}

export class OrchestrationPromptPreferencesService {
  private static writeLocks = new Map<string, Promise<void>>()

  private getPreferencesPath(): string {
    return path.join(getCcHahaDir(), 'orchestration-prompts.json')
  }

  private async withWriteLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const previousWrite = OrchestrationPromptPreferencesService.writeLocks.get(filePath) ?? Promise.resolve()
    const nextWrite = previousWrite.catch(() => {}).then(task)
    const trackedWrite = nextWrite.then(() => {}, () => {})

    OrchestrationPromptPreferencesService.writeLocks.set(filePath, trackedWrite)

    try {
      return await nextWrite
    } finally {
      if (OrchestrationPromptPreferencesService.writeLocks.get(filePath) === trackedWrite) {
        OrchestrationPromptPreferencesService.writeLocks.delete(filePath)
      }
    }
  }

  private async writePreferences(preferences: OrchestrationPromptPreferences): Promise<void> {
    const filePath = this.getPreferencesPath()
    const contents = JSON.stringify(preferences, null, 2) + '\n'
    const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}`

    await fs.mkdir(path.dirname(filePath), { recursive: true })

    try {
      await fs.writeFile(tmpFile, contents, 'utf-8')
      await fs.rename(tmpFile, filePath)
    } catch (error) {
      await fs.unlink(tmpFile).catch(() => {})
      throw ApiError.internal(`Failed to write orchestration-prompts.json: ${error}`)
    }
  }

  async readPreferences(): Promise<OrchestrationPromptPreferences> {
    await ensurePersistentStorageUpgraded()
    return readRecoverableJsonFile({
      filePath: this.getPreferencesPath(),
      label: 'cc-haha orchestration prompt preferences',
      defaultValue: { schemaVersion: CURRENT_SCHEMA_VERSION },
      normalize: normalizePreferences,
    })
  }

  /** Resolve one mode to the text the CLI should receive. */
  async getResolvedPrompt(mode: OrchestrationPromptMode): Promise<ResolvedOrchestrationPrompt> {
    const preferences = await this.readPreferences()
    const custom = preferences[mode] ?? null
    const defaultText = getDefaultPrompt(mode)
    return {
      default: defaultText,
      custom,
      effective: custom ?? defaultText,
      isCustom: custom !== null,
    }
  }

  /** Resolve all three modes for the settings API. */
  async getAllPrompts(): Promise<AllOrchestrationPrompts> {
    const preferences = await this.readPreferences()
    const result = {} as AllOrchestrationPrompts
    for (const mode of ORCHESTRATION_PROMPT_MODES) {
      const custom = preferences[mode] ?? null
      const defaultText = getDefaultPrompt(mode)
      result[mode] = {
        default: defaultText,
        custom,
        effective: custom ?? defaultText,
        isCustom: custom !== null,
      }
    }
    return result
  }

  async setPrompt(mode: OrchestrationPromptMode, text: string): Promise<void> {
    if (typeof text !== 'string') {
      throw ApiError.badRequest('"text" must be a string')
    }
    if (text.length > MAX_PROMPT_CHARS) {
      throw ApiError.badRequest(
        `Prompt is too long (${text.length} characters). The limit is ${MAX_PROMPT_CHARS}.`,
      )
    }
    // Whitespace-only is the same intent as "no override"; treat it as a reset
    // so the UI can never persist a state that reads as custom but renders blank.
    if (text.trim().length === 0) {
      await this.clearPrompt(mode)
      return
    }

    const filePath = this.getPreferencesPath()
    await this.withWriteLock(filePath, async () => {
      const preferences = await this.readPreferences()
      await this.writePreferences({ ...preferences, schemaVersion: CURRENT_SCHEMA_VERSION, [mode]: text })
    })
  }

  async clearPrompt(mode: OrchestrationPromptMode): Promise<void> {
    const filePath = this.getPreferencesPath()
    await this.withWriteLock(filePath, async () => {
      const preferences = await this.readPreferences()
      const next: OrchestrationPromptPreferences = { schemaVersion: CURRENT_SCHEMA_VERSION }
      for (const candidate of ORCHESTRATION_PROMPT_MODES) {
        if (candidate === mode) continue
        const value = preferences[candidate]
        if (value !== undefined) next[candidate] = value
      }
      await this.writePreferences(next)
    })
  }
}

export const orchestrationPromptPreferencesService = new OrchestrationPromptPreferencesService()
