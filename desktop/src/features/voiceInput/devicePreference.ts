const STORAGE_KEY = 'cc-haha-voice-input-device'

/** The microphone the user picked in settings; undefined means the system default. */
export function getPreferredMicrophoneId(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) || undefined
  } catch {
    return undefined
  }
}

export function setPreferredMicrophoneId(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage can be blocked or full; the choice then lasts only until reload.
  }
}
