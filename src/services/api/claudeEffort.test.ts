import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EFFORT_BETA_HEADER } from '../../constants/betas.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { configureEffortParams } from './claude.js'

describe('configureEffortParams', () => {
  let originalBaseUrl: string | undefined
  let originalModel: string | undefined
  let originalModelCapabilities: string | undefined
  let originalSonnetModel: string | undefined
  let originalSonnetCapabilities: string | undefined
  let originalBedrock: string | undefined
  let originalVertex: string | undefined
  let originalFoundry: string | undefined
  let originalDisableExperimentalBetas: string | undefined

  beforeEach(() => {
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    originalModel = process.env.ANTHROPIC_MODEL
    originalModelCapabilities = process.env.ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES
    originalSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    originalSonnetCapabilities = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
    originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
    originalVertex = process.env.CLAUDE_CODE_USE_VERTEX
    originalFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY
    originalDisableExperimentalBetas = process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS

    process.env.ANTHROPIC_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5.2'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,max_effort'
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  })

  afterEach(() => {
    restoreEnv('ANTHROPIC_BASE_URL', originalBaseUrl)
    restoreEnv('ANTHROPIC_MODEL', originalModel)
    restoreEnv('ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES', originalModelCapabilities)
    restoreEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', originalSonnetModel)
    restoreEnv('ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES', originalSonnetCapabilities)
    restoreEnv('CLAUDE_CODE_USE_BEDROCK', originalBedrock)
    restoreEnv('CLAUDE_CODE_USE_VERTEX', originalVertex)
    restoreEnv('CLAUDE_CODE_USE_FOUNDRY', originalFoundry)
    restoreEnv('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', originalDisableExperimentalBetas)
  })

  test('sends explicit high effort for effort-capable third-party models when unset', () => {
    const outputConfig: Record<string, unknown> = {}
    const extraBodyParams: Record<string, unknown> = {}
    const betas: string[] = []

    configureEffortParams(
      undefined,
      outputConfig,
      extraBodyParams,
      betas,
      'glm-5.2',
    )

    expect(outputConfig).toEqual({ effort: 'high' })
    expect(extraBodyParams).toEqual({})
    expect(betas).toContain(EFFORT_BETA_HEADER)
  })

  test('sends max effort for the active third-party model when its capability opts in', () => {
    process.env.ANTHROPIC_MODEL = 'gpt-5.6-sol'
    process.env.ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,max_effort'

    const outputConfig: Record<string, unknown> = {}
    const extraBodyParams: Record<string, unknown> = {}
    const betas: string[] = []
    const effort = resolveAppliedEffort('gpt-5.6-sol', 'max')

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betas,
      'gpt-5.6-sol',
    )

    expect(effort).toBe('max')
    expect(outputConfig).toEqual({ effort: 'max' })
    expect(extraBodyParams).toEqual({})
    expect(betas).toContain(EFFORT_BETA_HEADER)
  })

  test('prefers active model capabilities when a tier uses the same model id', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5'
    process.env.ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,max_effort'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'none'

    expect(resolveAppliedEffort('claude-sonnet-5', 'max')).toBe('max')
  })

  test('does not send effort when provider capabilities do not opt in', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'thinking'

    const outputConfig: Record<string, unknown> = {}
    const extraBodyParams: Record<string, unknown> = {}
    const betas: string[] = []

    configureEffortParams(
      undefined,
      outputConfig,
      extraBodyParams,
      betas,
      'glm-5.2',
    )

    expect(outputConfig).toEqual({})
    expect(extraBodyParams).toEqual({})
    expect(betas).not.toContain(EFFORT_BETA_HEADER)
  })

  test('does not send effort output_config when direct providers disable experimental betas', () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'

    const outputConfig: Record<string, unknown> = {}
    const extraBodyParams: Record<string, unknown> = {}
    const betas: string[] = []

    configureEffortParams(
      'high',
      outputConfig,
      extraBodyParams,
      betas,
      'glm-5.2',
    )

    expect(outputConfig).toEqual({})
    expect(extraBodyParams).toEqual({})
    expect(betas).not.toContain(EFFORT_BETA_HEADER)
  })

  test('keeps effort output_config for local proxy providers so it can convert to reasoning_effort', () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456/proxy'

    const outputConfig: Record<string, unknown> = {}
    const extraBodyParams: Record<string, unknown> = {}
    const betas: string[] = []

    configureEffortParams(
      'medium',
      outputConfig,
      extraBodyParams,
      betas,
      'glm-5.2',
    )

    expect(outputConfig).toEqual({ effort: 'medium' })
    expect(extraBodyParams).toEqual({})
    expect(betas).toContain(EFFORT_BETA_HEADER)
  })

  test('keeps effort output_config for provider-specific local proxy routes', () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456/proxy/providers/provider-1'

    const outputConfig: Record<string, unknown> = {}
    const extraBodyParams: Record<string, unknown> = {}
    const betas: string[] = []

    configureEffortParams(
      'high',
      outputConfig,
      extraBodyParams,
      betas,
      'glm-5.2',
    )

    expect(outputConfig).toEqual({ effort: 'high' })
    expect(extraBodyParams).toEqual({})
    expect(betas).toContain(EFFORT_BETA_HEADER)
  })
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
