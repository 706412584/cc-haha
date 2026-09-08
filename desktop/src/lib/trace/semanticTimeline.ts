import type { NormalizedBlock, NormalizedMessage } from './types'

/**
 * What a non-user text block inside a user-role message actually is. The model
 * sees these as user input, but they are assembled by the harness rather than
 * typed by the person, so the timeline shows them as their own records.
 */
export type ContextInjectionKind =
  | 'system-reminder'
  | 'deferred-tools'
  | 'other'

export type ContextInjection = {
  kind: ContextInjectionKind
  /** Short label for the timeline row; the full text stays in `text`. */
  label: string
  text: string
}

export type ClassifiedUserContent = {
  injections: ContextInjection[]
  /** The text the person actually typed, when this message carries one. */
  userText: string | null
}

/**
 * Tags the harness wraps around assembled context before sending it as user
 * input. This is a closed list on purpose: an unknown tag is far more likely
 * to be something the person typed or pasted than a new harness wrapper, and
 * showing typed input under "injected context" is the worse mistake — the
 * reader goes looking for their own message and does not find it.
 */
const INJECTION_TAGS: ReadonlyArray<{ tag: string; kind: ContextInjectionKind; label: string }> = [
  { tag: 'system-reminder', kind: 'system-reminder', label: 'System reminder' },
  { tag: 'available-deferred-tools', kind: 'deferred-tools', label: 'Deferred tools' },
  { tag: 'background-job-complete', kind: 'other', label: 'Background job' },
  { tag: 'command-name', kind: 'other', label: 'Command' },
  { tag: 'command-message', kind: 'other', label: 'Command' },
  { tag: 'local-command-stdout', kind: 'other', label: 'Command output' },
]

function openingTag(text: string): string | null {
  const match = /^\s*<([a-z][a-z0-9-]*)(?:\s[^>]*)?>/i.exec(text)
  return match?.[1]?.toLowerCase() ?? null
}

/**
 * Name an injection from its own content so the timeline row says what was
 * injected rather than repeating the wrapper tag. A `# Heading` wins because
 * the harness writes one for each distinct reminder; otherwise the first
 * non-empty line stands in.
 */
function deriveLabel(fallback: string, text: string): string {
  const body = text.replace(/^\s*<[a-z][a-z0-9-]*(?:\s[^>]*)?>/i, '').replace(/<\/[a-z][a-z0-9-]*>\s*$/i, '')
  const heading = /^\s*#{1,3}\s+(.{1,60}?)\s*$/m.exec(body)
  if (heading?.[1]) return heading[1].trim()
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
  }
  return fallback
}

/**
 * Split one user-role message into harness-assembled context and the person's
 * own text.
 *
 * Recognition is by wrapper tag alone. Position cannot stand in for it here:
 * `hoistToolResults` in `src/utils/messages.ts` moves every tool result to the
 * front of a merged user message, so an attachment the harness appended after a
 * tool result and an instruction the person typed after interrupting one arrive
 * in exactly the same shape. Faced with that ambiguity this errs toward the
 * conversation — unrecognized text stays the person's message, because someone
 * looking for what they said and not finding it is the worse failure.
 */
export function classifyUserContent(blocks: readonly NormalizedBlock[]): ClassifiedUserContent {
  const injections: ContextInjection[] = []
  const plain: string[] = []

  for (const block of blocks) {
    if (block.type !== 'text') continue
    const text = block.text
    if (text.trim().length === 0) continue

    const tag = openingTag(text)
    const known = tag ? INJECTION_TAGS.find((entry) => entry.tag === tag) : undefined
    if (known) {
      injections.push({ kind: known.kind, label: deriveLabel(known.label, text), text })
      continue
    }
    plain.push(text)
  }

  return {
    injections,
    userText: plain.length > 0 ? plain.join('\n\n') : null,
  }
}

export type LocatedInjection = ContextInjection & { messageIndex: number }

export type SplitRequestMessages = {
  /** Harness-assembled context, in the order the provider received it. */
  injections: LocatedInjection[]
  /**
   * The exchange with the injections lifted out: assistant turns untouched,
   * user turns reduced to what the person typed plus any tool results. A user
   * message that carried nothing else is dropped.
   */
  conversation: NormalizedMessage[]
}

/**
 * Separate the assembled context from the conversation inside one request's
 * message list, so each can be read on its own terms.
 */
export function splitRequestMessages(
  messages: readonly NormalizedMessage[],
): SplitRequestMessages {
  const injections: LocatedInjection[] = []
  const conversation: NormalizedMessage[] = []

  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user') {
      conversation.push(message)
      return
    }

    const { injections: found, userText } = classifyUserContent(message.content)
    for (const injection of found) injections.push({ ...injection, messageIndex })

    // Only text blocks were classified above, so only they are replaced. Any
    // other block type — tool results, images, or something unexpected on a
    // user turn — is carried through rather than silently dropped. The text
    // goes last because `hoistToolResults` already put tool results first.
    const kept: NormalizedBlock[] = message.content.filter((block) => block.type !== 'text')
    if (userText !== null) kept.push({ type: 'text', text: userText })
    if (kept.length > 0) conversation.push({ role: message.role, content: kept })
  })

  return { injections, conversation }
}
