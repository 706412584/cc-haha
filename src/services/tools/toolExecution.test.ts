import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { Tool, ToolUseContext } from '../../Tool.js'

const childScenario = process.env.CC_HAHA_TOOL_INPUT_GUARD_SCENARIO

// Importing the executor loads the full tools/permissions/MCP graph. Isolate
// those caches from shared-process suites that install their own module mocks.
async function runScenario(root: string, source: string) {
  ;(globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }).MACRO = { BUILD_TIME: '' }
  const { z } = await import('zod/v4')
  const bootstrap = await import('../../bootstrap/state.js')
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)
  const { createAssistantMessage, normalizeContentFromAPI } = await import('../../utils/messages.js')
  const { createUnparsedToolInput } = await import('../../utils/unparsedToolInput.js')
  const { runToolUse } = await import('./toolExecution.js')
  const raw = '{"path":' + 'x'.repeat(3000)
  const marker = createUnparsedToolInput(raw)
  const normalized = normalizeContentFromAPI([{ type: 'tool_use', id: 'bad-call', name: 'OptionalTool', input: raw }], [])[0]!
  if (normalized.type !== 'tool_use') throw new Error('Expected tool use')
  const input = source === 'provider' ? normalized.input : JSON.parse(JSON.stringify(marker))
  const inputSchema = z.object({ optional: z.string().optional() })
  expect(inputSchema.safeParse({}).success).toBe(true)
  const safeParse = mock(inputSchema.safeParse.bind(inputSchema))
  inputSchema.safeParse = safeParse
  const call = mock(async () => ({ data: 'must not run' }))
  const validateInput = mock(async () => ({ result: true }))
  const tool = { name: 'OptionalTool', inputSchema, call, validateInput } as unknown as Tool
  const canUseTool = mock(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
  const toolUse = { type: 'tool_use' as const, id: 'bad-call', name: tool.name, input }
  const assistant = createAssistantMessage({ content: [toolUse] })
  const context = { options: { tools: [tool], mcpClients: [] }, abortController: new AbortController(), messages: [] } as unknown as ToolUseContext
  const updates = []
  for await (const update of runToolUse(toolUse, assistant, canUseTool, context)) updates.push(update)
  expect(updates).toHaveLength(1)
  const message = updates[0]!.message
  expect(message.type).toBe('user')
  if (message.type !== 'user') throw new Error('Expected tool error result')
  expect(message.message.content).toEqual([{
    type: 'tool_result', tool_use_id: 'bad-call', is_error: true,
    content: expect.stringContaining('InputValidationError: OptionalTool was called with input that could not be parsed as JSON.'),
  }])
  const content = JSON.stringify(message.message.content)
  expect(content).toContain('Retry with valid JSON')
  expect(content).toContain(`first 200 of ${raw.length} bytes`)
  expect(content).not.toContain('x'.repeat(201))
  expect(message.toolUseResult).toBe(`InputValidationError: JSON parse failed (${raw.length} bytes)`)
  expect(safeParse).not.toHaveBeenCalled()
  expect(validateInput).not.toHaveBeenCalled()
  expect(canUseTool).not.toHaveBeenCalled()
  expect(call).not.toHaveBeenCalled()

}

for (const scenario of ['provider', 'history']) {
  if (childScenario && childScenario !== scenario) continue
  test(`rejects ${scenario} markers before permissive schema, permission checks or tool side effects`, async () => {
    if (childScenario) {
      await runScenario(process.env.HOME!, scenario)
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'tool-input-guard-'))
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], {
      cwd: root,
      env: createSandboxedTestEnvironment(root, {
        CC_HAHA_TOOL_INPUT_GUARD_SCENARIO: scenario,
        NODE_ENV: 'production',
        CLAUDE_CODE_SIMPLE: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_API_KEY: 'offline-fixture-key',
      }),
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(exitCode, stdout + stderr).toBe(0)
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
}
