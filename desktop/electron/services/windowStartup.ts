export type MainWindowStartupOptions = {
  load: () => Promise<void>
  beforeReveal: () => void
  reveal: () => void
  onLoadFailure: (error: unknown) => void
}

export type MainWindowStartupResult =
  | { loaded: true }
  | { loaded: false, error: unknown }

export async function loadAndRevealMainWindow({
  load,
  beforeReveal,
  reveal,
  onLoadFailure,
}: MainWindowStartupOptions): Promise<MainWindowStartupResult> {
  let loaded = true
  let loadError: unknown
  try {
    await load()
  } catch (error) {
    loaded = false
    loadError = error
  }

  beforeReveal()
  reveal()

  if (!loaded) {
    onLoadFailure(loadError)
    return { loaded: false, error: loadError }
  }
  return { loaded: true }
}
