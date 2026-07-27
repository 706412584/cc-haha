import { create } from 'zustand'
import {
  agentsApi,
  type AgentDefinition,
  type AgentMutationInput,
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
  selectAgent: (
    agent: AgentDefinition | null,
    returnTab?: AgentDetailReturnTab,
  ) => void
}

let latestFetchRequestId = 0
let latestMutationRequestId = 0

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
    const requestId = ++latestMutationRequestId
    const displayRequestId = ++latestFetchRequestId
    set({
      isMutating: true,
      mutationError: null,
      mutationWarning: null,
      isLoading: false,
    })
    let createdAgent: AgentDefinition
    try {
      const mutationResponse = await agentsApi.create(input)
      createdAgent = mutationResponse.agent
    } catch (error) {
      if (requestId === latestMutationRequestId) {
        const message = getErrorMessage(error, 'Failed to create agent')
        set({
          isMutating: false,
          ...(displayRequestId === latestFetchRequestId ? { mutationError: message } : {}),
        })
      }
      throw error
    }

    startSessionReloadWarning(sessionId, requestId, displayRequestId, set)
    try {
      const response = await agentsApi.list(input.cwd)
      const refreshedAgent = findEditableAgent(
        response.allAgents,
        input.name,
        input.scope,
        createdAgent.target ?? input.target,
      )
      if (!refreshedAgent) {
        throw new Error('Created agent was not returned by the refreshed list')
      }
      if (requestId !== latestMutationRequestId) return refreshedAgent
      if (displayRequestId !== latestFetchRequestId) {
        set({ isMutating: false })
        return refreshedAgent
      }
      const contextCwd = normalizeAgentCwd(input.cwd)
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
        const contextCwd = normalizeAgentCwd(input.cwd)
        set((state) => ({
          ...upsertMutationAgent(state, createdAgent),
          selectedAgent: createdAgent,
          selectedAgentReturnTab: 'agents',
          isMutating: false,
          requestedCwd: contextCwd,
          resolvedCwd: contextCwd,
          isContextStale: false,
          mutationWarning: combineWarnings(
            getErrorMessage(
              refreshError,
              'Failed to refresh agents after creating the agent',
            ),
            state.mutationWarning,
          ),
        }))
      }
      return createdAgent
    }
  },

  updateAgent: async (name, input, sessionId) => {
    const requestId = ++latestMutationRequestId
    const displayRequestId = ++latestFetchRequestId
    set({
      isMutating: true,
      mutationError: null,
      mutationWarning: null,
      isLoading: false,
    })
    let updatedAgent: AgentDefinition
    try {
      const mutationResponse = await agentsApi.update(name, input)
      updatedAgent = mutationResponse.agent
    } catch (error) {
      if (requestId === latestMutationRequestId) {
        const message = getErrorMessage(error, 'Failed to update agent')
        set({
          isMutating: false,
          ...(displayRequestId === latestFetchRequestId ? { mutationError: message } : {}),
        })
      }
      throw error
    }

    startSessionReloadWarning(sessionId, requestId, displayRequestId, set)
    try {
      const response = await agentsApi.list(input.cwd)
      const refreshedAgent = findEditableAgent(
        response.allAgents,
        input.name,
        input.scope,
        updatedAgent.target ?? input.target,
      )
      if (!refreshedAgent) {
        throw new Error('Updated agent was not returned by the refreshed list')
      }
      if (requestId !== latestMutationRequestId) return refreshedAgent
      if (displayRequestId !== latestFetchRequestId) {
        set({ isMutating: false })
        return refreshedAgent
      }
      const contextCwd = normalizeAgentCwd(input.cwd)
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
        const contextCwd = normalizeAgentCwd(input.cwd)
        set((state) => ({
          ...upsertMutationAgent(state, updatedAgent),
          selectedAgent: updatedAgent,
          selectedAgentReturnTab: 'agents',
          isMutating: false,
          requestedCwd: contextCwd,
          resolvedCwd: contextCwd,
          isContextStale: false,
          mutationWarning: combineWarnings(
            getErrorMessage(
              refreshError,
              'Failed to refresh agents after updating the agent',
            ),
            state.mutationWarning,
          ),
        }))
      }
      return updatedAgent
    }
  },

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
  setState: typeof useAgentStore.setState,
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
    if (session.errors > 0) {
      return `The active CLI session reloaded with ${session.errors} agent loading error${session.errors === 1 ? '' : 's'}.`
    }
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
