import { join } from 'node:path'
import { getCcHahaDir } from '../../../utils/envUtils.js'
import type { LocalIndexMode } from './types.js'

export const LOCAL_INDEX_INVALID_MODE = 'LOCAL_INDEX_INVALID_MODE' as const

export type LocalIndexModeResolution = {
  mode: LocalIndexMode
  warningCode: typeof LOCAL_INDEX_INVALID_MODE | null
}

export function resolveLocalIndexMode(
  value = process.env.CC_HAHA_LOCAL_INDEX,
): LocalIndexModeResolution {
  // SQLite is the normal product read path. Explicit modes remain available
  // only for deterministic parity/fallback tests and emergency diagnosis.
  if (value === undefined || value === 'on') {
    return { mode: 'on', warningCode: null }
  }
  if (value === 'off') {
    return { mode: 'off', warningCode: null }
  }
  if (value === 'shadow') {
    return { mode: value, warningCode: null }
  }
  return { mode: 'on', warningCode: LOCAL_INDEX_INVALID_MODE }
}

export function getLocalIndexDatabasePath(): string {
  return join(getCcHahaDir(), 'db', 'index-v1.sqlite')
}
