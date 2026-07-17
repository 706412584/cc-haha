export type OrchestrationExecution =
  | 'main'
  | 'background-agent'
  | 'foreground-agent'

export type OrchestrationMetadata = {
  schemaVersion: 1
  fileScope: string[]
  wave: number
  execution: OrchestrationExecution
  verification: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeRepoRelativePath(value: string): string | null {
  if (value.trim() !== value || value.length === 0) return null
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) return null

  const slashNormalized = value.replace(/\\/g, '/')
  const normalizedParts: string[] = []
  for (const part of slashNormalized.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (normalizedParts.length === 0) return null
      normalizedParts.pop()
      continue
    }
    normalizedParts.push(part)
  }
  const normalized = normalizedParts.join('/')

  if (
    normalized === '.' ||
    normalized === '' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.startsWith('/')
  ) {
    return null
  }

  return normalized
}

export function parseOrchestrationMetadata(
  metadata: unknown,
): OrchestrationMetadata | null {
  if (!isRecord(metadata)) return null

  const orchestration = metadata.orchestration
  if (!isRecord(orchestration)) return null

  const allowedKeys = new Set([
    'schemaVersion',
    'fileScope',
    'wave',
    'execution',
    'verification',
  ])
  if (Object.keys(orchestration).some(key => !allowedKeys.has(key))) {
    return null
  }

  const { schemaVersion, fileScope, wave, execution, verification } = orchestration

  if (schemaVersion !== 1) return null
  if (!Array.isArray(fileScope) || fileScope.length === 0) return null
  if (typeof wave !== 'number' || !Number.isInteger(wave) || wave < 1) return null
  if (
    execution !== 'main' &&
    execution !== 'background-agent' &&
    execution !== 'foreground-agent'
  ) {
    return null
  }
  if (typeof verification !== 'string' || verification.trim().length === 0) {
    return null
  }

  const normalizedFileScope: string[] = []
  for (const entry of fileScope) {
    if (typeof entry !== 'string') return null
    const normalized = normalizeRepoRelativePath(entry)
    if (normalized === null) return null
    if (!normalizedFileScope.includes(normalized)) {
      normalizedFileScope.push(normalized)
    }
  }

  return {
    schemaVersion,
    fileScope: normalizedFileScope,
    wave,
    execution,
    verification,
  }
}
