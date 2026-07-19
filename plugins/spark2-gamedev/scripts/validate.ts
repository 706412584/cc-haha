#!/usr/bin/env bun
/**
 * Validates spark2-gamedev plugin structure and JSON files.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const PLUGIN_ROOT = join(import.meta.dir, '..')

function readJson(path: string) {
  const content = readFileSync(path, 'utf-8')
  return JSON.parse(content)
}

function readFrontmatter(path: string): Record<string, unknown> | undefined {
  const content = readFileSync(path, 'utf-8')
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  if (!match?.[1]) return undefined

  try {
    const value = parse(match[1])
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`)
    process.exitCode = 1
  }
}

console.log('Validating spark2-gamedev plugin...\n')

// 1. plugin.json
console.log('[plugin.json]')
const pluginJsonPath = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
check('exists', existsSync(pluginJsonPath))
const pluginJson = readJson(pluginJsonPath)
check('has name', pluginJson.name === 'spark2-gamedev')
check('has version', typeof pluginJson.version === 'string')
check('has mcpServers', typeof pluginJson.mcpServers === 'string')
check('has userConfig', typeof pluginJson.userConfig === 'object')
check('userConfig.SCE_PROJECT_DIR', !!pluginJson.userConfig?.SCE_PROJECT_DIR)
check('userConfig.SCE_MCP_PORT', !!pluginJson.userConfig?.SCE_MCP_PORT)

// 2. servers.json
console.log('\n[mcp/servers.json]')
const serversJsonPath = join(PLUGIN_ROOT, 'mcp', 'servers.json')
check('exists', existsSync(serversJsonPath))
const serversJson = readJson(serversJsonPath)
check('has sce-editor-mcp entry', !!serversJson['sce-editor-mcp'])
check('command is node', serversJson['sce-editor-mcp']?.command === 'node')

// 3. bridge script
console.log('\n[mcp/sce-editor-bridge.mjs]')
const bridgePath = join(PLUGIN_ROOT, 'mcp', 'sce-editor-bridge.mjs')
check('exists', existsSync(bridgePath))

// 4. skills
console.log('\n[skills]')
const skills = [
  '3d-unit-game', 'canvas-2d-game', 'multiplayer-hybrid-sync',
  'ui-visual-design', 'ui-layout-api', 'server-authoritative-3d-physics', 'runtime-particle-builder',
  'wasicore-dev', 'data-editor', 'debug-tools', 'trigger-editor-mcp', 'client-only-debug',
  'ui-export-real-loop',
]
const skillsRoot = join(PLUGIN_ROOT, 'skills')
const actualSkills = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
  .sort()
const expectedSkills = [...skills].sort()
check('skill count is 13', actualSkills.length === 13, `found ${actualSkills.length}`)
check('skill directories match expected list', JSON.stringify(actualSkills) === JSON.stringify(expectedSkills))
for (const skill of skills) {
  const skillPath = join(skillsRoot, skill, 'SKILL.md')
  const exists = existsSync(skillPath)
  check(`${skill}/SKILL.md exists`, exists)
  if (exists) {
    const frontmatter = readFrontmatter(skillPath)
    check(`${skill} has valid frontmatter`, !!frontmatter)
    check(`${skill} frontmatter name matches directory`, frontmatter?.name === skill)
    check(`${skill} has description`, typeof frontmatter?.description === 'string')
    check(`${skill} has when_to_use`, typeof frontmatter?.when_to_use === 'string')
    check(`${skill} has allowed-tools`, typeof frontmatter?.['allowed-tools'] === 'string')
    check(`${skill} omits legacy whenToUse`, frontmatter?.whenToUse === undefined)
    check(`${skill} omits legacy allowedTools`, frontmatter?.allowedTools === undefined)
  }
}

const agentPath = join(PLUGIN_ROOT, 'agents', 'spark2-developer.md')
const agentContent = readFileSync(agentPath, 'utf-8')
const agentFrontmatter = readFrontmatter(agentPath)
check('agent has valid frontmatter', !!agentFrontmatter)
const agentSkills = String(agentFrontmatter?.skills ?? '')
  .split(',')
  .map((skill) => skill.trim())
  .filter(Boolean)
  .sort() ?? []
check('agent preloads every skill', JSON.stringify(agentSkills) === JSON.stringify(expectedSkills))
check('agent routes UI visual design skill', agentContent.includes('创建/新建/搭建完整 UI 页面') && agentContent.includes('| ui-visual-design |'))
check('agent routes UI layout skill', agentContent.includes('纯 UI API 查询') && agentContent.includes('| ui-layout-api |'))
check('agent routes UI export skill', agentContent.includes('| C# UI 导出') && agentContent.includes('| ui-export-real-loop |'))

// 5. reference.md companions
console.log('\n[reference.md companions]')
const withRef = ['3d-unit-game', 'canvas-2d-game', 'ui-layout-api', 'wasicore-dev']
for (const skill of withRef) {
  check(`${skill}/reference.md exists`, existsSync(join(PLUGIN_ROOT, 'skills', skill, 'reference.md')))
}

// 6. agent
console.log('\n[agents]')
check('spark2-developer.md exists', existsSync(join(PLUGIN_ROOT, 'agents', 'spark2-developer.md')))

// 7. commands
console.log('\n[commands]')
check('debug.md exists', existsSync(join(PLUGIN_ROOT, 'commands', 'debug.md')))
check('data.md exists', existsSync(join(PLUGIN_ROOT, 'commands', 'data.md')))

console.log('\n' + (process.exitCode ? '❌ Validation failed' : '✅ All checks passed'))
