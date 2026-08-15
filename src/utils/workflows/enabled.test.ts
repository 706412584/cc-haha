import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import {
  areWorkflowsEnabled,
  describeWorkflowSizeGuideline,
  getLargeWorkflowWarning,
  getWorkflowsDisabledReason,
  getWorkflowSizeGuideline,
  isWorkflowKeywordTriggerEnabled,
} from './enabled.js'

let home: string
let configDir: string
const original = {
  configDir: process.env.CLAUDE_CONFIG_DIR,
  disable: process.env.CLAUDE_CODE_DISABLE_WORKFLOWS,
  warnAgents: process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS,
  warnTokens: process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS,
}

async function writeSettings(value: Record<string, unknown>): Promise<void> {
  await writeFile(join(configDir, 'settings.json'), JSON.stringify(value), 'utf8')
  resetSettingsCache()
}

describe('workflow gates', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wf-enabled-'))
    configDir = join(home, 'claude')
    mkdirSync(configDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_DISABLE_WORKFLOWS
    delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS
    delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS
    resetSettingsCache()
  })

  afterEach(async () => {
    for (const [key, value] of [
      ['CLAUDE_CONFIG_DIR', original.configDir],
      ['CLAUDE_CODE_DISABLE_WORKFLOWS', original.disable],
      ['CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS', original.warnAgents],
      ['CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS', original.warnTokens],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetSettingsCache()
    await rm(home, { recursive: true, force: true })
  })

  test('enabled by default', async () => {
    await writeSettings({})
    expect(areWorkflowsEnabled()).toBe(true)
    expect(getWorkflowsDisabledReason()).toBeNull()
  })

  test('disableWorkflows and enableWorkflows:false both turn it off', async () => {
    await writeSettings({ disableWorkflows: true })
    expect(getWorkflowsDisabledReason()).toBe('settings')
    await writeSettings({ enableWorkflows: false })
    expect(getWorkflowsDisabledReason()).toBe('settings')
    await writeSettings({ enableWorkflows: true })
    expect(getWorkflowsDisabledReason()).toBeNull()
  })

  test('the env var wins over settings and is reported separately', async () => {
    await writeSettings({ enableWorkflows: true })
    process.env.CLAUDE_CODE_DISABLE_WORKFLOWS = '1'
    expect(getWorkflowsDisabledReason()).toBe('env')
  })

  test('the keyword trigger is on by default and off when set false', async () => {
    const wasInteractive = getIsInteractive()
    setIsInteractive(true)
    try {
      await writeSettings({})
      expect(isWorkflowKeywordTriggerEnabled()).toBe(true)
      await writeSettings({ workflowKeywordTriggerEnabled: false })
      expect(isWorkflowKeywordTriggerEnabled()).toBe(false)
    } finally {
      setIsInteractive(wasInteractive)
    }
  })

  test('a non-interactive session never honours the keyword', async () => {
    await writeSettings({ workflowKeywordTriggerEnabled: true })
    const wasInteractive = getIsInteractive()
    setIsInteractive(false)
    try {
      expect(isWorkflowKeywordTriggerEnabled()).toBe(false)
    } finally {
      setIsInteractive(wasInteractive)
    }
  })

  test('an interactive session honours it', async () => {
    await writeSettings({ workflowKeywordTriggerEnabled: true })
    const wasInteractive = getIsInteractive()
    setIsInteractive(true)
    try {
      expect(isWorkflowKeywordTriggerEnabled()).toBe(true)
    } finally {
      setIsInteractive(wasInteractive)
    }
  })

  test('disabling workflows also disables the keyword', async () => {
    const wasInteractive = getIsInteractive()
    setIsInteractive(true)
    try {
      await writeSettings({
        disableWorkflows: true,
        workflowKeywordTriggerEnabled: true,
      })
      expect(isWorkflowKeywordTriggerEnabled()).toBe(false)
    } finally {
      setIsInteractive(wasInteractive)
    }
  })

  test('a settings-file guideline wins and shows in the prompt', async () => {
    await writeSettings({ workflowSizeGuideline: 'small' })
    expect(getWorkflowSizeGuideline()).toBe('small')
    expect(describeWorkflowSizeGuideline()).toContain('under 5 agents')
  })

  test('the default guideline is medium', async () => {
    await writeSettings({})
    expect(getWorkflowSizeGuideline()).toBe('medium')
  })
})

describe('getLargeWorkflowWarning', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wf-warn-'))
    configDir = join(home, 'claude')
    mkdirSync(configDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS
    delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS
    await writeSettings({})
  })

  afterEach(async () => {
    if (original.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = original.configDir
    delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS
    resetSettingsCache()
    await rm(home, { recursive: true, force: true })
  })

  const base = { startedAgents: 4, totalTokens: 40_000, ultracodeActive: false }

  test('stays quiet for an ordinary run', () => {
    expect(
      getLargeWorkflowWarning({ ...base, scheduledAgents: 6 }),
    ).toBeUndefined()
  })

  test('fires past the default 25-agent threshold', () => {
    const warning = getLargeWorkflowWarning({ ...base, scheduledAgents: 26 })
    expect(warning?.axis).toBe('agents')
    expect(warning?.agentCap).toBe(25)
  })

  test('projects tokens from the agents that have run so far', () => {
    // 4 agents at 500k each → 40 scheduled projects to 20M, far over the cap.
    const warning = getLargeWorkflowWarning({
      scheduledAgents: 40,
      startedAgents: 4,
      totalTokens: 2_000_000,
      ultracodeActive: false,
    })
    expect(warning?.axis).toBe('both')
    expect(warning?.projectedTokens).toBe(20_000_000)
  })

  test('an explicit size guideline replaces the agent threshold', async () => {
    await writeSettings({ workflowSizeGuideline: 'small' })
    const warning = getLargeWorkflowWarning({ ...base, scheduledAgents: 6 })
    expect(warning?.agentCap).toBe(5)
    expect(warning?.capFromGuideline).toBe(true)
  })

  test('the env override beats the guideline', async () => {
    await writeSettings({ workflowSizeGuideline: 'small' })
    process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS = '100'
    expect(
      getLargeWorkflowWarning({ ...base, scheduledAgents: 40 }),
    ).toBeUndefined()
  })

  test('ultracode suppresses it — that mode already opted in to scale', () => {
    expect(
      getLargeWorkflowWarning({
        scheduledAgents: 500,
        startedAgents: 10,
        totalTokens: 9_000_000,
        ultracodeActive: true,
      }),
    ).toBeUndefined()
  })
})
