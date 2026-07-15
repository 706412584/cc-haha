import type { Agent } from '../../types/agent'

const SCENE_STATE_KEYS = [
  'x',
  'y',
  'targetX',
  'targetY',
  'walkPath',
  'walkPathIndex',
  'state',
  'currentTask',
  'bubbleText',
  'customAnimation',
  'facing',
  'viewFacing',
] as const

export function mergeOfficeAgentSnapshot(
  currentAgents: Agent[],
  incomingAgents: Agent[],
): Agent[] {
  const currentById = new Map(currentAgents.map((agent) => [agent.id, agent]))
  const interruptedAmbientEventIds = new Set(
    incomingAgents.flatMap((incoming) => {
      const current = currentById.get(incoming.id)
      return current?.ambientEventId && incoming.ambientEligible !== true
        ? [current.ambientEventId]
        : []
    }),
  )

  return incomingAgents.map((incoming) => {
    const current = currentById.get(incoming.id)
    if (!current || current.sourceKey !== incoming.sourceKey) {
      return { ...incoming }
    }

    if (
      current.ambientEventId &&
      interruptedAmbientEventIds.has(current.ambientEventId)
    ) {
      return { ...incoming }
    }

    if (!current.mission && !current.customAnimation) {
      return { ...incoming }
    }

    const merged = { ...incoming }
    for (const key of SCENE_STATE_KEYS) {
      Object.assign(merged, { [key]: current[key] })
    }

    if (current.mission) {
      merged.mission = {
        ...current.mission,
        resumeState: incoming.state,
        resumeTask: incoming.currentTask ?? '',
      }
    }

    if (current.ambientEventId) {
      merged.ambientEventId = current.ambientEventId
      merged.ambientKind = current.ambientKind
      merged.ambientRemaining = current.ambientRemaining
      merged.ambientResumeState = current.ambientResumeState
      merged.ambientResumeTask = current.ambientResumeTask
    }

    return merged
  })
}
