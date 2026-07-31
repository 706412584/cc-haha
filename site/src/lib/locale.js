/**
 * 站点语言分流。
 *
 * 只有根路径 `/` 会按浏览器语言自动选：中文浏览器留在中文站，其余跳 `/en`。
 * 带语言前缀的地址（`/en`、`/start`、`/en/start`）都是用户点进来的明确意图，一概不动 ——
 * 否则英文用户点一条中文文档链接会被莫名踢走。
 *
 * 手动切过语言之后，选择记进 localStorage，之后回到 `/` 就按记住的来，不再被浏览器语言
 * 盖掉；不然导航里的切换器等于没用：浏览器是中文的人切到英文，下次进首页又被弹回中文。
 *
 * 注意：同一套判断在 index.html 里有一份内联副本 —— 首帧就得跳完，等不到这个模块加载。
 * 改 STORAGE_KEY 或判定规则时两处要一起改，check-docs.mjs 会盯着它们不漂移。
 */

export const LOCALE_STORAGE_KEY = 'cch-locale'

/** BCP-47 里中文一律是 zh / zh-CN / zh-TW / zh-Hans…，但 zhuang 之类不算。 */
const CHINESE_TAG = /^zh(?:-|$)/i

export function prefersChinese(languages) {
  if (!Array.isArray(languages)) return false
  return languages.some((tag) => typeof tag === 'string' && CHINESE_TAG.test(tag.trim()))
}

export function normalizeStoredLocale(value) {
  return value === 'en' || value === 'zh' ? value : null
}

/**
 * 根路径该跳去哪；返回 null 表示留在原地（中文站）。
 */
export function resolveRootRedirect({ languages, pathname, stored }) {
  if (String(pathname ?? '/').replace(/\/+$/, '') !== '') return null

  const locale = normalizeStoredLocale(stored) || (prefersChinese(languages) ? 'zh' : 'en')
  return locale === 'en' ? '/en' : null
}

export function rememberLocale(locale) {
  const value = normalizeStoredLocale(locale)
  if (!value) return

  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, value)
  } catch {
    // 隐私模式下 localStorage 直接抛，记不住偏好也不能让语言切换本身失败。
  }
}
