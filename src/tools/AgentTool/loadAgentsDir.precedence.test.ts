import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveAgentOverrides } from './agentDisplay.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
} from './loadAgentsDir.js'

let tempHome: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalClaudeConfigDir: string | undefined
let originalNativeSearch: string | undefined

async function writeAgent(
  filePath: string,
  name: string,
  description: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      description,
    ].join('\n'),
  )
}

describe('project agent precedence', () => {
  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'agent-precedence-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalNativeSearch = process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH

    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    process.env.CLAUDE_CONFIG_DIR = join(tempHome, 'user-config')
    process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
    clearAgentDefinitionsCache()
  })

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }
    if (originalNativeSearch === undefined) {
      delete process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
    } else {
      process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = originalNativeSearch
    }

    clearAgentDefinitionsCache()
    await rm(tempHome, { recursive: true, force: true })
  })

  test('uses the closest project definition and keeps display selection aligned', async () => {
    const projectRoot = join(tempHome, 'project')
    const cwd = join(projectRoot, 'packages', 'app')
    const rootAgent = join(projectRoot, '.claude', 'agents', 'root.md')
    const closestAgent = join(cwd, '.claude', 'agents', 'closest.md')
    const firstDuplicate = join(cwd, '.claude', 'agents', 'a-first.md')
    const lastDuplicate = join(cwd, '.claude', 'agents', 'z-last.md')

    await mkdir(join(projectRoot, '.git'), { recursive: true })
    await writeAgent(rootAgent, 'nested-reviewer', 'root definition')
    await writeAgent(closestAgent, 'nested-reviewer', 'closest definition')
    await writeAgent(lastDuplicate, 'same-directory', 'last definition')
    await writeAgent(firstDuplicate, 'same-directory', 'first definition')

    const result = await getAgentDefinitionsWithOverrides(cwd)
    const activeNested = result.activeAgents.find(
      agent => agent.agentType === 'nested-reviewer',
    )
    const activeDuplicate = result.activeAgents.find(
      agent => agent.agentType === 'same-directory',
    )
    const displayed = resolveAgentOverrides(
      result.allAgents,
      result.activeAgents,
    )
    const displayedDuplicate = displayed.find(
      agent => agent.agentType === 'same-directory',
    )

    expect(activeNested?.rawSystemPrompt).toBe('closest definition')
    expect(activeNested?.sourceFilePath).toBe(closestAgent)
    expect(activeDuplicate?.sourceFilePath).toBe(firstDuplicate)
    expect(displayedDuplicate?.sourceFilePath).toBe(firstDuplicate)
  })
})
