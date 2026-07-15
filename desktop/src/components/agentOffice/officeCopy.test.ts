import { describe, expect, it } from 'vitest'
import { translate, type Locale } from '../../i18n'
import {
  formatAgentOfficeRowLabel,
  formatAgentOfficeState,
  formatMainAgentStatus,
  resolveAgentOfficeCopy,
} from './officeCopy'

const locales: Locale[] = ['en', 'zh', 'zh-TW', 'jp', 'kr']

describe('Agent Office product copy', () => {
  it.each(locales)('provides localized runtime, state, history, and handoff copy for %s', (locale) => {
    const copy = resolveAgentOfficeCopy((key) => translate(locale, key))

    expect(copy.mainAgentStatus).toContain('{status}')
    expect(Object.values(copy.agentState)).not.toContain('')
    expect(copy.earlierTasks).not.toBe('')
    expect(Object.values(copy.handoffStatus)).not.toContain('')
    expect(copy.handoffVisitMessages).toHaveLength(4)
    expect(copy.handoffVisitMessages.every((message) => message.includes('{name}'))).toBe(true)
    expect(formatMainAgentStatus(copy, '/deploy')).toContain('/deploy')
    expect(formatAgentOfficeState(copy, 'talking')).toBe(copy.agentState.talking)
    expect(formatAgentOfficeRowLabel(copy, {
      label: 'Earlier tasks',
      taskHistory: { completed: 1 },
    })).toBe(copy.earlierTasks)
    expect(formatAgentOfficeRowLabel(copy, { label: '/deploy' })).toBe('/deploy')

    if (locale !== 'en') {
      expect(copy.mainAgentStatus).not.toBe('Main Agent · {status}')
      expect(copy.earlierTasks).not.toBe('Earlier tasks')
      expect(copy.handoffStatus.delivering).not.toBe('Dispatching…')
      expect(copy.handoffVisitMessages[0]).not.toBe('{name}, this one is yours.')
    }
  })
})
