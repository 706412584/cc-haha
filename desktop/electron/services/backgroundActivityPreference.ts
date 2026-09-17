import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * "Keep working in the background" preference.
 *
 * Off by default, and deliberately so: the renderer throttles timers and
 * animations while its window is hidden, which is what keeps a backgrounded app
 * cheap. But the session WebSocket's heartbeat is driven by `setInterval`, so
 * once the display sleeps the pings stop, the socket drops (close code 1006),
 * and the server — correctly refusing to kill a turn that is still running —
 * keeps the CLI alive for a session nobody is connected to. Turning this on
 * trades a little idle power for a connection that survives the screen going
 * off.
 *
 * Stored in the main process rather than user settings because it must be
 * applied at window creation and on every change, before any renderer exists.
 */

export const BACKGROUND_ACTIVITY_PREFERENCE_FILE = 'background-activity.json'

export type BackgroundActivityAppLike = {
  getPath(name: 'userData'): string
}

type StoredBackgroundActivity = {
  keepActiveInBackground: boolean
}

export function backgroundActivityPreferencePath(app: BackgroundActivityAppLike): string {
  return path.join(app.getPath('userData'), BACKGROUND_ACTIVITY_PREFERENCE_FILE)
}

export function readKeepActiveInBackground(app: BackgroundActivityAppLike): boolean {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(backgroundActivityPreferencePath(app), 'utf8'),
    )
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    const entries = Object.entries(parsed)
    if (entries.length !== 1 || entries[0]?.[0] !== 'keepActiveInBackground') return false
    return entries[0][1] === true
  } catch {
    return false
  }
}

export function writeKeepActiveInBackground(
  app: BackgroundActivityAppLike,
  keepActiveInBackground: boolean,
): void {
  if (typeof keepActiveInBackground !== 'boolean') {
    throw new Error(
      `Unsupported background activity preference: ${String(keepActiveInBackground)}`,
    )
  }

  const target = backgroundActivityPreferencePath(app)
  const configDir = path.dirname(target)
  const temporary = path.join(configDir, `.${BACKGROUND_ACTIVITY_PREFERENCE_FILE}.${randomUUID()}.tmp`)
  const preference: StoredBackgroundActivity = { keepActiveInBackground }
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
