import { afterEach, describe, expect, test } from 'bun:test'
import { buildInheritedEnvVars } from './spawnUtils.js'

const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL
const originalEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL
const originalOpenAIEffort = process.env.CC_HAHA_OPENAI_REASONING_EFFORT
const forwardedRuntimeKeys = [
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CC_HAHA_SEND_DISABLED_THINKING',
  'DISABLE_INTERLEAVED_THINKING',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
] as const
const originalForwardedRuntimeEnv = new Map(
  forwardedRuntimeKeys.map(key => [key, process.env[key]]),
)

afterEach(() => {
  restoreEnv('CLAUDE_CODE_SUBAGENT_MODEL', originalSubagentModel)
  restoreEnv('CLAUDE_CODE_EFFORT_LEVEL', originalEffort)
  restoreEnv('CC_HAHA_OPENAI_REASONING_EFFORT', originalOpenAIEffort)
  for (const key of forwardedRuntimeKeys) {
    restoreEnv(key, originalForwardedRuntimeEnv.get(key))
  }
})

describe('buildInheritedEnvVars', () => {
  test('forwards global subagent model and effort with shell-safe quoting', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'provider model'
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'xhigh'

    const inherited = buildInheritedEnvVars()

    expect(inherited).toContain(
      "CLAUDE_CODE_SUBAGENT_MODEL='provider model'",
    )
    expect(inherited).toContain('CLAUDE_CODE_EFFORT_LEVEL=xhigh')
  })

  test('does not forward empty global subagent overrides', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = ''
    process.env.CLAUDE_CODE_EFFORT_LEVEL = ''

    const inherited = buildInheritedEnvVars()

    expect(inherited).not.toContain('CLAUDE_CODE_SUBAGENT_MODEL=')
    expect(inherited).not.toContain('CLAUDE_CODE_EFFORT_LEVEL=')
  })

  test('forwards the Desktop OpenAI session effort to tmux teammates', () => {
    process.env.CC_HAHA_OPENAI_REASONING_EFFORT = 'max'

    expect(buildInheritedEnvVars()).toContain(
      'CC_HAHA_OPENAI_REASONING_EFFORT=max',
    )
  })

  test('forwards thinking controls and provider model capabilities', () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    process.env.CLAUDE_CODE_DISABLE_THINKING = '1'
    process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1'
    process.env.CC_HAHA_SEND_DISABLED_THINKING = '1'
    process.env.DISABLE_INTERLEAVED_THINKING = '1'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'provider-fable'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,required_thinking,effort,xhigh_effort,max_effort'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'provider-sonnet'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort'

    const inherited = buildInheritedEnvVars()

    for (const key of forwardedRuntimeKeys) {
      expect(inherited).toContain(`${key}=`)
    }
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
