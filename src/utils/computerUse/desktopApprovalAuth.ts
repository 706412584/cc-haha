let desktopApprovalToken: string | null = null

export function installDesktopApprovalToken(token: string): void {
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Desktop Computer Use approval token must be 256-bit lowercase hex')
  }
  if (desktopApprovalToken && desktopApprovalToken !== token) {
    throw new Error('Desktop Computer Use approval token is already installed')
  }
  desktopApprovalToken = token
}

export function getDesktopApprovalToken(): string | null {
  return desktopApprovalToken
}

export function buildDesktopApprovalHeaders(): { Authorization: string } {
  if (!desktopApprovalToken) {
    throw new Error('Desktop Computer Use approval token is not initialized')
  }
  return { Authorization: `Bearer ${desktopApprovalToken}` }
}

export function resetDesktopApprovalTokenForTests(): void {
  desktopApprovalToken = null
}
