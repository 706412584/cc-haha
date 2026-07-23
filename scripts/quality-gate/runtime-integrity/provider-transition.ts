import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from '../../../src/server/services/sessionService.js'
import {
  assertProviderResumeCompatible,
} from '../../../src/server/services/conversationService.js'
import {
  classifyRuntimeTransition,
  type RuntimeOverride,
} from '../../../src/server/ws/handler.js'

const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-provider-smoke-config-'))
const workDir = await mkdtemp(join(tmpdir(), 'cc-haha-provider-smoke-work-'))
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
  const sourceInfo = await service.getSessionLaunchInfo(source.sessionId)
  if (!sourceInfo) throw new Error('source launch info missing')

  const target: RuntimeOverride = { providerId: 'provider-b', modelId: 'model-b' }
  const classification = classifyRuntimeTransition({
    transcriptMessageCount: 1,
    persistedProviderId: 'provider-a',
    currentProviderId: 'provider-a',
    target,
  })
  if (classification.kind !== 'apply') {
    throw new Error('cross-provider history must apply in-session, not force a blank transition')
  }

  assertProviderResumeCompatible({
    sessionId: source.sessionId,
    transcriptMessageCount: 1,
    persistedProviderId: 'provider-a',
    targetProviderId: 'provider-b',
  })

  // Same-provider model switch must also stay in-session.
  const sameProvider = classifyRuntimeTransition({
    transcriptMessageCount: 3,
    persistedProviderId: 'provider-b',
    currentProviderId: 'provider-b',
    target: { providerId: 'provider-b', modelId: 'model-c' },
  })
  if (sameProvider.kind !== 'apply') {
    throw new Error('same-provider model switch must apply in-session')
  }

  console.log(JSON.stringify({
    passed: true,
    sourceSessionId: source.sessionId,
    crossProviderKind: classification.kind,
    sameProviderKind: sameProvider.kind,
    sourceSha256: createHash('sha256')
      .update(JSON.stringify({
        sessionId: source.sessionId,
        workDir: sourceInfo.workDir,
      }))
      .digest('hex'),
  }, null, 2))
} finally {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
}
