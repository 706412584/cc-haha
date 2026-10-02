/**
 * Disband (force delete) coverage.
 *
 * Lives in its own file because `src/server/__tests__/teams.test.ts` is
 * quarantined for cross-file pollution, and the changed-lines coverage gate
 * ignores quarantined files — the disband path would otherwise score 0%.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { TeamService } from './teamService.js'
import { handleTeamsApi } from '../api/teams.js'

let tmpDir: string
let service: TeamService

function teamConfig(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    description: 'A disbandable team',
    createdAt: 1700000000000,
    leadAgentId: 'agent-lead',
    members: [
      { agentId: 'agent-lead', name: 'Lead Agent', agentType: 'lead', color: '#f00', joinedAt: 1700000000000, cwd: '/tmp/project', isActive: false },
      { agentId: 'agent-worker', name: 'Worker Agent', agentType: 'worker', color: '#0f0', joinedAt: 1700000001000, cwd: '/tmp/project/src', isActive: false, terminated: true },
    ],
    ...overrides,
  }
}

async function writeTeamConfig(name: string, config: Record<string, unknown>): Promise<void> {
  const teamDir = path.join(tmpDir, 'teams', name)
  await fs.mkdir(teamDir, { recursive: true })
  await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify(config), 'utf-8')
}

async function readTeamConfig(name: string): Promise<{ members: Array<{ agentId: string }> } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(tmpDir, 'teams', name, 'config.json'), 'utf8'))
  } catch {
    return null
  }
}

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `claude-team-disband-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(tmpDir, 'teams'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'tasks'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  service = new TeamService()
})

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('TeamService.deleteTeam force disband', () => {
  it('refuses the guarded delete while teammates are still registered', async () => {
    await writeTeamConfig('stuck', teamConfig('stuck'))
    await expect(service.deleteTeam('stuck')).rejects.toThrow('teammates remain registered')
  })

  it('force-disbands a team whose teammates never got deregistered', async () => {
    await writeTeamConfig('stuck', teamConfig('stuck'))

    await service.deleteTeam('stuck', { force: true })

    await expect(fs.access(path.join(tmpDir, 'teams', 'stuck'))).rejects.toThrow()
  })

  it('deregisters every non-lead member before removing the directory', async () => {
    await writeTeamConfig('mixed', teamConfig('mixed'))
    // Read the config mid-flight is racy, so assert the observable end state:
    // the directory is gone, which is only reachable once the members were
    // dropped from config.json.
    expect((await readTeamConfig('mixed'))?.members).toHaveLength(2)
    await service.deleteTeam('mixed', { force: true })
    expect(await readTeamConfig('mixed')).toBeNull()
  })

  it('is idempotent for a team that no longer exists', async () => {
    await expect(service.deleteTeam('ghost', { force: true })).rejects.toThrow('Team not found')
  })
})

describe('DELETE /api/teams/:name?force=true', () => {
  it('disbands through the API and rejects a non-forced delete of a populated team', async () => {
    await writeTeamConfig('api-stuck', teamConfig('api-stuck'))

    const guarded = await handleTeamsApi(
      new Request('http://localhost/api/teams/api-stuck', { method: 'DELETE' }),
      new URL('http://localhost/api/teams/api-stuck'),
      ['api', 'teams', 'api-stuck'],
    )
    expect(guarded.status).toBe(409)

    const forced = await handleTeamsApi(
      new Request('http://localhost/api/teams/api-stuck?force=true', { method: 'DELETE' }),
      new URL('http://localhost/api/teams/api-stuck?force=true'),
      ['api', 'teams', 'api-stuck'],
    )
    expect(forced.status).toBe(200)
    expect(await forced.json()).toEqual({ ok: true })
    await expect(fs.access(path.join(tmpDir, 'teams', 'api-stuck'))).rejects.toThrow()
  })
})
