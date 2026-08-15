import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeEffort } from '../../commands/effort/effort.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { modelSupportsXHighEffort } from '../effort.js'
import { canEnableUltracode } from './ultracode.js'

/**
 * A model the capability table accepts in this environment.
 *
 * `modelSupportsXHighEffort` is gated on provider trust, so hardcoding a name
 * makes the test depend on the developer's provider config rather than on
 * ultracode's own logic.
 */
const XHIGH_MODEL = ['claude-opus-4-7', 'claude-sonnet-5', 'claude-fable-5'].find(
  modelSupportsXHighEffort,
)

let home: string
let configDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalEffortEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL

async function writeSettings(value: Record<string, unknown>): Promise<void> {
  await writeFile(join(configDir, 'settings.json'), JSON.stringify(value), 'utf8')
  resetSettingsCache()
}

describe('ultracode', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wf-ultracode-'))
    configDir = join(home, 'claude')
    mkdirSync(configDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    await writeSettings({})
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalEffortEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = originalEffortEnv
    resetSettingsCache()
    await rm(home, { recursive: true, force: true })
  })

  test('requires an xhigh-capable model', () => {
    const refused = canEnableUltracode('deepseek-v4-flash')
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.reason).toBe('model')
  })

  test('requires workflows to be enabled', async () => {
    await writeSettings({ disableWorkflows: true })
    const refused = canEnableUltracode(XHIGH_MODEL ?? 'claude-opus-4-7')
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    // The workflow gate is checked before the model gate, so this reason holds
    // whether or not the capability table trusts the model here.
    expect(refused.reason).toBe('workflows-disabled')
  })

  test('/effort ultracode resolves to xhigh plus the session flag', () => {
    if (!XHIGH_MODEL) {
      // No xhigh-capable model is trusted in this environment; the refusal
      // path is covered above and asserting here would test the provider
      // config, not ultracode.
      expect(canEnableUltracode('claude-opus-4-7').ok).toBe(false)
      return
    }
    const result = executeEffort('ultracode', XHIGH_MODEL)
    expect(result.effortUpdate).toEqual({ value: 'xhigh', ultracode: true })
    expect(result.message).toContain('this session only')
  })

  test('/effort ultracode explains itself when the model cannot do xhigh', () => {
    const result = executeEffort('ultracode', 'deepseek-v4-flash')
    expect(result.effortUpdate).toBeUndefined()
    expect(result.message).toContain("doesn't support")
  })

  test('/effort ultracode is refused when workflows are off', async () => {
    await writeSettings({ enableWorkflows: false })
    const result = executeEffort('ultracode', XHIGH_MODEL ?? 'claude-opus-4-7')
    expect(result.effortUpdate).toBeUndefined()
    expect(result.message).toContain('dynamic workflows enabled')
  })

  test('an ordinary level never sets the flag', () => {
    const result = executeEffort('high', XHIGH_MODEL ?? 'claude-opus-4-7')
    expect(result.effortUpdate?.ultracode).toBeUndefined()
  })
})
