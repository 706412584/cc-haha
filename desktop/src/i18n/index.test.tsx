import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { translate, useTranslation } from '.'
import { en } from './locales/en'
import { zh } from './locales/zh'
import { zh as zhTW } from './locales/zh-TW'
import { jp } from './locales/jp'
import { kr } from './locales/kr'

const locales = { en, zh, 'zh-TW': zhTW, jp, kr }

describe('useTranslation', () => {
  afterEach(() => {
    act(() => {
      useSettingsStore.getState().setLocale('zh')
    })
  })

  it('keeps the translation function stable until the locale changes', () => {
    act(() => {
      useSettingsStore.getState().setLocale('zh')
    })

    const { result, rerender } = renderHook(() => useTranslation())
    const initial = result.current

    rerender()
    expect(result.current).toBe(initial)

    act(() => {
      useSettingsStore.getState().setLocale('en')
    })
    expect(result.current).not.toBe(initial)
  })

  it('resolves every registered locale to its own translation', () => {
    expect(translate('en', 'common.save')).toBe('Save')
    expect(translate('zh', 'common.save')).toBe('保存')
    expect(translate('zh-TW', 'common.save')).toBe('儲存')
    expect(translate('jp', 'common.save')).toBe('保存')
    expect(translate('kr', 'common.save')).toBe('저장')
  })

  it('interpolates params across the new locales', () => {
    expect(translate('jp', 'session.timeMinutes', { n: 5 })).toBe('5 分前')
    expect(translate('kr', 'session.timeMinutes', { n: 5 })).toBe('5분 전')
  })

  it('resolves the recommended-skill catalog descriptions in every locale', () => {
    // Each newly-added catalog entry must have a real, locale-specific
    // description across all five locales — otherwise the desktop Settings →
    // Skills "Recommended" card silently falls back to the English string the
    // server ships. Guards the mattpocock/* + karpathy entries added with the
    // catalog wiring.
    const keys = [
      'settings.skills.catalog.karpathy-guidelines.desc',
      'settings.skills.catalog.mattpocock-grilling.desc',
      'settings.skills.catalog.mattpocock-tdd.desc',
      'settings.skills.catalog.mattpocock-diagnosing-bugs.desc',
    ] as const
    const locales = ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const

    for (const key of keys) {
      for (const locale of locales) {
        const value = translate(locale, key)
        // A missing key returns the key itself; assert we got a real string.
        expect(value, `${locale} / ${key}`).not.toBe(key)
        expect(value.length, `${locale} / ${key}`).toBeGreaterThan(0)
      }
      // The Chinese description must be written natively, not left as English.
      expect(translate('zh', key)).not.toBe(translate('en', key))
    }
  })

  it('resolves the new skill category labels in every locale', () => {
    const keys = [
      'settings.skills.category.engineering',
      'settings.skills.category.productivity',
      'settings.skills.category.workflow',
    ] as const
    for (const key of keys) {
      for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
        expect(translate(locale, key), `${locale} / ${key}`).not.toBe(key)
      }
    }
  })

  it('translates provider transition and LSP lifecycle UI in every locale', () => {
    const keys = [
      'workspace.lspUnsupported',
      'workspace.lspUnavailable',
      'workspace.lspRetry',
      'chat.providerTransitionTitle',
      'chat.providerTransitionBody',
      'chat.providerTransitionConfirm',
    ] as const
    for (const key of keys) {
      for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
        expect(translate(locale, key, { count: 3 }), `${locale} / ${key}`).not.toBe(key)
      }
    }
    expect(translate('zh', 'chat.providerTransitionBody', { count: 3 })).toContain('3')
  })

  it('localizes pet validation and agent failures in every registered locale', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
      expect(translate(locale, 'settings.pets.createError.imageDimensions')).not.toBe(
        'settings.pets.createError.imageDimensions',
      )
      expect(translate(locale, 'settings.agents.loadError')).not.toBe('settings.agents.loadError')
    }
  })

  it('describes exactly the standard ~/.claude mode and an external custom mode', () => {
    expect(translate('en', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('zh', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('zh-TW', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('jp', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('kr', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('en', 'settings.general.storagePortableTitle')).toContain('custom')
    expect(translate('zh', 'settings.general.storagePortableTitle')).toContain('自定义')
  })

  // The installed-skills overview was dropped in b64069a3, but the UI rollback
  // right after it restored the locale files wholesale and carried its keys back
  // in. Every locale kept the same key count, so a parity check cannot see this.
  it('carries no key for the removed installed-skills overview', () => {
    for (const [name, locale] of Object.entries(locales)) {
      const resurrected = Object.keys(locale).filter(
        key => key.startsWith('market.installedSkills.') || key === 'market.section.installed',
      )
      expect(resurrected, `${name} still defines removed installed-skills keys`).toEqual([])
    }
  })
})
