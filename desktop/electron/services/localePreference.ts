import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  isLocale,
  type Locale,
} from '../../src/i18n/locale'

export const LOCALE_PREFERENCE_FILE = 'locale-preference.json'

export type LocalePreferenceAppLike = {
  getPath(name: 'userData'): string
}

type StoredLocalePreference = {
  locale: Locale
}

export function localePreferencePath(app: LocalePreferenceAppLike): string {
  return path.join(app.getPath('userData'), LOCALE_PREFERENCE_FILE)
}

export function readLocalePreference(app: LocalePreferenceAppLike): Locale | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(localePreferencePath(app), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const entries = Object.entries(parsed)
    if (entries.length !== 1 || entries[0]?.[0] !== 'locale') return null
    return isLocale(entries[0][1]) ? entries[0][1] : null
  } catch {
    return null
  }
}

export function writeLocalePreference(
  app: LocalePreferenceAppLike,
  locale: Locale,
): void {
  if (!isLocale(locale)) {
    throw new Error(`Unsupported locale preference: ${String(locale)}`)
  }

  const target = localePreferencePath(app)
  const configDir = path.dirname(target)
  const temporary = path.join(configDir, `.${LOCALE_PREFERENCE_FILE}.${randomUUID()}.tmp`)
  const preference: StoredLocalePreference = { locale }
  fs.mkdirSync(configDir, { recursive: true })
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(preference, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}
