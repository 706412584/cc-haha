export type InsertionPoint = { start: number; end: number }

/** Recognizer output is a single line; collapse any line breaks it might carry. */
export function normalizeDictationText(raw: string): string {
  return raw.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

const WORD_END = /[A-Za-z0-9.,;:!?)]$/
const WORD_START = /^[A-Za-z0-9(]/

/**
 * Adds a space only where two alphanumeric runs would otherwise fuse. CJK
 * output joins its neighbours directly, so it never gets one.
 */
export function withDictationSpacing(before: string, text: string, after: string): string {
  const leading = WORD_END.test(before) && WORD_START.test(text) ? ' ' : ''
  const trailing = WORD_END.test(text) && WORD_START.test(after) ? ' ' : ''
  return `${leading}${text}${trailing}`
}


export type DictationResultPlacement =
  /** Write at the position captured when recording began. */
  | 'insert'
  /** Keep the text and let the user decide. */
  | 'hold'

/**
 * Decides what to do with a transcript once it arrives.
 *
 * The draft is compared by revision, not by content: typing a character and
 * deleting it again still moved the caret the captured position was measured
 * against, and a message sent while the model was busy leaves an empty draft
 * that looks identical to the one recording began in. An IME composition in
 * progress counts as an edit in flight, so it holds too.
 */
export function placeDictationResult(input: {
  revisionAtStart: number
  revisionNow: number
  blocked: boolean
  composing: boolean
}): DictationResultPlacement {
  if (input.composing || input.blocked || input.revisionNow !== input.revisionAtStart) return 'hold'
  return 'insert'
}
