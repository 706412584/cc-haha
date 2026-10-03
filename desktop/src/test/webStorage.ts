/**
 * Node 22+ defines a global `localStorage` / `sessionStorage` accessor that
 * stays inert unless the process was started with `--localstorage-file`.
 * vitest's jsdom environment only copies a window key onto `globalThis` when
 * nothing is there yet, so Node's inert stub wins over jsdom's real Storage and
 * every `localStorage.clear()` in a `beforeEach` throws. Installing a real
 * Storage here restores browser semantics regardless of Node version.
 */
class MemoryStorage implements Storage {
  #entries = new Map<string, string>()

  get length(): number {
    return this.#entries.size
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.#entries.get(String(key)) ?? null
  }

  setItem(key: string, value: string): void {
    this.#entries.set(String(key), String(value))
  }

  removeItem(key: string): void {
    this.#entries.delete(String(key))
  }

  clear(): void {
    this.#entries.clear()
  }

  [name: string]: unknown
}

function installStorage(name: 'localStorage' | 'sessionStorage'): void {
  // StorageEvent validates storageArea against jsdom's Storage implementation.
  // Node's experimental global accessor shadows window[name], so use jsdom's
  // backing instance when it is available.
  try {
    const browserStorage =
      (window as unknown as Record<string, Storage | undefined>)[`_${name}`] ?? window[name]
    if (browserStorage instanceof window.Storage) {
      Object.defineProperty(globalThis, name, {
        value: browserStorage,
        configurable: true,
        writable: true,
      })
      return
    }
  } catch {
    // An opaque jsdom origin may not expose storage; use the in-memory fallback.
  }

  let usable = false
  try {
    const existing = (globalThis as Record<string, unknown>)[name] as Storage | undefined
    usable = typeof existing?.setItem === 'function' && typeof existing?.clear === 'function'
  } catch {
    // Node's accessor throws when web storage is unavailable — treat as missing.
  }
  if (usable) return

  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
}

installStorage('localStorage')
installStorage('sessionStorage')
