import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { buildTeamWorkerMemoryPrompt, getTeamWorkerMemoryDir, isTeamWorkerMemoryEnabled } from './teamWorkerMemory.js'
import { getAutoMemPath } from '../../memdir/paths.js'

const saved = {
  home: process.env.HOME,
  config: process.env.CLAUDE_CONFIG_DIR,
  team: process.env.CC_HAHA_TEAM_MEMORY,
  autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
}
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'team-worker-memory-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
  delete process.env.CC_HAHA_TEAM_MEMORY
  delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
})

afterEach(() => {
  if (saved.home === undefined) delete process.env.HOME
  else process.env.HOME = saved.home
  if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved.config
  if (saved.team === undefined) delete process.env.CC_HAHA_TEAM_MEMORY
  else process.env.CC_HAHA_TEAM_MEMORY = saved.team
  if (saved.autoMemory === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = saved.autoMemory
  rmSync(root, { recursive: true, force: true })
})

test('the shared directory lives under the auto-memory root, so the existing write carve-out covers it', () => {
  const teamDir = getTeamWorkerMemoryDir()
  expect(teamDir.startsWith(getAutoMemPath())).toBe(true)
  expect(teamDir.endsWith(`team${sep}`)).toBe(true)
})

test('the prompt names the shared directory and its guidance, and creates the directory', async () => {
  const prompt = await buildTeamWorkerMemoryPrompt()
  expect(prompt).not.toBeNull()
  const teamDir = getTeamWorkerMemoryDir()
  expect(prompt).toContain(teamDir)
  expect(prompt).toContain('Shared team memory')
  expect(prompt).toContain('shared by every member of this team')
  expect(prompt).toContain('Task status belongs in the shared task list')
  // mkdir is awaited inside the builder, so the directory exists on return.
  expect(existsSync(teamDir)).toBe(true)
})

test('an existing MEMORY.md index is loaded into the prompt', async () => {
  const teamDir = getTeamWorkerMemoryDir()
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(join(teamDir, 'MEMORY.md'), '- [Build quirks](build.md) — always run x before y')
  const prompt = await buildTeamWorkerMemoryPrompt()
  expect(prompt).toContain('Build quirks')
})

test('CC_HAHA_TEAM_MEMORY=0 turns the feature off; auto-memory off also disables it', async () => {
  process.env.CC_HAHA_TEAM_MEMORY = '0'
  expect(isTeamWorkerMemoryEnabled()).toBe(false)
  expect(await buildTeamWorkerMemoryPrompt()).toBeNull()

  delete process.env.CC_HAHA_TEAM_MEMORY
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  expect(isTeamWorkerMemoryEnabled()).toBe(false)
  expect(await buildTeamWorkerMemoryPrompt()).toBeNull()
  delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  expect(isTeamWorkerMemoryEnabled()).toBe(true)
})
