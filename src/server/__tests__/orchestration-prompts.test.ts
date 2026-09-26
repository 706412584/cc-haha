import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_PROMPT_CHARS,
  OrchestrationPromptPreferencesService,
  assertOrchestrationPromptMode,
} from '../services/orchestrationPromptPreferencesService.js'
import {
  _SESSION_PROMPT_INTERNALS,
  composeAppendSystemPrompt,
  removeSessionAppendPromptFile,
  sweepStaleSessionPromptFiles,
  writeSessionAppendPromptFile,
} from '../services/sessionPromptFileService.js'
import { ORCHESTRATION_SYSTEM_PROMPT } from '../orchestrationPrompt.js'
import { getSoloPipelineSystemPrompt } from '../../coordinator/soloPipelinePrompt.js'
import { getReverseEngineeringPipelineSystemPrompt } from '../../coordinator/reverseEngineeringPipelinePrompt.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestration-prompts-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function preferencesPath(): string {
  return path.join(tmpDir, 'cc-haha', 'orchestration-prompts.json')
}

describe('OrchestrationPromptPreferencesService', () => {
  test('falls back to the built-in prompt for every mode when no file exists', async () => {
    const service = new OrchestrationPromptPreferencesService()

    const all = await service.getAllPrompts()

    expect(all.coordinator.effective).toBe(ORCHESTRATION_SYSTEM_PROMPT)
    expect(all.coordinator.isCustom).toBe(false)
    expect(all.coordinator.custom).toBeNull()
    expect(all.solo.effective).toBe(getSoloPipelineSystemPrompt())
    expect(all.solo.isCustom).toBe(false)
    expect(all.re.effective).toBe(getReverseEngineeringPipelineSystemPrompt())
    expect(all.re.isCustom).toBe(false)
  })

  test('replaces only the mode that was set, leaving the others on their defaults', async () => {
    const service = new OrchestrationPromptPreferencesService()

    await service.setPrompt('solo', 'CUSTOM SOLO')

    const all = await service.getAllPrompts()
    expect(all.solo.isCustom).toBe(true)
    expect(all.solo.effective).toBe('CUSTOM SOLO')
    // The built-in is still reported so the UI can offer it as a starting point.
    expect(all.solo.default).toBe(getSoloPipelineSystemPrompt())
    expect(all.coordinator.isCustom).toBe(false)
    expect(all.re.isCustom).toBe(false)
  })

  test('clearPrompt restores the built-in and leaves other overrides intact', async () => {
    const service = new OrchestrationPromptPreferencesService()

    await service.setPrompt('coordinator', 'CUSTOM COORDINATOR')
    await service.setPrompt('re', 'CUSTOM RE')
    await service.clearPrompt('coordinator')

    const all = await service.getAllPrompts()
    expect(all.coordinator.isCustom).toBe(false)
    expect(all.coordinator.effective).toBe(ORCHESTRATION_SYSTEM_PROMPT)
    expect(all.re.isCustom).toBe(true)
    expect(all.re.effective).toBe('CUSTOM RE')
  })

  test('rejects a prompt past the character ceiling', async () => {
    const service = new OrchestrationPromptPreferencesService()

    expect(service.setPrompt('solo', 'x'.repeat(MAX_PROMPT_CHARS + 1))).rejects.toThrow(/too long/)
    expect((await service.getAllPrompts()).solo.isCustom).toBe(false)
  })

  test('treats a whitespace-only prompt as a reset rather than a blank override', async () => {
    const service = new OrchestrationPromptPreferencesService()

    await service.setPrompt('solo', 'CUSTOM SOLO')
    await service.setPrompt('solo', '   \n  ')

    const all = await service.getAllPrompts()
    expect(all.solo.isCustom).toBe(false)
    expect(all.solo.effective).toBe(getSoloPipelineSystemPrompt())
  })

  test('quarantines a corrupt file and falls back to defaults', async () => {
    await fs.mkdir(path.dirname(preferencesPath()), { recursive: true })
    await fs.writeFile(preferencesPath(), '{ this is not json', 'utf-8')

    const service = new OrchestrationPromptPreferencesService()
    const all = await service.getAllPrompts()

    expect(all.solo.isCustom).toBe(false)
    const entries = await fs.readdir(path.dirname(preferencesPath()))
    expect(entries.some(name => name.includes('.invalid-'))).toBe(true)
  })

  test('serializes concurrent writes so no update is lost', async () => {
    const service = new OrchestrationPromptPreferencesService()

    await Promise.all([
      service.setPrompt('coordinator', 'C1'),
      service.setPrompt('solo', 'S1'),
      service.setPrompt('re', 'R1'),
    ])

    const all = await service.getAllPrompts()
    expect(all.coordinator.effective).toBe('C1')
    expect(all.solo.effective).toBe('S1')
    expect(all.re.effective).toBe('R1')
  })

  test('rejects an unknown mode', () => {
    expect(() => assertOrchestrationPromptMode('nope')).toThrow(/Unknown orchestration prompt mode/)
    expect(assertOrchestrationPromptMode('re')).toBe('re')
  })
})

describe('sessionPromptFileService', () => {
  test('joins parts in order and drops empty ones', () => {
    expect(composeAppendSystemPrompt(['MODE', 'HANDOFF'])).toBe('MODE\n\nHANDOFF')
    expect(composeAppendSystemPrompt(['MODE', undefined, 'HANDOFF'])).toBe('MODE\n\nHANDOFF')
    expect(composeAppendSystemPrompt(['  ', null])).toBeNull()
    expect(composeAppendSystemPrompt([])).toBeNull()
  })

  test('passes prompt text through verbatim, including trailing newlines', () => {
    // The default prompts end with a newline; rewriting them on the way to the
    // model would be a silent behaviour change.
    const withTrailing = 'line one\nline two\n'
    expect(composeAppendSystemPrompt([withTrailing])).toBe(withTrailing)
  })

  test('writes, overwrites, and removes a session file', async () => {
    const filePath = await writeSessionAppendPromptFile('session-abc', 'FIRST')
    expect(filePath).toBeString()
    expect(await fs.readFile(filePath!, 'utf-8')).toBe('FIRST')

    const samePath = await writeSessionAppendPromptFile('session-abc', 'SECOND')
    expect(samePath).toBe(filePath)
    expect(await fs.readFile(samePath!, 'utf-8')).toBe('SECOND')

    await removeSessionAppendPromptFile('session-abc')
    await expect(fs.readFile(filePath!, 'utf-8')).rejects.toThrow()
  })

  test('skips the write entirely when there is nothing to append', async () => {
    expect(await writeSessionAppendPromptFile('session-empty', '   ')).toBeNull()
    expect(await writeSessionAppendPromptFile('session-empty', '')).toBeNull()
  })

  test('rejects session ids that could escape the prompts directory', async () => {
    for (const unsafe of ['../evil', 'a/b', 'a\\b', '..', '', 'a\u0000b']) {
      expect(writeSessionAppendPromptFile(unsafe, 'x')).rejects.toThrow(/Unsafe session id/)
    }
  })

  test('sweeps files older than the age limit and keeps fresh ones', async () => {
    const dir = _SESSION_PROMPT_INTERNALS.getSessionPromptsDir()
    const stalePath = await writeSessionAppendPromptFile('stale-session', 'OLD')
    const freshPath = await writeSessionAppendPromptFile('fresh-session', 'NEW')
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await fs.utimes(stalePath!, old, old)

    const removed = await sweepStaleSessionPromptFiles(24 * 60 * 60 * 1000)

    expect(removed).toBe(1)
    expect(await fs.readdir(dir)).toEqual([path.basename(freshPath!)])
  })
})
