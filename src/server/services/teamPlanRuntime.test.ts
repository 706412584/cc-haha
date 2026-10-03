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

describe('captureTaskOutcomes', () => {
  const saved = { home: process.env.HOME, config: process.env.CLAUDE_CONFIG_DIR }
  let root: string
  const teamName = 'capture-team'
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'team-capture-'))
    process.env.HOME = root
    process.env.CLAUDE_CONFIG_DIR = root
    await writeTeamFileAsync(teamName, { name: teamName, createdAt: 1, leadAgentId: `team-lead@${teamName}`, leadSessionId: 's', members: [] } as never)
  })
  afterEach(async () => {
    if (saved.home === undefined) delete process.env.HOME
    else process.env.HOME = saved.home
    if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved.config
    await rm(root, { recursive: true, force: true })
  })

  test('records completed, in-progress and untouched tasks, flagging mid-flight ones', async () => {
    const { createTask, updateTask, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const listId = getCanonicalTeamTaskListId(teamName)
    const plan = { planId: 'p1', teamName, tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] } as never
    for (const id of ['T1', 'T2', 'T3']) {
      await createTask(listId, { subject: id, description: '', status: 'pending', blocks: [], blockedBy: [], metadata: { teamPlanId: 'p1', teamPlanTaskId: id } })
    }
    const rows = await import('../../utils/tasks.js').then(m => m.listTasks(listId))
    const byPlanId = (id: string) => rows.find(r => r.metadata?.teamPlanTaskId === id)!.id
    await updateTask(listId, byPlanId('T1'), { status: 'completed' })
    await updateTask(listId, byPlanId('T2'), { status: 'in_progress', owner: 'worker' })

    const { captureTaskOutcomes } = await import('./teamPlanRuntime.js')
    const outcomes = await captureTaskOutcomes(plan)
    expect(outcomes.T1).toMatchObject({ status: 'completed' })
    expect(outcomes.T1?.interrupted).toBeUndefined()
    expect(outcomes.T2).toMatchObject({ status: 'in_progress', interrupted: true })
    expect(outcomes.T3).toMatchObject({ status: 'pending' })
    expect(outcomes.T3?.interrupted).toBeUndefined()
  })

  test('treats a task marked teamRuntimeInterrupted as mid-flight even when it reads pending', async () => {
    const tasks = await import('../../utils/tasks.js')
    const listId = tasks.getCanonicalTeamTaskListId(teamName)
    await tasks.createTask(listId, { subject: 'T1', description: '', status: 'pending', blocks: [], blockedBy: [], metadata: { teamPlanId: 'p1', teamPlanTaskId: 'T1', teamRuntimeInterrupted: true } })
    const { captureTaskOutcomes } = await import('./teamPlanRuntime.js')
    const outcomes = await captureTaskOutcomes({ planId: 'p1', teamName, tasks: [{ id: 'T1' }] } as never)
    expect(outcomes.T1?.interrupted).toBe(true)
  })
})
