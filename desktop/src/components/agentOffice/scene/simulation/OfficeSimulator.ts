import type { Agent } from '../../types/agent'
import {
  AGENT_ROSTER,
  DESKS,
  HANDOFF_STATUS,
} from '../layout/officeLayout'
import {
  agentHasActiveMission,
  processDeskVisitMissions,
  startDeskVisit,
  startDeskVisitTour,
  type DeskVisitMessageFn,
} from '../simulation/deskVisit'
import type { AgentEntity } from '../entities/AgentEntity'
import { talkFacingToward } from '../systems/movementFacing'

export type OfficeAmbientCopy = {
  chatTask: string
  chatFirst: string
  chatSecond: string
  watch: string
  game: string
}

const DEFAULT_AMBIENT_COPY: OfficeAmbientCopy = {
  chatTask: 'Taking a break',
  chatFirst: 'How is your day going?',
  chatSecond: 'Glad to have a breather.',
  watch: 'Watching a show',
  game: 'Playing a game',
}

type OfficeSimulatorOptions = {
  random?: () => number
  ambientInterval?: number
  ambientDuration?: number
  copy?: OfficeAmbientCopy
}

const DEFAULT_AMBIENT_INTERVAL = 45
const DEFAULT_AMBIENT_DURATION = 7

export class OfficeSimulator {
  private readonly random: () => number
  private readonly ambientInterval: number
  private readonly ambientDuration: number
  private copy: OfficeAmbientCopy
  private ambientElapsed = 0
  private ambientSequence = 0

  constructor(options: OfficeSimulatorOptions = {}) {
    this.random = options.random ?? Math.random
    this.ambientInterval = options.ambientInterval ?? DEFAULT_AMBIENT_INTERVAL
    this.ambientDuration = options.ambientDuration ?? DEFAULT_AMBIENT_DURATION
    this.copy = options.copy ?? DEFAULT_AMBIENT_COPY
  }

  setCopy(copy: OfficeAmbientCopy) {
    this.copy = copy
  }

  tick(dt: number, agents: Agent[]): Agent[] {
    let next = this.updateAmbientEvents(dt, agents.map((a) => ({ ...a })))
    this.ambientElapsed += dt

    if (
      this.ambientElapsed >= this.ambientInterval &&
      !next.some((agent) => agent.ambientEventId)
    ) {
      this.ambientElapsed = 0
      next = this.startAmbientEvent(next)
    }

    return this.pinAmbientAgents(next)
  }

  private updateAmbientEvents(dt: number, agents: Agent[]): Agent[] {
    return agents.map((agent) => {
      if (!agent.ambientEventId) return agent

      const remaining = (agent.ambientRemaining ?? 0) - dt
      if (remaining > 0) return { ...agent, ambientRemaining: remaining }

      return {
        ...agent,
        state: agent.ambientResumeState ?? ('idle' as const),
        currentTask: agent.ambientResumeTask,
        bubbleText: undefined,
        customAnimation: undefined,
        ambientEventId: undefined,
        ambientKind: undefined,
        ambientRemaining: undefined,
        ambientResumeState: undefined,
        ambientResumeTask: undefined,
        viewFacing: 'back' as const,
        facing: 1 as const,
      }
    })
  }

  private startAmbientEvent(agents: Agent[]): Agent[] {
    const candidates = agents
      .map((agent, index) => ({ agent, index }))
      .filter(({ agent, index }) =>
        index > 0 &&
        agent.ambientEligible === true &&
        (agent.state === 'idle' || agent.state === 'thinking') &&
        Boolean(agent.sourceKey) &&
        !agent.mission &&
        !agent.customAnimation,
      )

    if (candidates.length === 0) return agents

    const kindRoll = this.random()
    const kind = kindRoll < 1 / 3
      ? 'chat' as const
      : kindRoll < 2 / 3
        ? 'watch' as const
        : 'game' as const
    if (kind === 'chat' && candidates.length < 2) return agents

    const eventId = `ambient-${++this.ambientSequence}`
    if (kind === 'chat') {
      const firstIndex = Math.floor(this.random() * candidates.length)
      const secondOffset = 1 + Math.floor(this.random() * (candidates.length - 1))
      const first = candidates[firstIndex]!
      const second = candidates[(firstIndex + secondOffset) % candidates.length]!
      const firstFacing = talkFacingToward(
        first.agent.x,
        first.agent.y,
        second.agent.x,
        second.agent.y,
      )
      const secondFacing = talkFacingToward(
        second.agent.x,
        second.agent.y,
        first.agent.x,
        first.agent.y,
      )

      return agents.map((agent, index) => {
        if (index !== first.index && index !== second.index) return agent
        const toward = index === first.index ? firstFacing : secondFacing
        return {
          ...agent,
          state: 'talking' as const,
          currentTask: this.copy.chatTask,
          bubbleText: index === first.index ? this.copy.chatFirst : this.copy.chatSecond,
          customAnimation: 'emotes/laugh',
          ambientEventId: eventId,
          ambientKind: kind,
          ambientRemaining: this.ambientDuration,
          ambientResumeState: agent.state,
          ambientResumeTask: agent.currentTask,
          ...toward,
        }
      })
    }

    const selected = candidates[Math.floor(this.random() * candidates.length)] ?? candidates[0]!
    const label = kind === 'watch' ? this.copy.watch : this.copy.game
    const animation = kind === 'watch' ? 'emotes/idea' : 'emotes/excited'
    return agents.map((agent, index) => index === selected.index
      ? {
          ...agent,
          state: 'talking' as const,
          currentTask: label,
          bubbleText: label,
          customAnimation: animation,
          ambientEventId: eventId,
          ambientKind: kind,
          ambientRemaining: this.ambientDuration,
          ambientResumeState: agent.state,
          ambientResumeTask: agent.currentTask,
          viewFacing: 'front' as const,
          facing: 1 as const,
        }
      : agent)
  }

  /** 无任务员工固定在工位办公 */
  private pinAmbientAgents(agents: Agent[]): Agent[] {
    const visitorByHost = new Map<string, Agent>()
    for (const a of agents) {
      const m = a.mission
      if (m?.kind === 'desk_visit' && m.phase === 'talk') {
        visitorByHost.set(m.hostAgentId, a)
      }
    }

    return agents.map((agent) => {
      if (agentHasActiveMission(agent)) return agent

      const desk = this.deskFor(agent)
      const roster = AGENT_ROSTER.find((r) => r.id === agent.id)
      const visitor = visitorByHost.get(agent.id)
      const toward = visitor
        ? talkFacingToward(agent.x, agent.y, visitor.x, visitor.y)
        : agent.ambientKind === 'chat'
          ? { viewFacing: agent.viewFacing ?? 'front', facing: agent.facing }
          : agent.customAnimation
            ? { viewFacing: 'front' as const, facing: 1 as const }
            : { viewFacing: 'back' as const, facing: 1 as const }

      const state =
        visitor
          ? ('talking' as const)
          : agent.customAnimation
            ? ('talking' as const)
          : agent.state === 'thinking' || agent.state === 'idle' || agent.state === 'talking'
            ? agent.state
            : ('working' as const)

      return {
        ...agent,
        x: desk.seatX,
        y: desk.seatY,
        state,
        viewFacing: toward.viewFacing,
        facing: toward.facing,
        currentTask: visitor
          ? HANDOFF_STATUS.receiving
          : state === 'idle'
            ? undefined
            : (agent.currentTask ?? roster?.task),
        targetX: undefined,
        targetY: undefined,
        walkPath: undefined,
        walkPathIndex: undefined,
        bubbleText: agent.ambientEventId ? agent.bubbleText : undefined,
      }
    })
  }

  /** @param rosterNo 名册序号，从 1 开始 */
  startDeskVisit(
    agents: Agent[],
    visitorRosterNo: number,
    hostRosterNo: number,
    message: string,
  ): Agent[] {
    return startDeskVisit(agents, visitorRosterNo, hostRosterNo, message)
  }

  startDeskVisitTour(
    agents: Agent[],
    visitorRosterNo: number,
    hostRosterNos: number[],
    messageFn?: DeskVisitMessageFn,
  ): Agent[] {
    return startDeskVisitTour(agents, visitorRosterNo, hostRosterNos, messageFn)
  }

  afterMovement(
    dt: number,
    agents: Agent[],
    entities: Map<string, AgentEntity>,
  ): Agent[] {
    return processDeskVisitMissions(dt, agents, entities)
  }

  private deskFor(agent: Agent) {
    const id = agent.assignedDeskId
    return DESKS.find((d) => d.id === id) ?? DESKS[0]!
  }
}
