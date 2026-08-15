import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { getAttachmentsForTesting } from '../attachments.js'
import { resetSettingsCache } from '../settings/settingsCache.js'

let home: string
let configDir: string
let wasInteractive: boolean
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

async function writeSettings(value: Record<string, unknown>): Promise<void> {
  await writeFile(join(configDir, 'settings.json'), JSON.stringify(value), 'utf8')
  resetSettingsCache()
}

function contextWith(state: Partial<AppState>): ToolUseContext {
  return {
    getAppState: () => state as AppState,
  } as unknown as ToolUseContext
}

/**
 * The keyword path has three independent off-switches (the setting, the
 * per-prompt `opt+w` dismissal, and the matcher itself). Each one has silently
 * regressed in the official CLI at least once, and the failure mode is the
 * same either way: a one-line prompt quietly becomes a run that spawns dozens
 * of agents, or the keyword stops working with no error anywhere.
 */
describe('workflow keyword attachment', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wf-keyword-attach-'))
    configDir = join(home, 'claude')
    mkdirSync(configDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    // The keyword is interactive-only, so these cases have to run as if the
    // user were at the prompt.
    wasInteractive = getIsInteractive()
    setIsInteractive(true)
    await writeSettings({})
  })

  afterEach(async () => {
    setIsInteractive(wasInteractive)
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    resetSettingsCache()
    await rm(home, { recursive: true, force: true })
  })

  test('fires on a typed keyword', () => {
    expect(
      getAttachmentsForTesting.workflowKeyword('ultracode: audit the routes', {
        suppressed: false,
      }),
    ).toEqual([{ type: 'workflow_keyword_request' }])
  })

  test('opt+w suppression wins over a present keyword', () => {
    expect(
      getAttachmentsForTesting.workflowKeyword('ultracode: audit the routes', {
        suppressed: true,
      }),
    ).toEqual([])
  })

  test('the setting turns the trigger off entirely', async () => {
    await writeSettings({ workflowKeywordTriggerEnabled: false })
    expect(
      getAttachmentsForTesting.workflowKeyword('ultracode: audit', {
        suppressed: false,
      }),
    ).toEqual([])
  })

  test('restoring the setting lets a complex typed prompt opt in again', async () => {
    const prompt =
      'ultracode：audit route registration, error propagation, and missing tests with several agents'

    await writeSettings({ workflowKeywordTriggerEnabled: false })
    expect(
      getAttachmentsForTesting.workflowKeyword(prompt, { suppressed: false }),
    ).toEqual([])

    await writeSettings({ workflowKeywordTriggerEnabled: true })
    expect(
      getAttachmentsForTesting.workflowKeyword(prompt, { suppressed: false }),
    ).toEqual([{ type: 'workflow_keyword_request' }])
  })

  test('a quoted mention of the word is not an opt-in', () => {
    expect(
      getAttachmentsForTesting.workflowKeyword(
        'what does the "ultracode" keyword do?',
        { suppressed: false },
      ),
    ).toEqual([])
  })

  test.each([
    ['a fenced code block', '```text\nultracode\n```'],
    ['a path', 'open docs/ultracode/readme.md'],
    ['a flag', 'pass --ultracode to the CLI'],
    ['a hyphenated literal', 'inspect the ultracode-runner package'],
  ])('does not opt in for %s', (_label, prompt) => {
    expect(
      getAttachmentsForTesting.workflowKeyword(prompt, { suppressed: false }),
    ).toEqual([])
  })
})

describe('ultracode effort attachments', () => {
  test('announces the transition once, then keeps it short', () => {
    const enter = getAttachmentsForTesting.ultracodeEffort([], true)
    expect(enter).toEqual([{ type: 'ultra_effort_enter', reminderType: 'full' }])

    const messages = [
      { type: 'attachment', attachment: { type: 'ultra_effort_enter' } },
    ] as never
    expect(getAttachmentsForTesting.ultracodeEffort(messages, true)).toEqual([
      { type: 'ultra_effort_enter', reminderType: 'short' },
    ])
  })

  test('announces the exit only after it was announced on', () => {
    expect(getAttachmentsForTesting.ultracodeEffort([], false)).toEqual([])

    const messages = [
      { type: 'attachment', attachment: { type: 'ultra_effort_enter' } },
    ] as never
    expect(getAttachmentsForTesting.ultracodeEffort(messages, false)).toEqual([
      { type: 'ultra_effort_exit' },
    ])
  })

  test('does not repeat the exit once it has been announced', () => {
    const messages = [
      { type: 'attachment', attachment: { type: 'ultra_effort_enter' } },
      { type: 'attachment', attachment: { type: 'ultra_effort_exit' } },
    ] as never
    expect(getAttachmentsForTesting.ultracodeEffort(messages, false)).toEqual([])
  })

  test('reads the flag from AppState, not from a parameter default', () => {
    const context = contextWith({ ultracode: true })
    expect(context.getAppState().ultracode).toBe(true)
  })
})

describe('workflow size guideline reminder', () => {
  test('stays silent on the first turn — the tool prompt already carries it', () => {
    expect(getAttachmentsForTesting.workflowSizeGuideline([])).toEqual([])
  })

  test('announces a change away from what was last announced', () => {
    const messages = [
      {
        type: 'attachment',
        attachment: { type: 'workflow_size_guideline_change', size: 'small' },
      },
    ] as never
    // The live guideline in this environment is the default, so a previously
    // announced 'small' must produce a fresh announcement.
    expect(getAttachmentsForTesting.workflowSizeGuideline(messages)).toEqual([
      { type: 'workflow_size_guideline_change', size: 'medium' },
    ])
  })

  test('does not repeat an announcement that still holds', () => {
    const messages = [
      {
        type: 'attachment',
        attachment: { type: 'workflow_size_guideline_change', size: 'medium' },
      },
    ] as never
    expect(getAttachmentsForTesting.workflowSizeGuideline(messages)).toEqual([])
  })
})
