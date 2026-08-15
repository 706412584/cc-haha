import { describe, expect, test } from 'bun:test'
import { normalizeAttachmentForAPI } from '../messages.js'
import {
  ULTRACODE_ENTER_REMINDER,
  ULTRACODE_EXIT_REMINDER,
  ULTRACODE_STILL_ON_REMINDER,
  WORKFLOW_KEYWORD_REMINDER,
} from './ultracode.js'

/**
 * The reminders are the only channel that tells the model a turn was opted
 * into orchestration. If one stops rendering, the Workflow tool's opt-in rule
 * silently stops firing and nothing else in the system notices.
 */
function renderedText(
  attachment: Parameters<typeof normalizeAttachmentForAPI>[0],
): string {
  return normalizeAttachmentForAPI(attachment)
    .map(message =>
      typeof message.message.content === 'string'
        ? message.message.content
        : message.message.content
            .map(block => ('text' in block ? block.text : ''))
            .join('\n'),
    )
    .join('\n')
}

describe('workflow reminders', () => {
  test('the keyword reminder names the tool the model must call', () => {
    const text = renderedText({ type: 'workflow_keyword_request' })
    expect(text).toContain(WORKFLOW_KEYWORD_REMINDER)
    expect(text).toContain('Workflow tool')
    expect(text).toContain('<system-reminder>')
  })

  test('entering ultracode gets the full standing instruction', () => {
    const text = renderedText({
      type: 'ultra_effort_enter',
      reminderType: 'full',
    })
    expect(text).toContain(ULTRACODE_ENTER_REMINDER)
    expect(text).toContain('every substantive task')
  })

  test('staying in ultracode gets the short form, not the paragraph', () => {
    const text = renderedText({
      type: 'ultra_effort_enter',
      reminderType: 'short',
    })
    expect(text).toContain(ULTRACODE_STILL_ON_REMINDER)
    expect(text).not.toContain('token cost is not a constraint')
  })

  test('leaving ultracode restores the opt-in rule explicitly', () => {
    const text = renderedText({ type: 'ultra_effort_exit' })
    expect(text).toContain(ULTRACODE_EXIT_REMINDER)
    expect(text).toContain('opt-in rule applies again')
  })
})
