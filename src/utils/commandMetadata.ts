import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
} from '../constants/xml.js'

const COMMAND_METADATA_TAGS = new Set([
  COMMAND_NAME_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_ARGS_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  'skill-format',
])

const XML_TAG_BLOCK_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/gi

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function readXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  const value = match?.[1]?.trim()
  return value ? decodeXmlText(value) : undefined
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []

  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const record = block as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string'
        ? [record.text]
        : []
    })
    .map((text) => text.trim())
    .filter(Boolean)
}

function hasCommandMetadataTag(text: string): boolean {
  return (
    text.includes(`<${COMMAND_NAME_TAG}>`) ||
    text.includes(`<${COMMAND_MESSAGE_TAG}>`) ||
    text.includes(`<${COMMAND_ARGS_TAG}>`) ||
    text.includes(`<${LOCAL_COMMAND_CAVEAT_TAG}>`) ||
    text.includes('<skill-format>')
  )
}

function isOnlyKnownCommandMetadata(text: string): boolean {
  const remainder = text.replace(XML_TAG_BLOCK_PATTERN, (match, tag: string) => (
    COMMAND_METADATA_TAGS.has(tag.toLowerCase()) ? '' : match
  ))
  return remainder.trim().length === 0
}

function formatCommandDisplayText(commandName: string, args: string, skillFormat: boolean, commandMessage?: string): string {
  if (skillFormat) {
    return `Skill(${commandMessage || commandName.replace(/^\//, '')})`
  }

  const normalizedName = commandName.startsWith('/') ? commandName : `/${commandName}`
  return [normalizedName, args.trim()].filter(Boolean).join(' ')
}

function parseCommandMetadataText(text: string): string | null {
  const trimmed = text.trim()
  if (!hasCommandMetadataTag(trimmed)) return null
  if (!isOnlyKnownCommandMetadata(trimmed)) return null

  const commandName = readXmlTag(trimmed, COMMAND_NAME_TAG)
  if (!commandName) return null

  const args = readXmlTag(trimmed, COMMAND_ARGS_TAG) ?? ''
  const commandMessage = readXmlTag(trimmed, COMMAND_MESSAGE_TAG)
  const skillFormat = readXmlTag(trimmed, 'skill-format') === 'true'
  return formatCommandDisplayText(commandName, args, skillFormat, commandMessage)
}

export function getCommandMetadataDisplayText(content: unknown): string | null {
  const textBlocks = extractTextBlocks(content)
  if (textBlocks.length === 0) return null

  const displayBlocks = textBlocks.map(parseCommandMetadataText)
  if (displayBlocks.some((text) => text === null)) return null
  return displayBlocks.join('\n')
}

export function shouldHideCommandMetadataContent(content: unknown): boolean {
  const textBlocks = extractTextBlocks(content)
  if (textBlocks.length === 0) return false
  if (!textBlocks.some(hasCommandMetadataTag)) return false
  return getCommandMetadataDisplayText(content) === null
}
