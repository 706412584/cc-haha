import type {
  ComputerUsePermissionRequest,
  ComputerUsePermissionResponse,
} from '../types/chat'

const DEFAULT_GRANT_FLAGS = {
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
} as const

export function buildComputerUseAllowResponse(
  request: ComputerUsePermissionRequest,
): ComputerUsePermissionResponse {
  const now = Date.now()
  const granted = request.apps.flatMap((app) => {
    if (!app.resolved || app.alreadyGranted) return []
    return [{
      bundleId: app.resolved.bundleId,
      displayName: app.resolved.displayName,
      grantedAt: now,
      tier: app.proposedTier,
    }]
  })

  const denied = request.apps.flatMap((app) => {
    if (app.resolved) return []
    return [{
      bundleId: app.requestedName,
      reason: 'not_installed' as const,
    }]
  })

  return {
    granted,
    denied,
    flags: {
      ...DEFAULT_GRANT_FLAGS,
      ...Object.fromEntries(
        Object.entries(request.requestedFlags).filter(([, value]) => value === true),
      ),
    },
    userConsented: true,
  }
}
