import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TeamPlanRecord } from '../../shared/teamPlan.js'

let home: string
let originalEnv: NodeJS.ProcessEnv
let planIds: string[] = []
const restorers: Array<() => void> = []

beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'team-resume-control-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
  planIds = []
})

afterEach(async () => {
  const runtime = await import('./teamPlanRuntime.js')
  await Promise.all(planIds.map(id => runtime.stopTeamPlanRuntime(id)))
  runtime.setTeamRuntimeTimingForTests(null)
  for (const restore of restorers.splice(0)) restore()
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(home, { recursive: true, force: true })
})

async function makePlan() {
  const { writeTeamFileAsync, getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
  const { beginTaskListLifecycle, getCanonicalTeamTaskListId, withTaskListLifecycleLock } = await import('../../utils/tasks.js')
  const teamName = `resume-${crypto.randomUUID().slice(0, 8)}`
  const sessionId = `lead-${crypto.randomUUID()}`
  const createdAt = Date.now()
  const incarnationId = createHash('sha256').update(JSON.stringify([teamName, sessionId, createdAt])).digest('hex')
  const identity = { leadSessionId: sessionId, incarnationId }
  const planId = crypto.randomUUID()
  const requestId = `resume-${crypto.randomUUID()}`
  const runtime = await import('./teamPlanRuntime.js')
  const { conversationService } = await import('./conversationService.js')
  const hasSessionSpy = spyOn(conversationService, 'hasSession').mockReturnValue(true)
  restorers.push(() => hasSessionSpy.mockRestore())
  // Keep launch side effects offline; an empty approved roster exercises the real authorization/control boundary.
  const sendMessageSpy = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
  restorers.push(() => sendMessageSpy.mockRestore())
  planIds.push(planId)

  await writeTeamFileAsync(teamName, {
    name: teamName,
    createdAt,
    leadAgentId: `team-lead@${teamName}`,
    leadSessionId: sessionId,
    members: [],
  } as any)
  const listId = getCanonicalTeamTaskListId(teamName)
  await withTaskListLifecycleLock(listId, () => beginTaskListLifecycle(listId, { teamName, createdAt, leadSessionId: sessionId }))

  const plan: TeamPlanRecord = {
    schemaVersion: 1,
    planId,
    sessionId,
    teamName,
    incarnationId,
    revision: 3,
    state: 'launching',
    workDir: home,
    leaderRuntime: { providerId: 'fixture', modelId: 'fixture' },
    members: [],
    tasks: [],
    createdAt,
    updatedAt: createdAt,
    approvedSnapshot: { revision: 2, members: [], tasks: [], leaderRuntime: { providerId: 'fixture', modelId: 'fixture' }, approvedAt: createdAt, requestId },
    resume: { requestId, resumedAt: createdAt, attempt: 1, runTaskIds: [], heldTaskIds: [] },
    launch: { status: 'pending' },
  }
  const planPath = join(getTeamDir(teamName), 'plan.json')
  await writeFile(planPath, JSON.stringify(plan))
  return { teamName, sessionId, createdAt, identity, plan, planPath, listId, runtime }
}

async function pausedControl(fixture: Awaited<ReturnType<typeof makePlan>>, ownerId: string) {
  const controls = await import('../../utils/swarm/teamRuntimeControlStore.js')
  const initial = await controls.ensureTeamRuntimeControl(fixture.teamName, fixture.identity, ownerId, { approvedLaunch: true })
  return controls.mutateTeamRuntimeControl(fixture.teamName, { ...fixture.identity, expectedEpoch: initial.epoch }, current => ({
    ...current,
    status: 'paused',
    pausedAt: Date.now(),
    error: 'previous error',
    memberErrors: { oldMember: 'previous member error' },
    resume: { requestId: 'old-resume', epoch: current.epoch, createdAt: Date.now(), eligibleSessionIds: [], startedSessionIds: [] },
    extension: 'keep me',
  }))
}

test('an approved resume re-owns a paused control from an old runtime owner', async () => {
  const fixture = await makePlan()
  const { teamRuntimeOwnerId, launchTeamPlanRuntime } = fixture.runtime
  const before = await pausedControl(fixture, 'old-runtime-owner')

  await launchTeamPlanRuntime(fixture.plan)

  const controls = await import('../../utils/swarm/teamRuntimeControlStore.js')
  const after = await controls.readTeamRuntimeControl(fixture.teamName, fixture.identity)
  expect(after).toMatchObject({
    ownerId: teamRuntimeOwnerId,
    status: 'running',
    epoch: before.epoch + 1,
    extension: 'keep me',
  })
  expect(after?.pausedAt).toBeUndefined()
  expect(after?.error).toBeUndefined()
  expect(after?.memberErrors).toBeUndefined()
  expect(after?.resume).toBeUndefined()
}, 30_000)

test('an ordinary launch cannot bypass a paused control', async () => {
  const fixture = await makePlan()
  const ordinary = { ...fixture.plan, resume: undefined }
  await writeFile(fixture.planPath, JSON.stringify(ordinary))
  const before = await pausedControl(fixture, fixture.runtime.teamRuntimeOwnerId)

  await expect(fixture.runtime.launchTeamPlanRuntime(ordinary)).rejects.toThrow('Resume the paused team before adding members')

  const controls = await import('../../utils/swarm/teamRuntimeControlStore.js')
  expect(await controls.readTeamRuntimeControl(fixture.teamName, fixture.identity)).toEqual(before)
}, 30_000)

test('a resume revoked while waiting for the lifecycle lock does not reopen its control', async () => {
  const fixture = await makePlan()
  const before = await pausedControl(fixture, 'old-runtime-owner')
  const { conversationService } = await import('./conversationService.js')
  let markLeaderCheck!: () => void
  const leaderChecked = new Promise<void>(resolve => { markLeaderCheck = resolve })
  const hasSessionSpy = spyOn(conversationService, 'hasSession').mockImplementation(sessionId => {
    if (sessionId === fixture.sessionId) markLeaderCheck()
    return true
  })
  restorers.push(() => hasSessionSpy.mockRestore())

  let revokePlan!: () => void
  let markLockEntered!: () => void
  const lockEntered = new Promise<void>(resolve => { markLockEntered = resolve })
  const revokeSignal = new Promise<void>(resolve => { revokePlan = resolve })
  const { withTaskListLifecycleLock } = await import('../../utils/tasks.js')
  const { mutateTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
  const heldLock = withTaskListLifecycleLock(fixture.listId, async () => {
    markLockEntered()
    await revokeSignal
    await mutateTeamPlan(fixture.teamName, {
      planId: fixture.plan.planId,
      sessionId: fixture.plan.sessionId,
      incarnationId: fixture.plan.incarnationId,
      expectedRevision: fixture.plan.revision,
    }, current => ({ ...current, state: 'interrupted', approvedSnapshot: undefined, resume: undefined }))
  })
  await lockEntered

  const launching = fixture.runtime.launchTeamPlanRuntime(fixture.plan)
  await leaderChecked
  revokePlan()
  await heldLock

  await expect(launching).rejects.toThrow('Team launch authorization has been revoked')
  const controls = await import('../../utils/swarm/teamRuntimeControlStore.js')
  expect(await controls.readTeamRuntimeControl(fixture.teamName, fixture.identity)).toEqual(before)
}, 30_000)
