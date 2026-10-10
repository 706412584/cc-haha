import { z } from 'zod/v4'
import { teamPlanRuntimeSchema, type TeamPlanAction, type TeamPlanIdentity, type TeamPlanRecord } from '../../shared/teamPlan.js'
import { approveTeamPlan, findTeamPlanForSession, mutateTeamPlan, readTeamPlan, replaceTeamPlan, TeamPlanError } from '../../utils/swarm/teamPlanStore.js'

const identitySchema = z.object({
  sessionId: z.string().min(1), planId: z.string().min(1), incarnationId: z.string().min(1), expectedRevision: z.number().int().positive(),
})
export const teamPlanActionSchema = identitySchema.extend({ requestId: z.string().min(1), feedback: z.string().optional() })
export const teamPlanPatchRequestSchema = identitySchema.extend({
  members: z.array(z.object({ id: z.string().min(1), agentType: z.string().min(1).optional(), runtime: teamPlanRuntimeSchema.optional() }).strict()).optional(),
  tasks: z.array(z.object({ id: z.string().min(1), ownerId: z.string().min(1) }).strict()).optional(),
}).strict()

export type TeamPlanRuntimeAdapter = {
  validate(plan: TeamPlanRecord): Promise<TeamPlanRecord>
  launch(plan: TeamPlanRecord): Promise<{ memberIds: Record<string, string> }>
  stop(planId: string): Promise<void>
  isRunning?(planId: string): boolean | Promise<boolean>
  /** Re-own an approved team whose owner was lost; its members restart on demand. */
  rehydrate?(plan: TeamPlanRecord): Promise<boolean>
  notifyLeader?(plan: TeamPlanRecord, kind: 'approved' | 'returned' | 'cancelled'): Promise<void>
  /** Freeze per-task outcomes from the live task list; absent in minimal test adapters. */
  captureOutcomes?(plan: TeamPlanRecord): Promise<NonNullable<TeamPlanRecord['taskOutcomes']>>
}
const defaultRuntime: TeamPlanRuntimeAdapter = {
  isRunning: async id => (await import('./teamPlanRuntime.js')).isTeamPlanRuntimeActive(id),
  rehydrate: async plan => (await import('./teamPlanRuntime.js')).rehydrateTeamPlanRuntimesForSession(plan.sessionId),
  validate: async plan => (await import('./teamPlanRuntime.js')).validateTeamPlanRuntime(plan),
  launch: async plan => (await import('./teamPlanRuntime.js')).launchTeamPlanRuntime(plan),
  notifyLeader: async (plan, kind) => { await (await import('./teamPlanRuntime.js')).notifyTeamPlanLeader(plan, kind) },
  stop: async id => { await (await import('./teamPlanRuntime.js')).stopTeamPlanRuntime(id) },
  captureOutcomes: async plan => (await import('./teamPlanRuntime.js')).captureTaskOutcomes(plan),
}

/** Only trusted HTTP/UI actions call approve; model tools import the draft store only. */
export class TeamPlanService {
  private launches = new Map<string, Promise<void>>()
  /** Approvals whose plan may already read `launching` before its launch is registered. */
  private approving = new Set<string>()
  constructor(private runtime: TeamPlanRuntimeAdapter = defaultRuntime) {}
  async getForSession(sessionId: string): Promise<TeamPlanRecord | null> {
    const plan = await findTeamPlanForSession(sessionId)
    // A server restart lost ownership of an unfinished launch. Never silently replay it.
    if (plan?.state === 'launching' && !this.launches.has(plan.planId) && !this.approving.has(plan.planId)) {
      return mutateTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, current => ({ ...current, state: 'interrupted', launch: { ...current.launch, status: 'failed', error: 'Launch ownership was lost. Work may have started and will not be replayed.' } }))
    }
    if (plan?.state === 'running' && this.runtime.isRunning && !await this.runtime.isRunning(plan.planId)) {
      // A server or app restart lost the in-memory owner, not the team: members
      // keep their transcripts and resume when messaged.
      if (this.runtime.rehydrate && await this.runtime.rehydrate(plan).catch(() => false) && await this.runtime.isRunning(plan.planId)) return plan
      return mutateTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, current => ({ ...current, state: 'interrupted', launch: { ...current.launch, status: 'failed', error: 'The worker runtime was interrupted. Started work will not be replayed.' } }))
    }
    // An interrupted plan from before outcomes were captured has none, which
    // reads as "every task never started": the card would offer to re-run
    // finished work and hide the mid-flight tasks the user must confirm. The
    // task list still holds the truth, so backfill the frozen outcomes here —
    // the read path that already repairs lost launches. Persisted, so later
    // polls and the resume itself see the same snapshot.
    if (plan?.state === 'interrupted' && !plan.taskOutcomes) {
      const taskOutcomes = await this.captureOutcomes(plan).catch(error => {
        console.warn('[TeamPlanService] Could not capture task outcomes for an interrupted plan', error)
        return undefined
      })
      if (taskOutcomes) {
        return mutateTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, current => (
          current.taskOutcomes ? current : { ...current, taskOutcomes }
        )).catch(() => plan)
      }
    }
    return plan
  }

  private async captureOutcomes(plan: TeamPlanRecord): Promise<NonNullable<TeamPlanRecord['taskOutcomes']>> {
    const capture = this.runtime.captureOutcomes ?? (async item => (await import('./teamPlanRuntime.js')).captureTaskOutcomes(item))
    return capture(plan)
  }
  /**
   * Freeze the interrupted plan together with its per-task outcomes, so a later
   * resume can tell "never started" from "died halfway" without relying on the
   * task list, which cannot represent that distinction once reset.
   */
  private async interrupt(plan: TeamPlanRecord, error: string): Promise<TeamPlanRecord> {
    const { captureTaskOutcomes } = await import('./teamPlanRuntime.js')
    const taskOutcomes = await captureTaskOutcomes(plan).catch(() => undefined)
    return mutateTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, current => ({
      ...current, state: 'interrupted', ...(taskOutcomes ? { taskOutcomes } : {}),
      launch: { ...current.launch, status: 'failed', error },
    }))
  }
  async update(teamName: string, identity: TeamPlanIdentity, patch: { members?: Array<{ id: string; agentType?: string; runtime?: TeamPlanRecord['leaderRuntime'] }>; tasks?: Array<{ id: string; ownerId: string }> }): Promise<TeamPlanRecord> {
    const current = await readTeamPlan(teamName)
    if (!current) throw new TeamPlanError('Plan not found', 404)
    for (const member of patch.members ?? []) if (!current.members.some(item => item.id === member.id)) throw new TeamPlanError('Unknown member', 400)
    for (const task of patch.tasks ?? []) if (!current.tasks.some(item => item.id === task.id)) throw new TeamPlanError('Unknown task', 400)
    const members = current.members.map(member => {
      const edit = patch.members?.find(item => item.id === member.id)
      if (!edit) return member
      const agentType = edit.agentType ?? member.agentType
      const snapshot = current.agentCatalog?.[agentType]
      if (!snapshot) throw new TeamPlanError('Agent preset is unavailable', 400)
      const presetChanged = agentType !== member.agentType
      const presetModel = snapshot.model && snapshot.model !== 'inherit' ? snapshot.model : current.leaderRuntime.modelId
      const suggestedRuntime = { providerId: member.runtime.providerId, modelId: presetModel, ...(snapshot.effortLevel ? { effortLevel: snapshot.effortLevel } : {}) }
      return { ...member, agentType, agentSnapshot: structuredClone(snapshot),
        ...(presetChanged ? { suggestedRuntime } : {}),
        ...(presetChanged && !edit.runtime && member.runtimeSource !== 'human' ? { runtime: suggestedRuntime } : {}),
        ...(edit.runtime ? { runtime: edit.runtime, runtimeSource: 'human' } : {}),
      }
    })
    const tasks = current.tasks.map(task => ({ ...task, ...patch.tasks?.find(item => item.id === task.id) }))
    return replaceTeamPlan(teamName, identity, { members, tasks }, { preserveReview: true })
  }
  private start(plan: TeamPlanRecord): void {
    const operation = this.runtime.launch(plan).then(async result => {
      const current = await readTeamPlan(plan.teamName)
      if (!current || current.planId !== plan.planId || current.state !== 'launching') return
      await mutateTeamPlan(plan.teamName, { ...current, expectedRevision: current.revision }, item => ({ ...item, state: 'running', launch: { ...item.launch, status: 'running', memberIds: result.memberIds } }))
    }).catch(async error => {
      await this.runtime.stop(plan.planId).catch(() => {})
      const current = await readTeamPlan(plan.teamName)
      if (!current || current.planId !== plan.planId || current.state !== 'launching') return
      const started = error && typeof error === 'object' && 'executionStarted' in error && error.executionStarted === true
      if (started) return await this.interrupt(current, error instanceof Error ? error.message : String(error))
      await mutateTeamPlan(plan.teamName, { ...current, expectedRevision: current.revision }, item => ({ ...item, state: 'launch_failed', launch: { ...item.launch, status: 'failed', error: error instanceof Error ? error.message : String(error) } }))
    }).finally(() => { this.launches.delete(plan.planId) })
    this.launches.set(plan.planId, operation)
    void operation.catch(() => {})
  }
  async approve(teamName: string, action: TeamPlanAction): Promise<TeamPlanRecord> {
    const current = await readTeamPlan(teamName)
    if (!current) throw new TeamPlanError('Plan not found', 404)
    // Idempotent replay still goes through store identity/incarnation checks.
    let validated = current
    if (current.approvedSnapshot?.requestId !== action.requestId) {
      if (current.planId !== action.planId || current.sessionId !== action.sessionId || current.incarnationId !== action.incarnationId || current.revision !== action.expectedRevision) throw new TeamPlanError('Plan changed; refresh before continuing')
      try { validated = await this.runtime.validate(current) }
      catch (error) { throw new TeamPlanError(error instanceof Error ? error.message : 'Team configuration is unavailable', 400) }
    }
    // The approval commits `launching` before this call can register the
    // launch; a plan read in between must not take it for an orphaned launch.
    this.approving.add(current.planId)
    try {
      const result = await approveTeamPlan(teamName, action, action.requestId, validated)
      if (result.committed) this.start(result.plan)
      return result.plan
    } finally {
      this.approving.delete(current.planId)
    }
  }
  /**
   * Resume an interrupted team on its unfinished tasks. `confirmTaskIds` names
   * the mid-flight tasks the user accepts re-running; the rest are held back.
   */
  async resume(teamName: string, action: TeamPlanAction, confirmTaskIds: string[] = []): Promise<TeamPlanRecord> {
    const { resumeTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
    // Plans interrupted before this feature existed (or by a build that never
    // captured outcomes) carry no frozen `taskOutcomes`. Without them every
    // task reads as "never started" and a resume would re-run work that already
    // finished. The task list still holds the truth for those plans, so capture
    // it here and hand it to the store, which freezes it in the same write that
    // commits the resume — capturing it as a separate mutation would bump the
    // revision and invalidate the client's expectedRevision.
    const existing = await readTeamPlan(teamName)
    const fallbackOutcomes = existing &&
      existing.planId === action.planId &&
      existing.state === 'interrupted' &&
      !existing.taskOutcomes &&
      existing.tasks.length > 0
      ? await this.captureOutcomes(existing).catch(error => {
          // No outcomes means every task would be released as "never started",
          // re-running finished work. Refuse rather than guess; the caller can
          // retry once the task list is readable.
          throw new TeamPlanError(
            `Cannot resume: the task list is unavailable (${error instanceof Error ? error.message : String(error)})`,
            409,
          )
        })
      : undefined
    const { plan, committed } = await resumeTeamPlan(teamName, action, action.requestId, {
      confirmTaskIds,
      ...(fallbackOutcomes ? { fallbackOutcomes } : {}),
    })
    if (committed) this.start(plan)
    return plan
  }
  async action(teamName: string, kind: 'return' | 'cancel' | 'retry', action: TeamPlanAction): Promise<TeamPlanRecord> {
    if (kind === 'retry') {
      const plan = await mutateTeamPlan(teamName, action, current => {
        if (current.state !== 'launch_failed') throw new TeamPlanError('Only failed launches can retry')
        return { ...current, state: 'review_pending', approvedSnapshot: undefined, launch: undefined }
      })
      return plan
    }
    const plan = await mutateTeamPlan(teamName, action, current => {
      if (kind === 'return' && current.state !== 'draft' && current.state !== 'review_pending') throw new TeamPlanError('Only a pending plan can return to planning')
      if (kind === 'cancel' && current.state === 'running') throw new TeamPlanError('Use the running team stop control')
      return { ...current, state: kind === 'cancel' ? 'cancelled' : 'draft', feedback: action.feedback }
    })
    if (kind === 'cancel') await this.runtime.stop(plan.planId)
    try {
      await this.runtime.notifyLeader?.(plan, kind === 'cancel' ? 'cancelled' : 'returned')
    } catch (error) {
      // The control transition already committed. Preserve the delivery failure
      // on the durable draft instead of inviting a duplicate control action.
      return mutateTeamPlan(teamName, { ...plan, expectedRevision: plan.revision }, current => ({ ...current, controlDeliveryError: error instanceof Error ? error.message : String(error) }))
    }
    return plan
  }
}
export const teamPlanService = new TeamPlanService()
