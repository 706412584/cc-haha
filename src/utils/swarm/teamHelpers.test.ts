import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readTeamFile,
  setMemberActive,
  type TeamFile,
  writeTeamFileAsync,
} from './teamHelpers.js'

test('setMemberActive preserves concurrent updates to different members', async () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-member-active-'))
  process.env.CLAUDE_CONFIG_DIR = configDir

  try {
    const teamName = 'concurrent-team'
    const members: TeamFile['members'] = Array.from(
      { length: 3 },
      (_, index) => ({
        agentId: `worker-${index}@${teamName}`,
        name: `worker-${index}`,
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: process.cwd(),
        subscriptions: [],
        backendType: 'in-process',
        isActive: false,
      }),
    )
    await writeTeamFileAsync(teamName, {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId: `team-lead@${teamName}`,
      members,
    })

    await Promise.all(
      members.map(member => setMemberActive(teamName, member.name, true)),
    )

    const updated = readTeamFile(teamName)
    expect(updated?.members).toHaveLength(members.length)
    expect(updated?.members.every(member => member.isActive === true)).toBe(
      true,
    )
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  }
})
