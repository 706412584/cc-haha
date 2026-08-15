import { getGlobalConfig, saveGlobalConfig } from '../config.js'

/**
 * Whether the user has already approved running workflows in auto mode.
 *
 * Auto mode means "stop asking me about routine things". Prompting on every
 * workflow launch there would defeat the mode, so the launch prompt appears
 * once and the answer is remembered for the machine.
 */
export function hasAcceptedWorkflowsInAutoMode(): boolean {
  try {
    return getGlobalConfig().hasAcceptedWorkflowsInAutoMode === true
  } catch {
    // Config access can be closed early in the process lifetime; a missing
    // consent record just means we ask.
    return false
  }
}

export function recordWorkflowAutoModeConsent(): void {
  try {
    if (getGlobalConfig().hasAcceptedWorkflowsInAutoMode === true) return
    saveGlobalConfig(config => ({
      ...config,
      hasAcceptedWorkflowsInAutoMode: true,
    }))
  } catch {
    // Failing to persist consent only costs one extra prompt next time.
  }
}
