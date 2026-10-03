import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approveTeamPlan, deleteTeamPlan, ensureTeamDraft, findTeamPlanForSession, readTeamPlan, replaceTeamPlan, resumeTeamPlan, stageMember, submitTeamPlan } from './teamPlanStore.js'
import { getTeamDir, writeTeamFileAsync } from './teamHelpers.js'
import type { TeamPlanRecord } from '../../shared/teamPlan.js'
let root: string
const saved = { home: process.env.HOME, config: process.env.CLAUDE_CONFIG_DIR }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'team-plan-store-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = root
  await writeTeamFileAsync('review', { name: 'review', createdAt: 1, leadAgentId: 'lead', leadSessionId: 'session', members: [] })
})
afterEach(async () => {
  if (saved.home === undefined) delete process.env.HOME
  else process.env.HOME = saved.home
  if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = saved.config
  await rm(root, { recursive: true, force: true })
})
const runtime = { providerId: 'fake', modelId: 'fixture' }
const identity = (plan: TeamPlanRecord) => ({ planId: plan.planId, sessionId: plan.sessionId, incarnationId: plan.incarnationId, expectedRevision: plan.revision })
async function draft() {
  await ensureTeamDraft('review', 'session', runtime)
  const memberPlan = await stageMember('review', { id: 'worker', name: 'Worker', agentType: 'general-purpose', prompt: 'Do fixture work', runtime })
  return replaceTeamPlan('review', identity(memberPlan), { tasks: [{ id: 't1', subject: 'fixture task', ownerId: 'worker', dependencies: [] }] })
}
test('legacy team has no inferred plan or approval; additive plan preserves unknown fields', async () => {
  expect(await readTeamPlan('review')).toBeNull()
  const plan = await draft()
  const path = join(getTeamDir('review'), 'plan.json')
  await writeFile(path, JSON.stringify({ ...plan, futureField: { preserve: true } }))
  const next = await replaceTeamPlan('review', identity(plan), { feedback: 'Change allocation' })
  expect(next.futureField).toEqual({ preserve: true })
  expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(1)
  expect((await findTeamPlanForSession('session'))?.planId).toBe(plan.planId)
})
test('staged edits reject stale revisions and graph corruption without partial writes', async () => {
  const plan = await draft()
  await expect(replaceTeamPlan('review', identity(plan), { tasks: [{ id: 't', subject: 'cycle', dependencies: ['t'] }] })).rejects.toThrow('cycle')
  expect((await readTeamPlan('review'))?.revision).toBe(plan.revision)
  await replaceTeamPlan('review', identity(plan), { feedback: 'new' })
  await expect(submitTeamPlan('review', identity(plan))).rejects.toThrow('changed')
})
test('old invalid teammate names cannot be approved or saved from review', async () => {
  const plan = await draft()
  await expect(replaceTeamPlan('review', identity(plan), { members: [{ ...plan.members[0]!, name: 'README Reader' }] })).rejects.toThrow('Invalid teammate name')
  const submitted = await submitTeamPlan('review', identity(plan))
  await expect(approveTeamPlan('review', identity(submitted), 'invalid', { ...submitted, members: [{ ...submitted.members[0]!, name: 'README Reader' }] })).rejects.toThrow('Invalid teammate name')
  expect((await readTeamPlan('review'))?.state).toBe('review_pending')
})
test('approval has frozen snapshot, idempotent retries, and concurrent admission once', async () => {
  const plan = await draft()
  const submitted = await submitTeamPlan('review', identity(plan))
  const results = await Promise.all([1, 2].map(() => approveTeamPlan('review', identity(submitted), 'request', submitted)))
  expect(results.filter(result => result.committed)).toHaveLength(1)
  const approved = results[0].plan
  expect(approved.approvedSnapshot?.members[0]?.runtime).toEqual(runtime)
  await expect(replaceTeamPlan('review', identity(approved), { members: [] })).rejects.toThrow('Only a draft')
})
test('same-name recreation fences stale approvals and does not inherit previous consent', async () => {
  const plan = await draft()
  const submitted = await submitTeamPlan('review', identity(plan))
  await writeTeamFileAsync('review', { name: 'review', createdAt: 2, leadAgentId: 'lead', leadSessionId: 'session', members: [] })
  await expect(approveTeamPlan('review', identity(submitted), 'request', submitted)).rejects.toThrow('identity changed')
  const replacement = await ensureTeamDraft('review', 'session', runtime)
  expect(replacement.planId).not.toBe(plan.planId)
  expect(replacement.state).toBe('draft')
})

test('unrelated corrupt plan is isolated from session lookup', async () => {
  const plan = await draft()
  await writeTeamFileAsync('broken', { name: 'broken', createdAt: 1, leadAgentId: 'other', leadSessionId: 'other-session', members: [] })
  await writeFile(join(getTeamDir('broken'), 'plan.json'), '{broken')
  expect((await findTeamPlanForSession('session'))?.planId).toBe(plan.planId)
})
test('submission requires assigned work for every member', async () => {
  const plan = await draft()
  const empty = await replaceTeamPlan('review', identity(plan), { tasks: [] })
  await expect(submitTeamPlan('review', identity(empty))).rejects.toThrow('assigned tasks')
  const unassigned = await replaceTeamPlan('review', identity(empty), { tasks: [{ id: 't', subject: 'unassigned', dependencies: [] }] })
  await expect(submitTeamPlan('review', identity(unassigned))).rejects.toThrow('Every member')
})
test('multiple incremental rosters retain all existing members and reject duplicate starts', async () => {
  const { mutateTeamPlan, isTeamExecutionApproved } = await import('./teamPlanStore.js')
  let plan = await draft()
  for (let i = 0; i < 3; i++) {
    const ready = await submitTeamPlan('review', identity(plan))
    const approved = (await approveTeamPlan('review', identity(ready), `req-${i}`, ready)).plan
    const running = await mutateTeamPlan('review', identity(approved), current => ({ ...current, state: 'running' }))
    expect(await isTeamExecutionApproved('review', 'Worker')).toBe(true)
    await expect(stageMember('review', { id: 'duplicate', name: 'Worker', agentType: 'general-purpose', prompt: 'duplicate', runtime })).rejects.toThrow('already has')
    if (i < 2) {
      const increment = await stageMember('review', { id: `worker-${i}`, name: `Worker-${i}`, agentType: 'general-purpose', prompt: 'new work', runtime })
      plan = await replaceTeamPlan('review', identity(increment), { tasks: [{ id: `t-${i}`, subject: 'new task', ownerId: `worker-${i}`, dependencies: [] }] })
    } else expect(running.parentPlanId).toBeDefined()
  }
})

test('replace and submit is atomic and failed replacement preserves the prior review', async () => {
  const plan = await draft()
  const initial = await submitTeamPlan('review', identity(plan))
  await expect(submitTeamPlan('review', identity(initial), { members: [] })).rejects.toThrow('members')
  expect((await readTeamPlan('review'))?.revision).toBe(initial.revision)
  const next = await submitTeamPlan('review', identity(initial), { tasks: [{ id: 'next', subject: 'replacement', ownerId: 'worker', dependencies: [] }] })
  expect(next.revision).toBe(initial.revision + 1)
  expect(next.state).toBe('review_pending')
  expect(next.tasks[0]?.subject).toBe('replacement')
  const edited = await replaceTeamPlan('review', identity(next), { feedback: 'model revision' })
  expect(edited.state).toBe('draft')
})


test('nested persisted extensions survive runtime replacement and approval without retaining obsolete effort', async () => {
  const plan = await draft()
  const path = join(getTeamDir('review'), 'plan.json')
  const member = plan.members[0]!
  await writeFile(path, JSON.stringify({ ...plan,
    leaderRuntime: { ...runtime, futureLeader: true },
    members: [{ ...member, futureMember: true, runtime: { ...runtime, effortLevel: 'high', futureRoute: { retained: true } } }],
    tasks: [{ ...plan.tasks[0], futureTask: true }],
    launch: { status: 'pending', futureLaunch: true },
  }))
  const changed = await replaceTeamPlan('review', identity(plan), { members: [{ ...member, runtime: { providerId: 'other', modelId: 'economy' } }] })
  expect(changed.members[0]?.runtime).toEqual({ providerId: 'other', modelId: 'economy', futureRoute: { retained: true } })
  const submitted = await submitTeamPlan('review', identity(changed))
  const approved = (await approveTeamPlan('review', identity(submitted), 'nested', submitted)).plan
  expect(approved.launch?.futureLaunch).toBe(true)
  expect(approved.approvedSnapshot?.members[0]?.futureMember).toBe(true)
  expect(approved.approvedSnapshot?.tasks[0]?.futureTask).toBe(true)
  expect(approved.approvedSnapshot?.leaderRuntime.futureLeader).toBe(true)
  expect((await readTeamPlan('review'))?.approvedSnapshot?.members[0]?.runtime.futureRoute).toEqual({ retained: true })
})


test('draft permits unfinished allocation but submission rejects extra unassigned work', async () => {
  const plan = await draft()
  const unassigned = await replaceTeamPlan('review', identity(plan), { tasks: [...plan.tasks, { id: 'extra', subject: 'Still needs an owner', dependencies: [] }] })
  expect(unassigned.state).toBe('draft')
  expect((await readTeamPlan('review'))?.tasks).toHaveLength(2)
  await expect(submitTeamPlan('review', identity(unassigned))).rejects.toThrow('Every task needs an assigned member')
  expect((await readTeamPlan('review'))?.revision).toBe(unassigned.revision)
  const complete = await submitTeamPlan('review', identity(unassigned), { tasks: unassigned.tasks.map(task => ({ ...task, ownerId: 'worker' })) })
  expect(complete.state).toBe('review_pending')
})

test('disband removes a settled plan but refuses to erase one that is still running', async () => {
  const plan = await draft()
  await deleteTeamPlan('review')
  expect(await readTeamPlan('review')).toBeNull()
  // Idempotent: a second disband of an already-gone plan is not an error.
  await deleteTeamPlan('review')

  await writeFile(join(getTeamDir('review'), 'plan.json'), JSON.stringify({ ...plan, state: 'running' }))
  await expect(deleteTeamPlan('review')).rejects.toThrow('Stop the team before disbanding it')
  expect((await readTeamPlan('review'))?.state).toBe('running')

  await writeFile(join(getTeamDir('review'), 'plan.json'), JSON.stringify({ ...plan, state: 'interrupted' }))
  await deleteTeamPlan('review')
  expect(await readTeamPlan('review')).toBeNull()
})

test('resume annotates the snapshot, skips completed tasks and refuses an all-done plan', async () => {
  const base = await draft()
  const plan = await replaceTeamPlan('review', identity(base), { tasks: [...base.tasks, { id: 't2', subject: 'second task', ownerId: 'worker', dependencies: [] }] })
  const [doneId, openId] = [plan.tasks[0]!.id, plan.tasks[1]!.id]
  const snapshot = { revision: plan.revision, members: plan.members, tasks: plan.tasks, leaderRuntime: plan.leaderRuntime, approvedAt: 1, requestId: 'approved' }
  const interrupted: TeamPlanRecord = {
    ...plan, state: 'interrupted', revision: plan.revision + 1, approvedSnapshot: snapshot,
    taskOutcomes: { [doneId]: { status: 'completed', capturedAt: 1 } },
  }
  await writeFile(join(getTeamDir('review'), 'plan.json'), JSON.stringify(interrupted))

  const after = await resumeTeamPlan('review', { ...identity(plan), expectedRevision: interrupted.revision }, 'resume-1')
  expect(after.plan.state).toBe('launching')
  expect(after.plan.approvedSnapshot?.revision).toBe(interrupted.revision)
  expect(after.plan.approvedSnapshot?.tasks.find(t => t.id === doneId)?.resumeState).toBe('done')
  expect(after.plan.approvedSnapshot?.tasks.find(t => t.id === openId)?.resumeState).toBe('run')
  expect(after.plan.resume?.runTaskIds).toEqual([openId])

  // Every task completed -> nothing to resume.
  const allDone: TeamPlanRecord = {
    ...interrupted, revision: after.plan.revision + 1,
    taskOutcomes: { [doneId]: { status: 'completed', capturedAt: 1 }, [openId]: { status: 'completed', capturedAt: 1 } },
  }
  await writeFile(join(getTeamDir('review'), 'plan.json'), JSON.stringify(allDone))
  await expect(resumeTeamPlan('review', { ...identity(plan), expectedRevision: allDone.revision }, 'resume-2'))
    .rejects.toThrow('nothing to resume')
})

// Regression: a plan interrupted before outcomes were captured (legacy, or a
// build that never wrote them) carries no `taskOutcomes`. Resuming it must not
// read every task as "never started" — the caller supplies outcomes captured
// from the live task list, and they are frozen onto the record for later resumes.
test('resume accepts caller-captured outcomes for a plan that has none', async () => {
  const base = await draft()
  const plan = await replaceTeamPlan('review', identity(base), { tasks: [...base.tasks, { id: 't2', subject: 'second task', ownerId: 'worker', dependencies: [] }] })
  const [doneId, openId] = [plan.tasks[0]!.id, plan.tasks[1]!.id]
  const snapshot = { revision: plan.revision, members: plan.members, tasks: plan.tasks, leaderRuntime: plan.leaderRuntime, approvedAt: 1, requestId: 'approved' }
  const legacy: TeamPlanRecord = {
    ...plan, state: 'interrupted', revision: plan.revision + 1, approvedSnapshot: snapshot,
  }
  await writeFile(join(getTeamDir('review'), 'plan.json'), JSON.stringify(legacy))

  const after = await resumeTeamPlan('review', { ...identity(plan), expectedRevision: legacy.revision }, 'resume-legacy', {
    fallbackOutcomes: { [doneId]: { status: 'completed', capturedAt: 2 }, [openId]: { status: 'pending', capturedAt: 2 } },
  })
  expect(after.plan.state).toBe('launching')
  expect(after.plan.approvedSnapshot?.tasks.find(t => t.id === doneId)?.resumeState).toBe('done')
  expect(after.plan.resume?.runTaskIds).toEqual([openId])
  // Frozen in the same write, so a later resume of a failed attempt reuses it.
  expect(after.plan.taskOutcomes?.[doneId]?.status).toBe('completed')
})

test('resume holds a mid-flight task unless it is explicitly confirmed', async () => {
  const base = await draft()
  const plan = await replaceTeamPlan('review', identity(base), { tasks: [...base.tasks, { id: 't2', subject: 'second task', ownerId: 'worker', dependencies: [] }] })
  const [heldId, openId] = [plan.tasks[0]!.id, plan.tasks[1]!.id]
  const snapshot = { revision: plan.revision, members: plan.members, tasks: plan.tasks, leaderRuntime: plan.leaderRuntime, approvedAt: 1, requestId: 'approved' }
  const interrupted: TeamPlanRecord = {
    ...plan, state: 'interrupted', revision: plan.revision + 1, approvedSnapshot: snapshot,
    taskOutcomes: { [heldId]: { status: 'in_progress', interrupted: true, capturedAt: 1 } },
  }
  await writeFile(join(getTeamDir('review'), 'plan.json'), JSON.stringify(interrupted))

  const held = await resumeTeamPlan('review', { ...identity(plan), expectedRevision: interrupted.revision }, 'r-held')
  expect(held.plan.approvedSnapshot?.tasks.find(t => t.id === heldId)?.resumeState).toBe('held')
  expect(held.plan.resume?.heldTaskIds).toEqual([heldId])
  expect(held.plan.resume?.runTaskIds).toEqual([openId])

  await writeFile(join(getTeamDir('review'), 'plan.json'), JSON.stringify({
    ...interrupted, revision: held.plan.revision + 1,
  }))
  const confirmed = await resumeTeamPlan('review', { ...identity(plan), expectedRevision: held.plan.revision + 1 }, 'r-confirm', { confirmTaskIds: [heldId] })
  expect(confirmed.plan.approvedSnapshot?.tasks.find(t => t.id === heldId)?.resumeState).toBe('run')
  expect(confirmed.plan.resume?.heldTaskIds).toEqual([])
  expect(confirmed.plan.resume?.runTaskIds).toEqual([heldId, openId])
})

test('resume refuses when every remaining task is held and none is confirmed', async () => {
  const plan = await draft()
  const taskId = plan.tasks[0]!.id
  const snapshot = { revision: plan.revision, members: plan.members, tasks: plan.tasks, leaderRuntime: plan.leaderRuntime, approvedAt: 1, requestId: 'approved' }
  await writeFile(join(getTeamDir('review'), 'plan.json'), JSON.stringify({
    ...plan, state: 'interrupted', revision: plan.revision + 1, approvedSnapshot: snapshot,
    taskOutcomes: { [taskId]: { status: 'in_progress', interrupted: true, capturedAt: 1 } },
  }))
  await expect(resumeTeamPlan('review', { ...identity(plan), expectedRevision: plan.revision + 1 }, 'r-none'))
    .rejects.toThrow('nothing to resume')
})

test('resume refuses a plan that is not interrupted', async () => {
  const plan = await draft()
  await expect(resumeTeamPlan('review', { ...identity(plan), expectedRevision: plan.revision }, 'r-bad'))
    .rejects.toThrow('Only an interrupted team can resume')
})
