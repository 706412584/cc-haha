import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTeamWorkersBarrier, stopTeamPlanRuntimesForParent, stopTeamPlanRuntimesForTeam, validateTeamPlanRuntime } from './teamPlanRuntime.js'
import { readTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { getTeamDir, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'

test('runtime rejects a legacy review with a teammate name that cannot launch', async () => {
  const plan = { workDir: process.cwd(), members: [{ id: 'reader', name: 'README Reader' }] } as never
  await expect(validateTeamPlanRuntime(plan)).rejects.toThrow('Invalid teammate name: README Reader')
})

describe('stopping a plan that is already running', () => {
  const saved = { home: process.env.HOME, config: process.env.CLAUDE_CONFIG_DIR }
  let root: string
  const teamName = 'Running.Team'
  const sessionId = 'running-parent'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'team-plan-stop-'))
    process.env.HOME = root
    process.env.CLAUDE_CONFIG_DIR = root
  })
  afterEach(async () => {
    if (saved.home === undefined) delete process.env.HOME
    else process.env.HOME = saved.home
    if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved.config
    await rm(root, { recursive: true, force: true })
  })

  async function writeRunningPlan() {
    const createdAt = Date.now()
    await writeTeamFileAsync(teamName, { name: teamName, createdAt, leadAgentId: `team-lead@${teamName}`, leadSessionId: sessionId, members: [] } as never)
    const incarnationId = createHash('sha256').update(JSON.stringify([teamName, sessionId, createdAt])).digest('hex')
    const runtime = { providerId: 'fake', modelId: 'fixture' }
    const plan = {
      schemaVersion: 1, planId: 'running-plan', sessionId, teamName, incarnationId, revision: 3,
      state: 'running', workDir: root, leaderRuntime: runtime,
      members: [{ id: 'm1', name: 'worker', agentType: 'general-purpose', prompt: 'fixture', runtime }],
      tasks: [{ id: 't1', subject: 'fixture', ownerId: 'm1', dependencies: [] }],
      launch: { status: 'running', memberIds: { m1: 'child-1' } },
      createdAt, updatedAt: createdAt,
    }
    await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
    return plan
  }

  // Regression: stopping a *running* team used to leave the plan reading
  // `running` forever. The UI kept offering a team that no longer existed, and
  // the plan could never be cleared.
  test('a stopped running plan becomes interrupted instead of staying running', async () => {
    await writeRunningPlan()
    await stopTeamPlanRuntimesForParent(sessionId)
    const plan = await readTeamPlan(teamName)
    expect(plan?.state).toBe('interrupted')
    expect(plan?.launch?.executionStarted).toBe(true)
  })

  test('disband by name stops the same plan even without the parent session', async () => {
    await writeRunningPlan()
    await stopTeamPlanRuntimesForTeam(teamName)
    expect((await readTeamPlan(teamName))?.state).toBe('interrupted')
  })

  test('a plan already interrupted is left untouched', async () => {
    const plan = await writeRunningPlan()
    await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify({ ...plan, state: 'interrupted' }))
    await stopTeamPlanRuntimesForTeam(teamName)
    const after = await readTeamPlan(teamName)
    expect(after?.state).toBe('interrupted')
    expect(after?.revision).toBe(3)
  })
})

describe('team worker ready barrier', () => {
  test('never releases a task before all isolated runtimes are ready', async () => {
    const events: string[] = []
    const ids = await startTeamWorkersBarrier(['cheap', 'capable'], async member => {
      events.push(`prepare:${member}`)
      return member
    }, async member => { events.push(`release:${member}`) }, async id => { events.push(`stop:${id}`) })
    expect(ids).toEqual(['cheap', 'capable'])
    expect(events).toEqual(['prepare:cheap', 'prepare:capable', 'release:cheap', 'release:capable'])
  })
  test('failed preparation rolls back ready workers without sending a task', async () => {
    const released: string[] = []
    const stopped: string[] = []
    await expect(startTeamWorkersBarrier(['a', 'b'], async member => {
      if (member === 'b') throw new Error('provider unavailable')
      return member
    }, async member => { released.push(member) }, async id => { stopped.push(id) })).rejects.toThrow('provider unavailable')
    expect(released).toEqual([])
    expect(stopped).toEqual(['a'])
  })
  test('release failure stops workers and never automatically retries', async () => {
    const released: string[] = []
    const stopped: string[] = []
    await expect(startTeamWorkersBarrier(['a', 'b'], async member => member, async member => {
      released.push(member)
      if (member === 'b') throw new Error('lost SDK connection')
    }, async id => { stopped.push(id) })).rejects.toThrow('lost SDK connection')
    expect(released).toEqual(['a', 'b'])
    expect(stopped).toEqual(['a', 'b'])
  })
})
