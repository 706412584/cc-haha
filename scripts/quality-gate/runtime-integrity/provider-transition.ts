import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from '../../../src/server/services/sessionService.js'
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
  const before = await readFile(sourceInfo.filePath)
  const target: RuntimeOverride = { providerId: 'provider-b', modelId: 'model-b' }
  const classification = classifyRuntimeTransition({
    transcriptMessageCount: 1,
    persistedProviderId: 'provider-a',
    currentProviderId: 'provider-a',
    target,
  })
  if (classification.kind !== 'provider-transition') {
    throw new Error('cross-provider history did not require a transition')
  }

  const transitionId = randomUUID()
  const input = {
    sourceSessionId: source.sessionId,
    transitionId,
    selectionHash: createHash('sha256').update(JSON.stringify(target)).digest('hex'),
    runtimeProviderId: target.providerId,
    runtimeModelId: target.modelId,
  }
  const created = await service.createProviderTransitionSession(input)
  const retried = await new SessionService().createProviderTransitionSession(input)
  const targetInfo = await service.getSessionLaunchInfo(transitionId)
  const after = await readFile(sourceInfo.filePath)
  if (!before.equals(after)) throw new Error('source transcript changed')
  if (targetInfo?.transcriptMessageCount !== 0) throw new Error('target is not empty')
  if (!created.created || retried.created) throw new Error('idempotency contract failed')

  console.log(JSON.stringify({
    passed: true,
    sourceSessionId: source.sessionId,
    targetSessionId: transitionId,
    sourceSha256: createHash('sha256').update(after).digest('hex'),
    targetMessageCount: targetInfo.transcriptMessageCount,
    retryReturnedSameSession: retried.sessionId === transitionId,
  }, null, 2))
} finally {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
}
