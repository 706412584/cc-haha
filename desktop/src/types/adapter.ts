export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type PairingState = {
  code: string | null
  expiresAt: number | null
  createdAt: number | null
}

export type AdapterRuntimeStatus = {
  platform: 'wechat'
  state: 'starting' | 'connected' | 'rebind_required'
  code?: 'session_expired'
  generation: number
  updatedAt: string
}

export type AdapterRuntimeStatuses = Partial<Record<'wechat', AdapterRuntimeStatus>>

export type AdapterFileConfig = {
  serverUrl?: string
  defaultProjectDir?: string
  allowedProjectRoots?: string[]
  pairing?: PairingState
  telegram?: {
    botToken?: string
    allowedUsers?: number[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
  feishu?: {
    appId?: string
    appSecret?: string
    encryptKey?: string
    verificationToken?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
    streamingCard?: boolean
  }
  wechat?: {
    accountId?: string
    botToken?: string
    baseUrl?: string
    userId?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
  dingtalk?: {
    clientId?: string
    clientSecret?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
    endpoint?: string
    permissionCardTemplateId?: string
  }
  whatsapp?: {
    accountJid?: string
    authDir?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
}
