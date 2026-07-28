import type {
  CuAppPermTier,
  CuGrantFlags,
  CuPermissionResponse,
} from '../vendor/computer-use-mcp/types.js'

type ComputerUseAllowRequest = {
  apps: Array<{
    requestedName: string
    resolved?: { bundleId: string; displayName: string }
    alreadyGranted: boolean
    proposedTier: CuAppPermTier
  }>
  requestedFlags: Partial<CuGrantFlags>
}

export function buildComputerUseAllowResponse(
  request: ComputerUseAllowRequest,
): CuPermissionResponse {
  const grantedAt = Date.now()
  const granted = request.apps.flatMap((app) => {
    if (!app.resolved || app.alreadyGranted) return []
    return [{
      bundleId: app.resolved.bundleId,
      displayName: app.resolved.displayName,
      grantedAt,
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
      clipboardRead: request.requestedFlags.clipboardRead === true,
      clipboardWrite: request.requestedFlags.clipboardWrite === true,
      systemKeyCombos: request.requestedFlags.systemKeyCombos === true,
    },
    userConsented: true,
  }
}
