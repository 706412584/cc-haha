import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'query-session-message-'))
const originalEnv = { ...process.env }
const previousMacro = (globalThis as any).MACRO
;(globalThis as any).MACRO = { VERSION: 'fixture', BUILD_TIME: 'fixture' }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(home, { CLAUDE_CODE_SIMPLE: '1', DISABLE_TELEMETRY: '1' }, originalEnv))
const originals = {
  query: { ...await import('./query.js') },
  input: { ...await import('./utils/processUserInput/processUserInput.js') },
  storage: { ...await import('./utils/sessionStorage.js') },
  context: { ...await import('./utils/queryContext.js') },
}
let inputOptions: any
let queryOptions: any
let mcpCalls = 0
let skillCalls = 0
let missingMcp = false
let skillName = 'review'
const originalCommands = { ...await import('./commands.js') }
const originalRunAgent = { ...await import('./tools/AgentTool/runAgent.js') }
mock.module('./commands.js', () => ({ ...originalCommands, getSkillToolCommands: async () => [{ type: 'prompt', name: 'plugin:review', model: 'must-not-override', getPromptForCommand: async () => { skillCalls++; return [{ type: 'text', text: 'Frozen skill reference loaded' }] } }] }))
mock.module('./tools/AgentTool/runAgent.js', () => ({ ...originalRunAgent, initializeAgentMcpServers: async (_agent: any, clients: any[]) => { mcpCalls++; return { clients: missingMcp ? clients : [...clients, { name: 'fixture', type: 'connected' }], tools: [], cleanup: async () => {} } } }))
mock.module('./utils/queryContext.js', () => ({ ...originals.context, fetchSystemPromptParts: async () => ({ defaultSystemPrompt: [], userContext: { claudeMd: 'private project instructions', other: 'preserve' }, systemContext: {} }) }))
mock.module('./utils/processUserInput/processUserInput.js', () => ({ ...originals.input, processUserInput: async (options: any) => {
  inputOptions = options
  return { messages: [{ type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: options.input } }], shouldQuery: true, allowedTools: [] }
} }))
mock.module('./utils/sessionStorage.js', () => ({ ...originals.storage, recordTranscript: async () => {}, flushSessionStorage: async () => {} }))
mock.module('./query.js', () => ({ ...originals.query, query: async function* (options: any) { queryOptions = options; throw new Error('fixture boundary') } }))
const { QueryEngine } = await import('./QueryEngine.js')
const { getDefaultAppState } = await import('./state/AppStateStore.js')

function engine() {
  let state = getDefaultAppState()
  state.agent = 'worker'
  const agent = { agentType: 'worker', source: 'flagSettings', whenToUse: 'fixture', getSystemPrompt: () => 'preset', skills: [skillName], mcpServers: ['fixture'], hooks: { Stop: [{ hooks: [{ type: 'command', command: 'never execute fixture hook' }] }] } } as any
  const config = { cwd: home, tools: [], commands: [], mcpClients: [], agents: [agent], readFileCache: new Map() as any,
    customSystemPrompt: 'fixture', userSpecifiedModel: 'claude-sonnet-4-5', thinkingConfig: { type: 'disabled' },
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => state, setAppState: (update: (value: typeof state) => typeof state) => { state = update(state) },
  }
  const instance = new QueryEngine(config as any)
  return { instance, state: () => state, nextEngine: () => new QueryEngine(config as any) }
}
beforeEach(() => { inputOptions = undefined; queryOptions = undefined; mcpCalls = 0; skillCalls = 0; missingMcp = false; skillName = 'review'
  process.env.CC_HAHA_TEAM_WORKER = '1'
  process.env.CC_HAHA_TEAM_WORKER_OMIT_CLAUDE_MD = '1'
  process.env.CC_HAHA_TEAM_WORKER_PRESET_TYPE = 'plugin:reviewer'
  process.env.CC_HAHA_TEAM_WORKER_PRESET_SOURCE = 'plugin'
})
afterAll(() => {
  mock.module('./query.js', () => originals.query)
  mock.module('./commands.js', () => originalCommands)
  mock.module('./tools/AgentTool/runAgent.js', () => originalRunAgent)
  mock.module('./utils/processUserInput/processUserInput.js', () => originals.input)
  mock.module('./utils/sessionStorage.js', () => originals.storage)
  mock.module('./utils/queryContext.js', () => originals.context)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (previousMacro === undefined) delete (globalThis as any).MACRO
  else (globalThis as any).MACRO = previousMacro
  rmSync(home, { recursive: true, force: true })
})
async function submit(instance: InstanceType<typeof QueryEngine>) {
  try { for await (const _message of instance.submitMessage('released task')) {} } catch (error) { expect(String(error)).toContain('fixture boundary') }
}
test('approved worker initializes preset only on first released headless task and preserves human model', async () => {
  const worker = engine()
  expect(mcpCalls).toBe(0)
  expect(skillCalls).toBe(0)
  expect(worker.state().sessionHooks.size).toBe(0)
  await submit(worker.instance)
  expect(mcpCalls).toBe(1)
  expect(skillCalls).toBe(1)
  expect(inputOptions.messages[0].message.content).toEqual([{ type: 'text', text: 'Frozen skill reference loaded' }])
  expect(queryOptions.userContext).toEqual({ other: 'preserve' })
  expect(inputOptions.context.options.mainLoopModel).toBe('claude-sonnet-4-5')
  const hooks = [...worker.state().sessionHooks.values()][0]?.hooks
  expect(hooks?.Stop).toHaveLength(1)
  expect(hooks?.SubagentStop).toBeUndefined()
  await submit(worker.nextEngine())
  expect(mcpCalls).toBe(1)
  expect(skillCalls).toBe(1)
})
// Regression: a worker's approved preset arrives as a custom system prompt, so
// the default prompt's memory section never runs for it. Without the shared
// team-memory section the members could never accumulate project knowledge.
// This suite runs under --bare (CLAUDE_CODE_SIMPLE), which correctly disables
// memory, so the flag is cleared for this test to model a real worker session
// (with a stub key, since --bare is also what skips the auth check).
test('a released worker gets the shared team-memory section appended to its preset', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  process.env.ANTHROPIC_API_KEY = 'fixture-key'
  try {
    await submit(engine().instance)
    const prompt = queryOptions.systemPrompt.join('\n')
    expect(prompt).toContain('fixture')
    expect(prompt).toContain('Shared team memory')
    expect(prompt).toContain('shared by every member of this team')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_SIMPLE = '1'
  }
})
test('ordinary headless agents retain project context and do not activate worker presets', async () => {
  delete process.env.CC_HAHA_TEAM_WORKER
  const normal = engine()
  await submit(normal.instance)
  expect(mcpCalls).toBe(0)
  expect(skillCalls).toBe(0)
  expect(queryOptions.userContext.claudeMd).toBe('private project instructions')
  expect(normal.state().sessionHooks.size).toBe(0)
  expect(queryOptions.systemPrompt.join('\n')).not.toContain('Shared team memory')
})

test('missing MCP or skill fails the released task before reaching the model', async () => {
  missingMcp = true
  await expect(engine().instance.submitMessage('released').next()).rejects.toThrow('MCP server unavailable: fixture')
  expect(queryOptions).toBeUndefined()
  expect(skillCalls).toBe(0)
  missingMcp = false
  skillName = 'missing'
  const worker = engine()
  await expect(worker.instance.submitMessage('released').next()).rejects.toThrow('skill unavailable: missing')
  expect(queryOptions).toBeUndefined()
  expect(worker.state().sessionHooks.size).toBe(0)
})
test('workers retain project instructions unless their approved preset opts out', async () => {
  process.env.CC_HAHA_TEAM_WORKER_OMIT_CLAUDE_MD = '0'
  await submit(engine().instance)
  expect(queryOptions.userContext.claudeMd).toBe('private project instructions')
})
