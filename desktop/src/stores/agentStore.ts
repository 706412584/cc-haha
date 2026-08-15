import { create, type StoreApi } from 'zustand'
import {
  agentsApi,
  type AgentDefinition,
  type AgentMutationInput,
  type AgentOverrideInput,
  type AgentScope,
  type AgentSource,
} from '../api/agents'

export type AgentDetailReturnTab = 'agents' | 'plugins'

type AgentStore = {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  availableTools: string[]
  isLoading: boolean
  isMutating: boolean
  error: string | null
  mutationError: string | null
  mutationWarning: string | null
  selectedAgent: AgentDefinition | null
  selectedAgentReturnTab: AgentDetailReturnTab
  requestedCwd: string | null | undefined
  resolvedCwd: string | null | undefined
  isContextStale: boolean

  fetchAgents: (cwd?: string) => Promise<void>
  retryMutationRefresh: (cwd?: string, sessionId?: string) => Promise<void>
  createAgent: (input: AgentMutationInput, sessionId?: string) => Promise<AgentDefinition>
  updateAgent: (
    name: string,
    input: AgentMutationInput,
    sessionId?: string,
  ) => Promise<AgentDefinition>
  deleteAgent: (
    name: string,
    scope: AgentScope,
    cwd?: string,
    target?: string,
    sessionId?: string,
  ) => Promise<void>
  setAgentOverride: (
    name: string,
    input: AgentOverrideInput,
    sessionId?: string,
  ) => Promise<AgentDefinition>
  clearAgentOverride: (
    name: string,
    cwd?: string,
    sessionId?: string,
  ) => Promise<AgentDefinition>
  selectAgent: (
    agent: AgentDefinition | null,
    returnTab?: AgentDetailReturnTab,
  ) => void
}

let latestFetchRequestId = 0
let latestMutationRequestId = 0

/**
 * Spelled out rather than `typeof useAgentStore.setState`: helpers below are
 * reached from the store's own action bodies, so referring back to the store
 * makes its type self-referential and TypeScript falls back to `any` for the
 * whole store — and for every component that reads it.
 */
type AgentStoreSetter = StoreApi<AgentStore>['setState']

export const useAgentStore = create<AgentStore>((set, get) => ({
  activeAgents: [],
  allAgents: [],
  availableTools: [],
  isLoading: false,
  isMutating: false,
  error: null,
  mutationError: null,
  mutationWarning: null,
  selectedAgent: null,
  selectedAgentReturnTab: 'agents',
  requestedCwd: undefined,
  resolvedCwd: undefined,
  isContextStale: false,

  fetchAgents: async (cwd) => {
    const requestId = ++latestFetchRequestId
    const requestedCwd = normalizeAgentCwd(cwd)
    const resolvedCwd = get().resolvedCwd
    set((state) => ({
      isLoading: true,
      error: null,
      requestedCwd,
      isContextStale: resolvedCwd !== undefined && resolvedCwd !== requestedCwd,
      ...(!state.isMutating
        ? { mutationError: null, mutationWarning: null }
        : {}),
    }))
    try {
      const { activeAgents, allAgents, availableTools = [] } = await agentsApi.list(cwd)
      if (requestId !== latestFetchRequestId) return
      set((state) => {
        const selectedAgent = state.selectedAgent
          ? findMatchingAgent(allAgents, state.selectedAgent)
          : null
        return {
          activeAgents,
          allAgents,
          availableTools,
          isLoading: false,
          requestedCwd,
          resolvedCwd: requestedCwd,
          isContextStale: false,
          selectedAgent,
          selectedAgentReturnTab: selectedAgent ? state.selectedAgentReturnTab : 'agents',
        }
      })
    } catch (error) {
      if (requestId !== latestFetchRequestId) return
      const message = error instanceof Error ? error.message : 'Failed to load agents'
      set((state) => ({
        isLoading: false,
        error: message,
        isContextStale: state.resolvedCwd !== undefined && state.resolvedCwd !== requestedCwd,
      }))
    }
  },

  retryMutationRefresh: async (cwd, sessionId) => {
    const requestId = latestFetchRequestId + 1
    await get().fetchAgents(cwd)
    if (requestId !== latestFetchRequestId || get().error) return
    const mutationWarning = await getSessionReloadWarning(sessionId)
    if (requestId !== latestFetchRequestId) return
    set({ mutationWarning })
  },

  createAgent: async (input, sessionId) => {
    let createdTarget: string | undefined
    return runAgentMutation({
      mutate: async () => {
        const { agent } = await agentsApi.create(input)
        createdTarget = agent.target
        return agent
      },
      locate: (agents) =>
        findEditableAgent(
          agents,
          input.name,
          input.scope,
          createdTarget ?? input.target,
        ),
      cwd: input.cwd,
      sessionId,
      mutationErrorFallback: 'Failed to create agent',
      refreshErrorFallback: 'Failed to refresh agents after creating the agent',
      missingAfterRefreshMessage:
        'Created agent was not returned by the refreshed list',
      set,
    })
  },

  updateAgent: async (name, input, sessionId) => {
    let updatedTarget: string | undefined
    return runAgentMutation({
      mutate: async () => {
        const { agent } = await agentsApi.update(name, input)
        updatedTarget = agent.target
        return agent
      },
      locate: (agents) =>
        findEditableAgent(
          agents,
          input.name,
          input.scope,
          updatedTarget ?? input.target,
        ),
      cwd: input.cwd,
      sessionId,
      mutationErrorFallback: 'Failed to update agent',
      refreshErrorFallback: 'Failed to refresh agents after updating the agent',
      missingAfterRefreshMessage:
        'Updated agent was not returned by the refreshed list',
      set,
    })
  },

  setAgentOverride: async (name, input, sessionId) =>
    runAgentMutation({
      mutate: async () => (await agentsApi.setOverride(name, input)).agent,
      locate: (agents) => findBuiltInAgent(agents, name),
      cwd: input.cwd,
      sessionId,
      mutationErrorFallback: 'Failed to save the built-in agent override',
      refreshErrorFallback:
        'Failed to refresh agents after saving the built-in agent override',
      missingAfterRefreshMessage:
        'Overridden agent was not returned by the refreshed list',
      set,
    }),

  clearAgentOverride: async (name, cwd, sessionId) =>
    runAgentMutation({
      // The server decides what "built-in default" is — this build's default
      // differs per agent, so the store must never reconstruct it locally.
      mutate: async () => (await agentsApi.clearOverride(name, cwd)).agent,
      locate: (agents) => findBuiltInAgent(agents, name),
      cwd,
      sessionId,
      mutationErrorFallback: 'Failed to reset the built-in agent override',
      refreshErrorFallback:
        'Failed to refresh agents after resetting the built-in agent override',
      missingAfterRefreshMessage:
        'Reset agent was not returned by the refreshed list',
      set,
    }),

  deleteAgent: async (name, scope, cwd, target, sessionId) => {
    const requestId = ++latestMutationRequestId
    const displayRequestId = ++latestFetchRequestId
    set({
      isMutating: true,
      mutationError: null,
      mutationWarning: null,
      isLoading: false,
    })
    try {
      await agentsApi.delete(name, scope, cwd, target)
    } catch (error) {
      if (requestId === latestMutationRequestId) {
        const message = getErrorMessage(error, 'Failed to delete agent')
        set({
          isMutating: false,
          ...(displayRequestId === latestFetchRequestId ? { mutationError: message } : {}),
        })
      }
      throw error
    }

    startSessionReloadWarning(sessionId, requestId, displayRequestId, set)
    try {
      const response = await agentsApi.list(cwd)
      if (requestId !== latestMutationRequestId) return
      if (displayRequestId !== latestFetchRequestId) {
        set({ isMutating: false })
        return
      }
      const contextCwd = normalizeAgentCwd(cwd)
      set({
        ...response,
        selectedAgent: null,
        selectedAgentReturnTab: 'agents',
        isMutating: false,
        requestedCwd: contextCwd,
        resolvedCwd: contextCwd,
        isContextStale: false,
      })
    } catch (refreshError) {
      if (requestId === latestMutationRequestId && displayRequestId !== latestFetchRequestId) {
        set({ isMutating: false })
      } else if (requestId === latestMutationRequestId) {
        const contextCwd = normalizeAgentCwd(cwd)
        set((state) => ({
          activeAgents: removeMutationAgent(
            state.activeAgents,
            name,
            scope,
            target,
          ),
          allAgents: removeMutationAgent(
            state.allAgents,
            name,
            scope,
            target,
          ),
          selectedAgent: null,
          selectedAgentReturnTab: 'agents',
          isMutating: false,
          requestedCwd: contextCwd,
          resolvedCwd: contextCwd,
          isContextStale: false,
          mutationWarning: combineWarnings(
            getErrorMessage(
              refreshError,
              'Failed to refresh agents after deleting the agent',
            ),
            state.mutationWarning,
          ),
        }))
      }
    }
  },

  selectAgent: (agent, returnTab = 'agents') =>
    set({
      selectedAgent: agent,
      selectedAgentReturnTab: agent ? returnTab : 'agents',
    }),
}))

function normalizeAgentCwd(cwd?: string): string | null {
  return cwd ?? null
}

/**
 * Shared body for every mutation that ends with "reload the list and select the
 * agent I just changed": create, update, and the built-in override routes.
 *
 * The out-of-order guards are the reason this is shared rather than copied. A
 * mutation and a project switch race constantly here, and each of the two
 * counters answers a different question — `latestMutationRequestId` whether
 * this mutation is still the newest one, `latestFetchRequestId` whether the
 * list on screen is still the one this mutation was started against. A third
 * hand-written copy is how one of them goes missing.
 *
 * Delete is deliberately not routed through here: it clears the selection and
 * removes rather than upserts.
 */
async function runAgentMutation({
  mutate,
  locate,
  cwd,
  sessionId,
  mutationErrorFallback,
  refreshErrorFallback,
  missingAfterRefreshMessage,
  set,
}: {
  mutate: () => Promise<AgentDefinition>
  locate: (agents: AgentDefinition[]) => AgentDefinition | undefined
  cwd: string | undefined
  sessionId: string | undefined
  mutationErrorFallback: string
  refreshErrorFallback: string
  missingAfterRefreshMessage: string
  set: AgentStoreSetter
}): Promise<AgentDefinition> {
  const requestId = ++latestMutationRequestId
  const displayRequestId = ++latestFetchRequestId
  set({
    isMutating: true,
    mutationError: null,
    mutationWarning: null,
    isLoading: false,
  })

  let mutatedAgent: AgentDefinition
  try {
    mutatedAgent = await mutate()
  } catch (error) {
    if (requestId === latestMutationRequestId) {
      const message = getErrorMessage(error, mutationErrorFallback)
      set({
        isMutating: false,
        ...(displayRequestId === latestFetchRequestId ? { mutationError: message } : {}),
      })
    }
    throw error
  }

  startSessionReloadWarning(sessionId, requestId, displayRequestId, set)
  try {
    // Refetch rather than trusting the mutation response: overrides and
    // overriddenBy are computed across every source, so only a full list is
    // consistent.
    const response = await agentsApi.list(cwd)
    const refreshedAgent = locate(response.allAgents)
    if (!refreshedAgent) {
      throw new Error(missingAfterRefreshMessage)
    }
    if (requestId !== latestMutationRequestId) return refreshedAgent
    if (displayRequestId !== latestFetchRequestId) {
      set({ isMutating: false })
      return refreshedAgent
    }
    const contextCwd = normalizeAgentCwd(cwd)
    set({
      ...response,
      selectedAgent: refreshedAgent,
      selectedAgentReturnTab: 'agents',
      isMutating: false,
      requestedCwd: contextCwd,
      resolvedCwd: contextCwd,
      isContextStale: false,
    })
    return refreshedAgent
  } catch (refreshError) {
    if (requestId === latestMutationRequestId && displayRequestId !== latestFetchRequestId) {
      set({ isMutating: false })
    } else if (requestId === latestMutationRequestId) {
      const contextCwd = normalizeAgentCwd(cwd)
      set((state) => ({
        ...upsertMutationAgent(state, mutatedAgent),
        selectedAgent: mutatedAgent,
        selectedAgentReturnTab: 'agents',
        isMutating: false,
        requestedCwd: contextCwd,
        resolvedCwd: contextCwd,
        isContextStale: false,
        mutationWarning: combineWarnings(
          getErrorMessage(refreshError, refreshErrorFallback),
          state.mutationWarning,
        ),
      }))
    }
    return mutatedAgent
  }
}

/**
 * Built-in agents carry no scope or target — they are identified by name and
 * source alone, so findEditableAgent (which filters on user/project sources)
 * would never match one.
 */
function findBuiltInAgent(agents: AgentDefinition[], name: string) {
  return agents.find(
    (agent) => agent.agentType === name && agent.source === 'built-in',
  )
}

function findEditableAgent(
  agents: AgentDefinition[],
  name: string,
  scope: AgentScope,
  target?: string,
) {
  const source: AgentSource = scope === 'project' ? 'projectSettings' : 'userSettings'
  return agents.find((agent) =>
    agent.agentType === name &&
    agent.source === source &&
    (target === undefined || agent.target === target),
  )
}

function findMatchingAgent(agents: AgentDefinition[], selectedAgent: AgentDefinition) {
  return agents.find((agent) =>
    agent.agentType === selectedAgent.agentType &&
    agent.source === selectedAgent.source &&
    (selectedAgent.target === undefined || agent.target === selectedAgent.target),
  ) ?? null
}

function upsertMutationAgent(
  state: Pick<AgentStore, 'activeAgents' | 'allAgents'>,
  agent: AgentDefinition,
) {
  return {
    allAgents: upsertAgent(state.allAgents, agent),
    activeAgents: agent.isActive
      ? [
          ...state.activeAgents.filter(
            candidate => candidate.agentType !== agent.agentType,
          ),
          agent,
        ]
      : state.activeAgents.filter(candidate => !hasSameAgentIdentity(candidate, agent)),
  }
}

function upsertAgent(agents: AgentDefinition[], agent: AgentDefinition) {
  const index = agents.findIndex(candidate => hasSameAgentIdentity(candidate, agent))
  if (index === -1) return [...agents, agent]
  return agents.map((candidate, candidateIndex) => candidateIndex === index ? agent : candidate)
}

function removeMutationAgent(
  agents: AgentDefinition[],
  name: string,
  scope: AgentScope,
  target?: string,
) {
  const source: AgentSource = scope === 'project' ? 'projectSettings' : 'userSettings'
  return agents.filter(agent => !(
    agent.agentType === name &&
    agent.source === source &&
    agent.target === target
  ))
}

function hasSameAgentIdentity(
  candidate: AgentDefinition,
  agent: AgentDefinition,
) {
  return candidate.agentType === agent.agentType &&
    candidate.source === agent.source &&
    candidate.target === agent.target
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function startSessionReloadWarning(
  sessionId: string | undefined,
  requestId: number,
  displayRequestId: number,
  setState: AgentStoreSetter,
) {
  void getSessionReloadWarning(sessionId).then((reloadWarning) => {
    if (
      requestId !== latestMutationRequestId ||
      displayRequestId !== latestFetchRequestId
    ) return
    setState((state) => ({
      mutationWarning: combineWarnings(state.mutationWarning, reloadWarning),
    }))
  })
}

async function getSessionReloadWarning(
  sessionId?: string,
): Promise<string | null> {
  if (!sessionId) return null

  try {
    const { session } = await agentsApi.reload(sessionId)
    if (!session.applied) {
      return session.error || (session.reason === 'not_running'
        ? 'The active CLI session is not running; the saved agent will load when the session starts again.'
        : 'Failed to reload agent definitions in the active CLI session')
    }
    // `errors` belongs to the shared reload_plugins response and counts plugin
    // and hook loading errors. A completed control request has already swapped
    // the session's agent definitions, so those unrelated errors must not turn
    // a successful Agent mutation into an apply failure.
    return null
  } catch (error) {
    return getErrorMessage(
      error,
      'Failed to reload agent definitions in the active CLI session',
    )
  }
}

function combineWarnings(
  primary: string | null,
  secondary: string | null,
): string | null {
  if (!primary) return secondary
  if (!secondary || secondary === primary) return primary
  return `${primary}; ${secondary}`
}
