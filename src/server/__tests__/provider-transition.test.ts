import { describe, expect, test } from 'bun:test'
import {
  classifyRuntimeTransition,
  type RuntimeOverride,
} from '../ws/handler.js'
import { SessionActivityCoordinator } from '../services/sessionActivityCoordinator.js'
import {
  assertProviderResumeCompatible,
  ConversationStartupError,
} from '../services/conversationService.js'
import { SessionService } from '../services/sessionService.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'

const target: RuntimeOverride = {
  providerId: 'provider-b',
  modelId: 'model-b',
}

describe('provider runtime transition classification', () => {
  test('applies any valid selection to an empty transcript', () => {
    expect(classifyRuntimeTransition({
      transcriptMessageCount: 0,
      persistedProviderId: 'provider-a',
      currentProviderId: 'provider-a',
      target,
    })).toEqual({ kind: 'apply' })
  })

  test('applies model changes within the persisted provider', () => {
    expect(classifyRuntimeTransition({
      transcriptMessageCount: 4,
      persistedProviderId: 'provider-b',
      currentProviderId: 'provider-b',
      target,
    })).toEqual({ kind: 'apply' })
  })

  test('requires a new session before changing a known historical provider', () => {
    expect(classifyRuntimeTransition({
      transcriptMessageCount: 4,
      persistedProviderId: 'provider-a',
      currentProviderId: 'provider-a',
      target,
    })).toEqual({ kind: 'provider-transition', sourceProviderId: 'provider-a' })
  })

  test('allows legacy history only when the current provider identity is unchanged', () => {
    expect(classifyRuntimeTransition({
      transcriptMessageCount: 4,
      persistedProviderId: undefined,
      currentProviderId: 'provider-b',
      target,
    })).toEqual({ kind: 'apply' })

    expect(classifyRuntimeTransition({
      transcriptMessageCount: 4,
      persistedProviderId: undefined,
      currentProviderId: 'provider-a',
      target,
    })).toEqual({ kind: 'provider-transition', sourceProviderId: null })
  })
})

describe('provider resume guard', () => {
  test('rejects a known historical provider mismatch before startup work', () => {
    expect(() => assertProviderResumeCompatible({
      sessionId: 'session-1',
      transcriptMessageCount: 2,
      persistedProviderId: 'provider-a',
      targetProviderId: 'provider-b',
    })).toThrow(ConversationStartupError)

    try {
      assertProviderResumeCompatible({
        sessionId: 'session-1',
        transcriptMessageCount: 2,
        persistedProviderId: 'provider-a',
        targetProviderId: 'provider-b',
      })
    } catch (error) {
      expect((error as ConversationStartupError).code).toBe('PROVIDER_RESUME_MISMATCH')
    }
  })

  test('allows legacy history without provider metadata', () => {
    expect(() => assertProviderResumeCompatible({
      sessionId: 'session-1',
      transcriptMessageCount: 2,
      persistedProviderId: undefined,
      targetProviderId: 'provider-b',
    })).not.toThrow()
  })
})

describe('provider transition session creation', () => {
  test('creates one empty idempotent target without changing the source transcript', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-transition-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-workdir-'))
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      const service = new SessionService()
      const source = await service.createSession(workDir)
      await service.appendSessionMetadata(source.sessionId, {
        workDir,
        runtimeProviderId: 'provider-a',
        runtimeModelId: 'model-a',
      })
      const originalSourceInfo = await service.getSessionLaunchInfo(source.sessionId)
      const legacyDir = path.join(path.dirname(path.dirname(originalSourceInfo!.filePath)), 'legacy-physical-bucket')
      await fs.mkdir(legacyDir, { recursive: true })
      const legacySourcePath = path.join(legacyDir, path.basename(originalSourceInfo!.filePath))
      await fs.rename(originalSourceInfo!.filePath, legacySourcePath)
      const sourceInfo = await new SessionService().getSessionLaunchInfo(source.sessionId)
      const sourceBefore = await fs.readFile(sourceInfo!.filePath)
      const transitionId = crypto.randomUUID()
      const input = {
        sourceSessionId: source.sessionId,
        transitionId,
        selectionHash: 'selection-hash',
        runtimeProviderId: 'provider-b',
        runtimeModelId: 'model-b',
        thinkingEnabled: true,
      }

      const results = await Promise.all([
        service.createProviderTransitionSession(input),
        new SessionService().createProviderTransitionSession(input),
      ])
      const targetInfo = await service.getSessionLaunchInfo(transitionId)

      expect(results).toContainEqual(expect.objectContaining({ sessionId: transitionId, created: true }))
      expect(results).toContainEqual(expect.objectContaining({ sessionId: transitionId, created: false }))
      expect(targetInfo?.transcriptMessageCount).toBe(0)
      expect(targetInfo?.runtimeProviderId).toBe('provider-b')
      expect(targetInfo?.thinkingEnabled).toBe(true)
      expect(path.dirname(targetInfo!.filePath)).toBe(path.dirname(sourceInfo!.filePath))
      const listedTarget = (await new SessionService().listSessions()).sessions.find(
        session => session.id === transitionId,
      )
      expect(listedTarget?.thinkingEnabled).toBe(true)
      expect(targetInfo?.providerTransition).toEqual({
        sourceSessionId: source.sessionId,
        selectionHash: 'selection-hash',
      })
      expect(await fs.readFile(sourceInfo!.filePath)).toEqual(sourceBefore)

      await expect(service.createProviderTransitionSession({
        ...input,
        selectionHash: 'different-hash',
      })).rejects.toMatchObject({ statusCode: 409 })
    } finally {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      await fs.rm(configDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })
})

describe('provider transition HTTP endpoint', () => {
  test('creates and retries the same target session', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-transition-api-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-api-workdir-'))
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      const source = await new SessionService().createSession(workDir)
      const transitionId = crypto.randomUUID()
      const url = new URL(`http://localhost/api/sessions/${source.sessionId}/provider-transition`)
      const body = {
        transitionId,
        targetSelection: {
          providerId: 'openai-official',
          modelId: 'gpt-5.6-sol',
          effortLevel: 'xhigh',
          thinkingEnabled: true,
        },
      }
      const request = () => new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const segments = ['api', 'sessions', source.sessionId, 'provider-transition']

      const created = await handleSessionsApi(request(), url, segments)
      const retried = await handleSessionsApi(request(), url, segments)

      expect(created.status).toBe(201)
      expect(retried.status).toBe(200)
      expect((await retried.json() as { sessionId: string }).sessionId).toBe(transitionId)
      const targetInfo = await new SessionService().getSessionLaunchInfo(transitionId)
      expect(targetInfo?.thinkingEnabled).toBe(true)
      expect(targetInfo?.effortLevel).toBe('xhigh')
    } finally {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      await fs.rm(configDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })
})

describe('session activity coordination', () => {
  test('prevents a user turn from starting inside a provider transition reservation', async () => {
    const coordinator = new SessionActivityCoordinator()

    await coordinator.withTransitionReservation('session-1', async () => {
      expect(coordinator.tryBeginUserTurn('session-1')).toBe(false)
    })

    expect(coordinator.tryBeginUserTurn('session-1')).toBe(true)
    coordinator.endUserTurn('session-1')
  })

  test('rejects a transition and a second owner when a user turn is active', async () => {
    const coordinator = new SessionActivityCoordinator()
    expect(coordinator.tryBeginUserTurn('session-1')).toBe(true)
    expect(coordinator.tryBeginUserTurn('session-1')).toBe(false)

    await expect(
      coordinator.withTransitionReservation('session-1', async () => undefined),
    ).rejects.toMatchObject({ code: 'SESSION_TURN_ACTIVE' })

    coordinator.endUserTurn('session-1')
    await expect(
      coordinator.withTransitionReservation('session-1', async () => undefined),
    ).resolves.toBeUndefined()
  })
})
