export type Locale = 'en' | 'zh' | 'zh-TW' | 'jp' | 'kr'

export const LOCALE_STORAGE_KEY = 'cc-haha-locale'

const VALID_LOCALES: readonly Locale[] = ['en', 'zh', 'zh-TW', 'jp', 'kr']
const DOCUMENT_LANG: Record<Locale, string> = {
  en: 'en',
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  jp: 'ja',
  kr: 'ko',
}

let initializedLocale: Locale | null = null
const localeChangeListeners = new Set<(locale: Locale) => void>()

export type LocaleRuntime = {
  getLocalePreference(): Promise<Locale | null>
  getPreferredSystemLanguages(): Promise<string[]>
  setLocalePreference(locale: Locale): Promise<void>
  onLocaleChanged(handler: (locale: Locale) => void): Promise<() => void>
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string'
    && (VALID_LOCALES as readonly string[]).includes(value)
}

export function readBrowserLanguages(): string[] {
  if (typeof navigator === 'undefined') return []

  try {
    const languages = navigator.languages
    if (Array.isArray(languages) && languages.length > 0) return [...languages]
  } catch {
    // Continue to the singular language fallback.
  }

  try {
    return navigator.language ? [navigator.language] : []
  } catch {
    return []
  }
}

function mapLanguageTag(languageTag: string): Locale | null {
  const [language, ...subtags] = languageTag.trim().replace(/_/g, '-').toLowerCase().split('-')
  if (language === 'en') return 'en'
  if (language === 'ja') return 'jp'
  if (language === 'ko') return 'kr'
  if (language !== 'zh') return null

  if (subtags.includes('hant')) return 'zh-TW'
  if (subtags.includes('hans')) return 'zh'
  return subtags.some(subtag => subtag === 'tw' || subtag === 'hk' || subtag === 'mo')
    ? 'zh-TW'
    : 'zh'
}

export function resolveSupportedLocale(languageTags: readonly string[]): Locale {
  for (const languageTag of languageTags) {
    const locale = mapLanguageTag(languageTag)
    if (locale) return locale
  }
  return 'en'
}

export function readStoredLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // localStorage can be unavailable in locked-down browser contexts.
  }
  return null
}

export function getInitialLocale(): Locale {
  return readStoredLocale()
    ?? initializedLocale
    ?? resolveSupportedLocale(readBrowserLanguages())
}

export function applyDocumentLocale(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = DOCUMENT_LANG[locale]
}

function applyResolvedLocale(locale: Locale): void {
  initializedLocale = locale
  applyDocumentLocale(locale)
  for (const listener of localeChangeListeners) listener(locale)
}

export function subscribeLocaleChanges(listener: (locale: Locale) => void): () => void {
  localeChangeListeners.add(listener)
  return () => {
    localeChangeListeners.delete(listener)
  }
}

export async function initializeLocale(
  runtime: LocaleRuntime,
): Promise<Locale> {
  try {
    await runtime.onLocaleChanged((locale) => {
      if (isLocale(locale)) applyResolvedLocale(locale)
    })
  } catch {
    // A host without event support can still initialize from the snapshot below.
  }

  const storedLocale = readStoredLocale()
  if (storedLocale) {
    try {
      await runtime.setLocalePreference(storedLocale)
    } catch {
      // localStorage remains the main-window compatibility source.
    }
    applyResolvedLocale(storedLocale)
    return storedLocale
  }

  try {
    const appPreference = await runtime.getLocalePreference()
    if (isLocale(appPreference)) {
      applyResolvedLocale(appPreference)
      return appPreference
    }
  } catch {
    // Fall through to system language detection.
  }

  let languageTags: string[] = []
  try {
    const preferredSystemLanguages = await runtime.getPreferredSystemLanguages()
    languageTags = preferredSystemLanguages.length > 0
      ? preferredSystemLanguages
      : readBrowserLanguages()
  } catch {
    languageTags = readBrowserLanguages()
  }

  const locale = resolveSupportedLocale(languageTags)
  applyResolvedLocale(locale)
  return locale
}
