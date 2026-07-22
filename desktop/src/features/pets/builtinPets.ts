import dadaImage from '../../assets/agent-mascots/agent-mascot-code.png'
import huhuImage from '../../assets/agent-mascots/agent-mascot-plan.png'
import bubuImage from '../../assets/agent-mascots/agent-mascot-fix.png'
import huihuiImage from '../../assets/agent-mascots/agent-mascot-build.png'
import dadaSpritesheet from '../../assets/pets/dada-code/spritesheet.webp'
import huhuSpritesheet from '../../assets/pets/huhu-plan/spritesheet.webp'
import bubuSpritesheet from '../../assets/pets/bubu-fix/spritesheet.webp'
import huihuiSpritesheet from '../../assets/pets/huihui-build/spritesheet.webp'
import type { BuiltinPet } from './types'

export const BUILTIN_PETS = [
  {
    source: 'builtin',
    id: 'dada-code',
    displayName: '搭搭 Dada',
    description: '沉稳的协作机器人，陪你把想法一块块搭起来。',
    descriptionKey: 'settings.pets.builtin.dada',
    imageUrl: dadaImage,
    spriteVersionNumber: 2,
    spritesheetUrl: dadaSpritesheet,
    accent: '#4fd1b6',
  },
  {
    source: 'builtin',
    id: 'huhu-plan',
    displayName: '弧弧 Huhu',
    description: '拿着铅笔和计划本的路线机器人，复杂任务也能找到出口。',
    descriptionKey: 'settings.pets.builtin.huhu',
    imageUrl: huhuImage,
    spriteVersionNumber: 2,
    spritesheetUrl: huhuSpritesheet,
    accent: '#6ea8ff',
  },
  {
    source: 'builtin',
    id: 'bubu-fix',
    displayName: '补补 Bubu',
    description: '举着修补扳手的小机器人，最擅长发现并修好裂缝。',
    descriptionKey: 'settings.pets.builtin.bubu',
    imageUrl: bubuImage,
    spriteVersionNumber: 2,
    spritesheetUrl: bubuSpritesheet,
    accent: '#ff9a76',
  },
  {
    source: 'builtin',
    id: 'huihui-build',
    displayName: '回回 Huihui',
    description: '抱着构建齿轮的小机器人，新回复一到就精神满满。',
    descriptionKey: 'settings.pets.builtin.huihui',
    imageUrl: huihuiImage,
    spriteVersionNumber: 2,
    spritesheetUrl: huihuiSpritesheet,
    accent: '#9b8cff',
  },
] as const satisfies readonly BuiltinPet[]

export function findBuiltinPet(id: string): BuiltinPet {
  return BUILTIN_PETS.find((pet) => pet.id === id) ?? BUILTIN_PETS[0]
}
