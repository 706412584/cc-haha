import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getTeamFilePath,
  mutateTeamFileAsync,
  readTeamFile,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import { assertAgentTeamExists, inputSchema } from './AgentTool.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir = ''

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-agent-team-preflight-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  await rm(configDir, { recursive: true, force: true })
})

describe('AgentTool model schema', () => {
  test('accepts the official fable model alias', () => {
    expect(
      inputSchema().safeParse({
        description: 'Review model routing',
        prompt: 'Inspect the agent model selection path.',
        model: 'fable',
      }).success,
    ).toBe(true)
  })

  test('continues to reject unsupported per-call model values', () => {
    expect(
      inputSchema().safeParse({
        description: 'Review model routing',
        prompt: 'Inspect the agent model selection path.',
        model: 'mythos',
      }).success,
    ).toBe(false)
  })

  test('rejects a missing team before spawning any teammate', () => {
    expect(() => assertAgentTeamExists('missing-team', null)).toThrow(
      'omit team_name to launch an ordinary subagent',
    )
  })

  test('accepts an empty team name for optional-field compatibility', () => {
    expect(
      inputSchema().safeParse({
        description: 'Review retry behavior',
        prompt: 'Inspect the retry boundary.',
        team_name: '',
      }).success,
    ).toBe(true)
  })

  test('accepts an initialized team file', () => {
    expect(() => assertAgentTeamExists('existing-team', {
      name: 'existing-team',
      createdAt: 1,
      leadAgentId: 'team-lead@existing-team',
      members: [],
    })).not.toThrow()
  })
})

describe('AgentTool team spawn preflight', () => {
  test('rejects a missing team without leaving a phantom config', async () => {
    await expect(mutateTeamFileAsync('missing-team', () => {})).rejects.toThrow(
      'Team "missing-team" does not exist',
    )

    expect(existsSync(getTeamFilePath('missing-team'))).toBe(false)
  })

  test('treats malformed team state as missing', async () => {
    const teamFilePath = getTeamFilePath('malformed-team')
    await mkdir(dirname(teamFilePath), { recursive: true })
    await writeFile(teamFilePath, '{}')

    expect(readTeamFile('malformed-team')).toBeNull()
    await expect(mutateTeamFileAsync('malformed-team', () => {})).rejects.toThrow(
      'Team "malformed-team" does not exist',
    )
  })

  test('updates an initialized team under the file lock', async () => {
    const teamFilePath = getTeamFilePath('ready-team')
    const teamFile: TeamFile = {
      name: 'ready-team',
      createdAt: Date.now(),
      leadAgentId: 'lead@ready-team',
      members: [],
    }
    await mkdir(dirname(teamFilePath), { recursive: true })
    await writeFile(teamFilePath, JSON.stringify(teamFile))

    const updated = await mutateTeamFileAsync('ready-team', current => {
      current.description = 'updated'
    })

    expect(updated.description).toBe('updated')
    expect(JSON.parse(await readFile(teamFilePath, 'utf-8')).description).toBe(
      'updated',
    )
  })
})
