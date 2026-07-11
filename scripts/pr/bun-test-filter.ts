import { isAbsolute } from 'node:path'

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/

/**
 * Root explicit Bun test filters so Bun does not scan the whole repository.
 * Unrooted filters can retain enough directory descriptors on macOS to break
 * subprocess output capture: https://github.com/oven-sh/bun/issues/32067
 */
export function rootBunTestFilter(filter: string): string {
  if (
    filter.startsWith('./') ||
    filter.startsWith('../') ||
    isAbsolute(filter) ||
    WINDOWS_ABSOLUTE_PATH.test(filter)
  ) {
    return filter
  }
  return `./${filter}`
}
