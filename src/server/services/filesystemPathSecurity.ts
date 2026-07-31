import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { normalizeDriveRootPathForPlatform } from './windowsDrivePath.js'

export async function canonicalizeExistingFilesystemPath(
  filePath: string,
): Promise<string | null> {
  try {
    const canonicalPath = await fs.realpath(
      path.resolve(normalizeDriveRootPathForPlatform(filePath)),
    )
    return path.resolve(normalizeDriveRootPathForPlatform(canonicalPath))
  } catch {
    return null
  }
}
