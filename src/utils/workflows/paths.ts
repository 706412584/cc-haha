import { randomBytes } from 'crypto'
import { join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getProjectDir } from '../sessionStorage.js'

/** `~/.claude/workflows` — personal workflows, available in every project. */
export function getUserWorkflowsDir(): string {
  return join(getClaudeConfigHomeDir(), 'workflows')
}

/**
 * A fresh run id. Shaped `wf_<8 hex>-<3 hex>` so it is short enough to read in
 * the progress view and still collision-free within a session.
 */
export function createWorkflowRunId(): string {
  const bytes = randomBytes(6).toString('hex')
  return `wf_${bytes.slice(0, 8)}-${bytes.slice(8, 11)}`
}

/** Subdirectory (relative to `subagents/`) holding this run's agent transcripts. */
export function getWorkflowTranscriptSubdir(runId: string): string {
  return join('workflows', runId)
}

/**
 * Absolute directory for a run's artifacts: the resume journal plus one
 * `agent-<id>.jsonl` transcript per subagent. Lives beside the session's other
 * subagent transcripts so existing transcript tooling can read it unchanged.
 */
export function getWorkflowTranscriptDir(runId: string): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(
    projectDir,
    getSessionId(),
    'subagents',
    getWorkflowTranscriptSubdir(runId),
  )
}

/** Where the executed script is persisted so a run can be read back or edited. */
export function getWorkflowScriptPath(runId: string, name: string): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'workflow'
  return join(projectDir, getSessionId(), 'workflows', `${safeName}.${runId}.js`)
}

export function getWorkflowJournalPath(runId: string): string {
  return join(getWorkflowTranscriptDir(runId), 'journal.jsonl')
}
