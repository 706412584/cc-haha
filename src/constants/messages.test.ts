import { describe, expect, test } from 'bun:test'
import {
  ASK_USER_QUESTION_CLARIFY_MESSAGE,
  ASK_USER_QUESTION_NO_ANSWER_MESSAGE,
} from './messages.js'

describe('AskUserQuestion messages', () => {
  test('the no-answer message tells the model silence is not a choice', () => {
    // This text is what unblocks the CLI when a question expires unanswered, so
    // it must explicitly forbid reading silence as approval of an option.
    expect(ASK_USER_QUESTION_NO_ANSWER_MESSAGE).toContain('did not answer')
    expect(ASK_USER_QUESTION_NO_ANSWER_MESSAGE).toContain('do not assume any answer was chosen')
  })

  test('the clarify and no-answer messages stay distinct', () => {
    // A user who wants to talk the question over is not the same as one who
    // never answered: conflating them would tell the model to wait on a reply
    // that is not coming, or to reformulate questions nobody asked about.
    expect(ASK_USER_QUESTION_NO_ANSWER_MESSAGE).not.toContain('reformulate')
    expect(ASK_USER_QUESTION_CLARIFY_MESSAGE).toContain('reformulate')
    expect(ASK_USER_QUESTION_NO_ANSWER_MESSAGE).not.toBe(ASK_USER_QUESTION_CLARIFY_MESSAGE)
  })
})
