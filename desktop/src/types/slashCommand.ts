export type SlashCommandKind = 'command' | 'skill' | 'agent'

export type SlashCommandSource = 'user' | 'project' | 'plugin'

export type SlashCommandOption = {
  name: string
  description: string
  argumentHint?: string
  kind?: SlashCommandKind
  source?: SlashCommandSource
}
