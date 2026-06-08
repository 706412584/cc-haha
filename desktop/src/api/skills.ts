import { api } from './client'
import type { SkillMeta, SkillDetail, CatalogSkill } from '../types/skill'

export const skillsApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ skills: SkillMeta[] }>(`/api/skills${query}`, { timeout: 120_000 })
  },

  detail: (source: string, name: string, cwd?: string) => {
    const query = new URLSearchParams({
      source,
      name,
    })
    if (cwd) query.set('cwd', cwd)

    return api.get<{ detail: SkillDetail }>(
      `/api/skills/detail?${query.toString()}`,
      { timeout: 120_000 },
    )
  },

  catalog: () => api.get<{ catalog: CatalogSkill[] }>(`/api/skills/catalog`),

  install: (name: string) =>
    api.post<{ ok: true; installed?: boolean; alreadyInstalled?: boolean }>(
      `/api/skills/install`,
      { name },
    ),
}
