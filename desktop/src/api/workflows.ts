import { api } from './client'
import type {
  ReconstructedWorkflowRun,
  WorkflowDefinition,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from '../types/workflow'

export type WorkflowValidateResult = {
  ok: boolean
  error?: string
  name?: string
  description?: string
  phases?: { title: string; detail?: string; model?: string }[]
}

export const workflowsApi = {
  list(cwd?: string) {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ workflows: WorkflowDefinition[] }>(`/api/workflows${query}`)
  },

  get(name: string, cwd?: string) {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<WorkflowDefinition>(
      `/api/workflows/${encodeURIComponent(name)}${query}`,
    )
  },

  /** Finished runs for one session, rebuilt from what the CLI left on disk. */
  sessionRuns(sessionId: string) {
    return api.get<{ runs: ReconstructedWorkflowRun[] }>(
      `/api/workflows/session-runs/${encodeURIComponent(sessionId)}`,
    )
  },

  listRuns(options?: { sessionId?: string; limit?: number }) {
    const params = new URLSearchParams()
    if (options?.sessionId) params.set('sessionId', options.sessionId)
    if (options?.limit) params.set('limit', String(options.limit))
    const query = params.toString()
    return api.get<{ runs: WorkflowRunSummary[] }>(
      `/api/workflows/runs${query ? `?${query}` : ''}`,
    )
  },

  getRun(sessionId: string, runId: string) {
    return api.get<WorkflowRunDetail>(
      `/api/workflows/runs/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}`,
    )
  },

  validate(script: string) {
    return api.post<WorkflowValidateResult>('/api/workflows/validate', { script })
  },

  save(
    script: string,
    scope: 'user' | 'project',
    cwd?: string,
    name?: string,
  ) {
    return api.post<{ ok: true; name: string; filePath: string }>(
      '/api/workflows/save',
      { script, scope, cwd, name },
    )
  },

  remove(name: string, scope: 'user' | 'project', cwd?: string) {
    const params = new URLSearchParams({ scope })
    if (cwd) params.set('cwd', cwd)
    return api.delete<{ ok: true }>(
      `/api/workflows/${encodeURIComponent(name)}?${params.toString()}`,
    )
  },
}
