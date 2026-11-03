import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_SYSTEM_PROMPT_CHARS,
  SystemPromptPreferencesService,
} from '../services/systemPromptPreferencesService.js'
import {
  removeSessionSystemPromptFile,
  writeSessionSystemPromptFile,
} from '../services/sessionPromptFileService.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-prompt-'))
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
  return path.join(tmpDir, 'cc-haha', 'system-prompt.json')
}

describe('SystemPromptPreferencesService', () => {
  test('reports no override when no file exists', async () => {
    const service = new SystemPromptPreferencesService()
    const resolved = await service.getResolvedPrompt()
    expect(resolved.custom).toBeNull()
    expect(resolved.isCustom).toBe(false)
  })

  test('stores an override and reads it back verbatim', async () => {
    const service = new SystemPromptPreferencesService()
    const text = 'You are a pirate assistant.\n\nArr.\n'
    await service.setPrompt(text)

    const resolved = await service.getResolvedPrompt()
    expect(resolved.isCustom).toBe(true)
    expect(resolved.custom).toBe(text)
  })

  test('clearPrompt drops the override', async () => {
    const service = new SystemPromptPreferencesService()
    await service.setPrompt('CUSTOM')
    await service.clearPrompt()

    const resolved = await service.getResolvedPrompt()
    expect(resolved.custom).toBeNull()
    expect(resolved.isCustom).toBe(false)
  })

  test('rejects a prompt past the character ceiling', async () => {
    const service = new SystemPromptPreferencesService()
    expect(service.setPrompt('x'.repeat(MAX_SYSTEM_PROMPT_CHARS + 1))).rejects.toThrow(/too long/)
    expect((await service.getResolvedPrompt()).isCustom).toBe(false)
  })

  test('treats a whitespace-only prompt as a reset rather than a blank override', async () => {
    const service = new SystemPromptPreferencesService()
    await service.setPrompt('CUSTOM')
    await service.setPrompt('   \n  ')

    const resolved = await service.getResolvedPrompt()
    expect(resolved.isCustom).toBe(false)
    expect(resolved.custom).toBeNull()
  })

  test('rejects a non-string body', async () => {
    const service = new SystemPromptPreferencesService()
    expect(service.setPrompt(42 as unknown as string)).rejects.toThrow()
  })

  test('quarantines a corrupt file and falls back to no override', async () => {
    await fs.mkdir(path.dirname(preferencesPath()), { recursive: true })
    await fs.writeFile(preferencesPath(), '{ this is not json', 'utf-8')

    const service = new SystemPromptPreferencesService()
    const resolved = await service.getResolvedPrompt()
    expect(resolved.isCustom).toBe(false)

    const entries = await fs.readdir(path.dirname(preferencesPath()))
    expect(entries.some(name => name.includes('.invalid-'))).toBe(true)
  })

  test('a non-string custom value is a shape error, not a silent default', async () => {
    await fs.mkdir(path.dirname(preferencesPath()), { recursive: true })
    await fs.writeFile(preferencesPath(), JSON.stringify({ schemaVersion: 1, custom: 123 }), 'utf-8')

    const service = new SystemPromptPreferencesService()
    const resolved = await service.getResolvedPrompt()
    // Normalization rejects the shape, so the file is quarantined and read as
    // "no override" rather than interpreting the number as text.
    expect(resolved.isCustom).toBe(false)
  })

  test('serializes concurrent writes so the last one wins cleanly', async () => {
    const service = new SystemPromptPreferencesService()
    await Promise.all([
      service.setPrompt('FIRST'),
      service.setPrompt('SECOND'),
      service.setPrompt('THIRD'),
    ])
    const resolved = await service.getResolvedPrompt()
    expect(resolved.custom).toBe('THIRD')
  })
})

describe('sessionPromptFileService system-prompt files', () => {
  test('writes, overwrites, and removes the replacement prompt file', async () => {
    const filePath = await writeSessionSystemPromptFile('sys-session', 'BODY ONE')
    expect(filePath).toBeString()
    expect(filePath!.endsWith('.system.txt')).toBe(true)
    expect(await fs.readFile(filePath!, 'utf-8')).toBe('BODY ONE')

    const samePath = await writeSessionSystemPromptFile('sys-session', 'BODY TWO')
    expect(samePath).toBe(filePath)
    expect(await fs.readFile(samePath!, 'utf-8')).toBe('BODY TWO')

    await removeSessionSystemPromptFile('sys-session')
    await expect(fs.readFile(filePath!, 'utf-8')).rejects.toThrow()
  })

  test('skips the write entirely for a blank body', async () => {
    expect(await writeSessionSystemPromptFile('sys-empty', '   ')).toBeNull()
    expect(await writeSessionSystemPromptFile('sys-empty', '')).toBeNull()
  })

  test('keeps the append and replacement files on distinct paths', async () => {
    const systemPath = await writeSessionSystemPromptFile('sys-distinct', 'REPLACE')
    const { writeSessionAppendPromptFile } = await import('../services/sessionPromptFileService.js')
    const appendPath = await writeSessionAppendPromptFile('sys-distinct', 'APPEND')
    expect(systemPath).not.toBe(appendPath)
    // Removing one must not touch the other.
    await removeSessionSystemPromptFile('sys-distinct')
    expect(await fs.readFile(appendPath!, 'utf-8')).toBe('APPEND')
  })

  test('rejects session ids that could escape the prompts directory', async () => {
    for (const unsafe of ['../evil', 'a/b', 'a\\b', '..', '', 'a\u0000b']) {
      expect(writeSessionSystemPromptFile(unsafe, 'x')).rejects.toThrow(/Unsafe session id/)
    }
  })
})
