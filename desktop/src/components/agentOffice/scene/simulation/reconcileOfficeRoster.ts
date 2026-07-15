import type { Agent } from '../../types/agent'

const DEFAULT_IDLE_RETENTION_SECONDS = 90

function emptySlot(slot: Agent): Agent {
  return {
    ...slot,
    role: undefined,
    state: 'idle',
    currentTask: undefined,
    sourceKey: undefined,
    ambientEligible: undefined,
    retainedIdleRemaining: undefined,
  }
}

function placeInSlot(slot: Agent, activity: Agent): Agent {
  return {
    ...activity,
    id: slot.id,
    color: slot.color,
    x: slot.x,
    y: slot.y,
    assignedDeskId: slot.assignedDeskId,
  }
}

export function reconcileOfficeRoster(
  current: Agent[],
  incoming: Agent[],
  idleRetentionSeconds = DEFAULT_IDLE_RETENTION_SECONDS,
): Agent[] {
  if (incoming.length === 0) return []

  const next = incoming.map((slot) => emptySlot(slot))
  next[0] = { ...incoming[0]! }
  const incomingActivities = incoming.slice(1).filter((agent) => agent.sourceKey)
  const incomingBySource = new Map(incomingActivities.map((agent) => [agent.sourceKey!, agent]))
  const assignedSources = new Set<string>()

  for (let index = 1; index < current.length && index < next.length; index++) {
    const previous = current[index]
    if (!previous?.sourceKey) continue
    const activity = incomingBySource.get(previous.sourceKey)
    if (activity) {
      next[index] = placeInSlot(next[index]!, activity)
      assignedSources.add(previous.sourceKey)
      continue
    }

    next[index] = {
      ...previous,
      state: 'idle',
      currentTask: undefined,
      ambientEligible: true,
      retainedIdleRemaining: previous.retainedIdleRemaining ?? idleRetentionSeconds,
    }
  }

  for (const activity of incomingActivities) {
    if (assignedSources.has(activity.sourceKey!)) continue
    let slotIndex = next.findIndex((slot, index) => index > 0 && !slot.sourceKey)
    if (slotIndex < 0) {
      slotIndex = next.findIndex((slot, index) => index > 0 && slot.retainedIdleRemaining != null)
    }
    if (slotIndex < 0) break
    next[slotIndex] = placeInSlot(next[slotIndex]!, activity)
    assignedSources.add(activity.sourceKey!)
  }

  return next
}

export function tickRetainedOfficeRoster(
  current: Agent[],
  dt: number,
  incoming: Agent[],
): Agent[] {
  return current.map((agent, index) => {
    if (agent.retainedIdleRemaining == null) return agent
    const remaining = agent.retainedIdleRemaining - dt
    return remaining > 0
      ? { ...agent, retainedIdleRemaining: remaining }
      : emptySlot(incoming[index] ?? agent)
  })
}
