import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TeamPlanRecord } from '../../shared/teamPlan.js'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../types/provider.js'
import { ProviderService } from './providerService.js'
import { startTeamWorkersBarrier, stopTeamPlanRuntimesForParent, stopTeamPlanRuntimesForTeam, validateTeamPlanRuntime } from './teamPlanRuntime.js'
import { readTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { getTeamDir, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'

let home: string
let savedEnv: Record<string, string | undefined>
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'team-plan-runtime-'))
  savedEnv = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
})
afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

function modelPlan(providerId: string, modelId: string): TeamPlanRecord {
  return {
    workDir: home,
    agentCatalog: { fixture: { systemPrompt: 'Fixture instructions', model: modelId, source: 'flagSettings', sourceIdentity: { kind: 'session' } } },
    members: [{ id: 'worker', name: 'worker', agentType: 'fixture', prompt: 'Work', runtime: { providerId, modelId } }],
  } as TeamPlanRecord
}

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

describe('team preset model resolution', () => {
  test.each([
    ['claude-opus-4-6', 'member-opus'],
    ['claude-opus-4-6[1m]', 'member-opus'],
    ['claude-3-opus-20240229', 'member-opus'],
    ['claude-3-5-sonnet-20241022', 'member-sonnet'],
    ['claude-fable-5-1', 'member-opus'],
  ])('maps saved %s through the approved member provider', async (requestedModel, expectedModel) => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom', name: 'Member provider', baseUrl: 'http://127.0.0.1:1', apiKey: 'fake-member-key',
      models: { main: 'member-main', sonnet: 'member-sonnet', opus: 'member-opus', haiku: 'member-haiku' },
    })
    const validated = await validateTeamPlanRuntime(modelPlan(provider.id, requestedModel))
    expect(validated.members[0]?.runtime).toEqual({ providerId: provider.id, modelId: expectedModel })
    expect(validated.members[0]?.agentSnapshot?.model).toBe(requestedModel)
  })

  test('retains an explicit Claude version for the official provider', async () => {
    const validated = await validateTeamPlanRuntime(modelPlan(CLAUDE_OFFICIAL_PROVIDER_ID, 'claude-opus-4-6'))
    expect(validated.members[0]?.runtime).toEqual({ providerId: CLAUDE_OFFICIAL_PROVIDER_ID, modelId: 'claude-opus-4-6' })
  })

  test('retains version pins when a configured provider maps the family to Claude', async () => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom', name: 'Claude provider', baseUrl: 'http://127.0.0.1:1', apiKey: 'fake-claude-key',
      models: { main: 'claude-sonnet-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' },
    })
    const validated = await validateTeamPlanRuntime(modelPlan(provider.id, 'claude-opus-4-6'))
    expect(validated.members[0]?.runtime).toEqual({ providerId: provider.id, modelId: 'claude-opus-4-6' })
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

describe('ending a team at the user\'s request', () => {
  const runtime = { providerId: 'fake', modelId: 'fixture' }
  async function team(members: Array<{ agentId: string; name: string }>) {
    const { writeTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
    const { ensureTeamDraft } = await import('../../utils/swarm/teamPlanStore.js')
    const tasks = await import('../../utils/tasks.js')
    await writeTeamFileAsync('review', { name: 'review', createdAt: 1, leadAgentId: 'team-lead@review', leadSessionId: 'session', members: [
      { agentId: 'team-lead@review', name: 'team-lead', joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [] },
      ...members.map(member => ({ ...member, joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [], backendType: 'process' as const })),
    ] })
    const listId = tasks.getCanonicalTeamTaskListId('review')
    await tasks.withTaskListLifecycleLock(listId, () => tasks.beginTaskListLifecycle(listId, { teamName: 'review', createdAt: 1, leadSessionId: 'session' }))
    await tasks.createTask(listId, { subject: 'materialized by the launch', description: '', status: 'pending', owner: 'worker', blocks: [], blockedBy: [] })
    return ensureTeamDraft('review', 'session', runtime)
  }

  test('a team no member joined is removed with its tasks, and the running lead lets go of it', async () => {
    const { conversationService } = await import('./conversationService.js')
    const { readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
    const { readTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
    const { listTasks, getCanonicalTeamTaskListId } = await import('../../utils/tasks.js')
    const { endTeamOfPlan } = await import('./teamPlanRuntime.js')
    const controls: unknown[] = []
    const hasSession = spyOn(conversationService, 'hasSession').mockImplementation(id => id === 'session')
    const control = spyOn(conversationService, 'requestControl').mockImplementation(async (_id, request) => { controls.push(request); return {} })
    try {
      const plan = await team([])
      expect(await endTeamOfPlan(plan, { unlessStarted: true })).toBe(true)
      expect(readTeamFile('review')).toBeNull()
      expect(await readTeamPlan('review')).toBeNull()
      expect(await listTasks(getCanonicalTeamTaskListId('review'))).toEqual([])
      expect(controls).toEqual([{ subtype: 'team_runtime_ended', team_name: 'review' }])
    } finally {
      hasSession.mockRestore()
      control.mockRestore()
    }
  })

  test('a team a member already joined is only ended when asked to end it whole', async () => {
    const { readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
    const { endTeamOfPlan } = await import('./teamPlanRuntime.js')
    const plan = await team([{ agentId: 'worker@review', name: 'worker' }])
    expect(await endTeamOfPlan(plan, { unlessStarted: true })).toBe(false)
    expect(readTeamFile('review')?.members.map(member => member.name)).toEqual(['team-lead', 'worker'])
    expect(await endTeamOfPlan(plan)).toBe(true)
    expect(readTeamFile('review')).toBeNull()
  })

  test('a launch cut off before any member joined takes back its tasks; one a member joined is left as it is', async () => {
    const { mutateTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
    const { reclaimUnstartedLaunch } = await import('./teamPlanRuntime.js')
    const tasks = await import('../../utils/tasks.js')
    const listId = tasks.getCanonicalTeamTaskListId('review')
    const draft = await team([])
    const plan = { ...draft, approvedSnapshot: { revision: 1, members: [{ id: 'w', name: 'worker' }], tasks: [], leaderRuntime: runtime, approvedAt: 1, requestId: 'r' } } as unknown as TeamPlanRecord
    const own = (subject: string) => tasks.createTask(listId, { subject, description: '', status: 'pending', owner: 'worker', blocks: [], blockedBy: [], metadata: { teamPlanId: plan.planId, teamPlanTaskId: subject } })
    const subjects = async () => (await tasks.listTasks(listId)).map(task => task.subject).sort()

    // The app stopped after the tasks were written and before the roster was.
    await own('read')
    expect(await reclaimUnstartedLaunch(plan)).toBe(true)
    // Only this plan's tasks go; the one the helper made for another plan stays.
    expect(await subjects()).toEqual(['materialized by the launch'])

    // A task already under way, or a member on the roster, means work may have started.
    const started = await own('write')
    await tasks.updateTask(listId, started, { status: 'in_progress' })
    expect(await reclaimUnstartedLaunch(plan)).toBe(false)
    await tasks.updateTask(listId, started, { status: 'pending' })
    await mutateTeamFileAsync('review', current => ({ ...current, members: [...current.members, { agentId: 'worker@review', name: 'worker', joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [] }] }))
    expect(await reclaimUnstartedLaunch(plan)).toBe(false)
    expect(await subjects()).toEqual(['materialized by the launch', 'write'])
  })

  test('the lead hears once, with the reason, that its team did not start', async () => {
    const { conversationService } = await import('./conversationService.js')
    const { mutateTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
    const { noteLeadUserMessage } = await import('./teamPlanRuntime.js')
    const sent: string[] = []
    const send = spyOn(conversationService, 'sendMessage').mockImplementation(async (_id, text) => { sent.push(String(text)); return true })
    try {
      const plan = await team([])
      await noteLeadUserMessage('session')
      expect(sent).toEqual([])
      await mutateTeamPlan('review', { ...plan, expectedRevision: plan.revision }, current => ({ ...current, state: 'launch_failed', launch: { status: 'failed', error: 'CLI session exited before the control request completed' } }))
      await noteLeadUserMessage('session')
      await noteLeadUserMessage('session')
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain('Your team review did not start, so none of its members is running')
      expect(sent[0]).toContain('\nWhat failed: CLI session exited before the control request completed')
      // Members proposed for a team already at work fail without stopping it.
      // A crashed process's output can be long; the lead gets the start of it.
      const failed = (await import('../../utils/swarm/teamPlanStore.js')).readTeamPlan
      const current = (await failed('review'))!
      const output = `worker did not start: CLI process exited unexpectedly (code 1): stderr:\n${'at frame\n'.repeat(400)}`
      await mutateTeamPlan('review', { ...current, expectedRevision: current.revision }, item => ({ ...item, parentPlanId: 'running-plan', launch: { status: 'failed', error: output } }))
      await noteLeadUserMessage('session')
      expect(sent).toHaveLength(2)
      expect(sent[1]).toContain('The members you proposed to add to your team review did not start')
      expect(sent[1]).toContain('Members already running are not affected')
      expect(sent[1]).toContain('What failed: worker did not start: CLI process exited unexpectedly (code 1)')
      expect(sent[1].length).toBeLessThan(output.length)
      expect(sent[1].endsWith('…')).toBe(true)
    } finally {
      send.mockRestore()
    }
  })
})
