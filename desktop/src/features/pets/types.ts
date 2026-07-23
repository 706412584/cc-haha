export type BuiltinPet = {
  source: 'builtin'
  id: string
  displayName: string
  description: string
  descriptionKey:
    | 'settings.pets.builtin.dada'
    | 'settings.pets.builtin.huhu'
    | 'settings.pets.builtin.bubu'
    | 'settings.pets.builtin.huihui'
  imageUrl: string
  spriteVersionNumber: 2
  spritesheetUrl: string
  accent: string
}

export type CustomAtlasPet = {
  source: 'custom'
  id: string
  displayName: string
  description: string
  spriteVersionNumber: 2
  dataUrl: string
}

export type CustomImagePet = {
  source: 'custom'
  id: string
  displayName: string
  description: string
  manifestVersion: 1
  spriteVersionNumber: 1
  imagePath: string
  motionProfile: 'soft-spring-v1'
  dataUrl: string
}

export type CustomPet = CustomAtlasPet | CustomImagePet

export type PetDescriptor = BuiltinPet | CustomPet
