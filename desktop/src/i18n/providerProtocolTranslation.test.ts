import { describe, expect, it } from 'vitest'
import { en } from './locales/en'
import { zh } from './locales/zh'
import { zh as zhTW } from './locales/zh-TW'
import { jp } from './locales/jp'
import { kr } from './locales/kr'

const LOCALES = { en, zh, 'zh-TW': zhTW, jp, kr } as const

const FORMAT_KEYS = [
  'settings.providers.apiFormatOpenaiChat',
  'settings.providers.apiFormatOpenaiResponses',
] as const

describe('provider protocol translation wording', () => {
  for (const [locale, dictionary] of Object.entries(LOCALES)) {
    it(`${locale} identifies OpenAI formats as local protocol translation`, () => {
      const values = FORMAT_KEYS.map((key) => dictionary[key])
      for (const value of values) {
        expect(value).toBeTruthy()
        expect(value.toLowerCase()).toMatch(/local|本地|本機|ローカル|로컬/)
      }

      const hint = dictionary['settings.providers.proxyHint']
      expect(hint).toContain('cc-haha')
      expect(hint.toLowerCase()).toMatch(/third-party|第三方|第三者|타사/)
    })
  }

  it('keeps the native Anthropic wording distinct in every locale', () => {
    for (const dictionary of Object.values(LOCALES)) {
      const native = dictionary['settings.providers.apiFormatAnthropic']
      expect(native).not.toMatch(/OpenAI|translation|转换|轉換|変換|변환/)
    }
  })
})
