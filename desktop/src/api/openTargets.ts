import { api } from './client'

export type OpenTargetKind = 'application' | 'system_default' | 'ide' | 'file_manager'

export type OpenTarget = {
  id: string
  kind: OpenTargetKind
  label: string
  icon: string
  /** Server-relative path. Load it through {@link loadTargetIconUrl}, not an `<img src>`. */
  iconUrl?: string
  platform: string
  appPath?: string
  bundleId?: string | null
  isDefault?: boolean
}

export type OpenTargetList = {
  platform: string
  targets: OpenTarget[]
  primaryTargetId: string | null
  cachedAt: number
  ttlMs: number
}

export type OpenTargetOpenResponse = {
  ok: true
  targetId: string
  path: string
}

export const openTargetsApi = {
  async list() {
    return api.get<OpenTargetList>('/api/open-targets')
  },
  async listForPath(path: string) {
    return api.get<OpenTargetList>(`/api/open-targets?path=${encodeURIComponent(path)}`)
  },
  open(targetId: string, path: string) {
    return api.post<OpenTargetOpenResponse>('/api/open-targets/open', { targetId, path })
  },
}
