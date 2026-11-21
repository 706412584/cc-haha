import { api } from './client'
import type { SkillMeta, SkillDetail, CatalogSkill } from '../types/skill'
import type { SlashCommandOption } from '../types/slashCommand'

export const skillsApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ skills: SkillMeta[] }>(`/api/skills${query}`, { timeout: 120_000 })
  },

  commands: (cwd?: string, agentProfile?: 'lean') => {
    const query = new URLSearchParams()
    if (cwd) query.set('cwd', cwd)
    if (agentProfile) query.set('agentProfile', agentProfile)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return api.get<{ commands: SlashCommandOption[] }>(
      `/api/skills/commands${suffix}`,
      { timeout: 120_000 },
    )
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

  getActiveSkills: (scope: 'global' | 'project' | 'merged' = 'merged', cwd?: string) => {
    const query = new URLSearchParams({ scope })
    if (cwd) query.set('cwd', cwd)
    return api.get<{ activeSkills: string[] }>(`/api/skills/active?${query.toString()}`)
  },

  setActiveSkills: (skills: string[], scope: 'global' | 'project', cwd?: string) =>
    api.post<{ ok: true; scope: string; activeSkills: string[] }>(
      `/api/skills/active`,
      { scope, skills, cwd },
    ),
}
