import { create } from 'zustand'
import { skillsApi } from '../api/skills'
import type { SkillMeta, SkillDetail } from '../types/skill'

export type SkillDetailReturnTab = 'skills' | 'plugins'

type SkillStore = {
  skills: SkillMeta[]
  skillsContext: string | null
  selectedSkill: SkillDetail | null
  selectedSkillReturnTab: SkillDetailReturnTab
  selectedSkillContext: string | null
  isLoading: boolean
  isDetailLoading: boolean
  error: string | null

  fetchSkills: (cwd?: string) => Promise<void>
  fetchSkillDetail: (
    source: string,
    name: string,
    cwd?: string,
    returnTab?: SkillDetailReturnTab,
  ) => Promise<void>
  clearSelection: () => void
}

let latestListRequestId = 0
let latestDetailRequestId = 0

function contextKey(cwd?: string) {
  return cwd ?? ''
}

export const useSkillStore = create<SkillStore>((set) => ({
  skills: [],
  skillsContext: null,
  selectedSkill: null,
  selectedSkillReturnTab: 'skills',
  selectedSkillContext: null,
  isLoading: false,
  isDetailLoading: false,
  error: null,

  fetchSkills: async (cwd) => {
    const requestId = ++latestListRequestId
    const requestedContext = contextKey(cwd)
    set((state) => ({
      isLoading: true,
      error: null,
      ...(state.skillsContext !== null && state.skillsContext !== requestedContext
        ? { skills: [] }
        : {}),
    }))
    try {
      const { skills } = await skillsApi.list(cwd)
      if (requestId !== latestListRequestId) return
      set({ skills, skillsContext: requestedContext, isLoading: false })
    } catch (err) {
      if (requestId !== latestListRequestId) return
      set({
        error: err instanceof Error ? err.message : String(err),
        isLoading: false,
      })
    }
  },

  fetchSkillDetail: async (source, name, cwd, returnTab = 'skills') => {
    const requestId = ++latestDetailRequestId
    const requestedContext = contextKey(cwd)
    set({
      isDetailLoading: true,
      selectedSkillContext: requestedContext,
      error: null,
    })
    try {
      const { detail } = await skillsApi.detail(source, name, cwd)
      if (requestId !== latestDetailRequestId) return
      set({
        selectedSkill: detail,
        selectedSkillReturnTab: returnTab,
        selectedSkillContext: requestedContext,
        isDetailLoading: false,
      })
    } catch (err) {
      if (requestId !== latestDetailRequestId) return
      set({
        error: err instanceof Error ? err.message : String(err),
        isDetailLoading: false,
      })
    }
  },

  clearSelection: () => {
    latestDetailRequestId += 1
    set({
      selectedSkill: null,
      selectedSkillReturnTab: 'skills',
      selectedSkillContext: null,
      isDetailLoading: false,
    })
  },
}))
