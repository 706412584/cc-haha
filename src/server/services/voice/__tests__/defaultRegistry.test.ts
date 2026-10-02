import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createDefaultProviders, createVoiceService } from '../defaultRegistry.js'
import { DEFAULT_VOICE_PREFERENCES } from '../types.js'

let configDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-voice-default-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

describe('default voice providers', () => {
  test('ships the local SenseVoice provider under the default preference id', () => {
    const ids = createDefaultProviders().map(provider => provider.info.id)
    expect(ids).toEqual([DEFAULT_VOICE_PREFERENCES.providerId])
  })

  test('reports an unprepared local provider without touching the network or the real home', async () => {
    const service = createVoiceService(createDefaultProviders())
    const catalog = await service.catalog()

    expect(catalog.providers).toHaveLength(1)
    const [sensevoice] = catalog.providers
    expect(sensevoice!.info.location).toBe('local')
    expect(sensevoice!.info.languages).toContain('zh')
    expect(sensevoice!.preparation.phase).toBe('unprepared')
    expect(catalog.preferences.providerId).toBe(sensevoice!.info.id)
    // Preferences are read from the redirected config dir, never the real one.
    await expect(fs.readdir(configDir)).resolves.toBeDefined()
  })
})
