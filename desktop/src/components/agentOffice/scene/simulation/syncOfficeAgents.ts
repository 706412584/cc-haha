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
  const incomingById = new Map(incomingAgents.map((agent) => [agent.id, agent]))
  const interruptedAmbientEventIds = new Set(
    currentAgents.flatMap((current) => {
      if (!current.ambientEventId) return []
      const incoming = incomingById.get(current.id)
      const realStateChanged = incoming && current.ambientResumeState
        ? incoming.state !== current.ambientResumeState ||
          incoming.currentTask !== current.ambientResumeTask
        : incoming?.ambientEligible !== true
      return !incoming ||
        incoming.sourceKey !== current.sourceKey ||
        realStateChanged
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
        resumeTransient: {
          state: incoming.state,
          currentTask: incoming.currentTask,
          targetX: incoming.targetX,
          targetY: incoming.targetY,
          walkPath: incoming.walkPath?.map((point) => ({ ...point })),
          walkPathIndex: incoming.walkPathIndex,
          facing: incoming.facing,
          viewFacing: incoming.viewFacing,
        },
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
