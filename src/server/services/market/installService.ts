/**
 * Skills Market — install/uninstall service.
 *
 * Install: download every file to a temp dir (sha256-verified), then atomically
 * move it into ~/.claude/skills/<slug>/ with a .market-meta.json marker.
 * Uninstall: only removes directories that carry the marker file.
 */

import { createHash } from 'node:crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { clearSkillCaches } from '../../../skills/loadSkillsDir.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { clawhubProvider } from './clawhubProvider.js'
import { skillhubProvider } from './skillhubProvider.js'
import {
  annotateInstallState,
  getMarketSkillsDir,
  MARKET_META_FILENAME,
  readMarketMeta,
  resolveMarketSkill,
  type MarketMeta,
} from './marketService.js'
import { marketCache } from './cache.js'
import {
  MARKET_ERROR_CODES,
  MARKET_LIMITS,
  MarketUpstreamError,
  sanitizeDirName,
  type MarketProvider,
  type MarketSource,
  type NormalizedSkill,
} from './types.js'

const providers: Record<MarketSource, MarketProvider> = {
  clawhub: clawhubProvider,
  skillhub: skillhubProvider,
}

// In-flight lock: one install per slug at a time.
const inFlight = new Map<string, Promise<unknown>>()

function isSafeRelativeFilePath(filePath: string): boolean {
  if (!filePath || filePath.length > 512) return false
  if (path.isAbsolute(filePath)) return false
  const normalized = path.normalize(filePath)
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) return false
  if (filePath.includes('\0')) return false
  return true
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

async function moveIntoPlace(tmpDir: string, target: string): Promise<void> {
  try {
    await fs.rename(tmpDir, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      // Temp dir lives on another device — copy then clean up.
      await fs.cp(tmpDir, target, { recursive: true })
      await fs.rm(tmpDir, { recursive: true, force: true })
      return
    }
    throw error
  }
}

export type InstallResult = {
  installedPath: string
  skill: NormalizedSkill
}

export async function installMarketSkill(source: MarketSource, slug: string): Promise<InstallResult> {
  const existing = inFlight.get(slug)
  if (existing) {
    throw new ApiError(409, `Install already in progress for ${slug}`, MARKET_ERROR_CODES.installInProgress)
  }
  const task = performInstall(source, slug)
  inFlight.set(slug, task.catch(() => {}))
  try {
    return await task
  } finally {
    inFlight.delete(slug)
  }
}

async function performInstall(source: MarketSource, slug: string): Promise<InstallResult> {
  const dirName = sanitizeDirName(slug)
  if (!dirName) {
    throw new ApiError(422, `Skill slug cannot be used as a directory name: ${slug}`, MARKET_ERROR_CODES.notInstallable)
  }

  // Resolve detail (includes file list + limits + install state).
  let detail
  try {
    detail = await resolveMarketSkill(source, slug)
  } catch (error) {
    throw toUpstreamApiError(error)
  }
  if (detail.installState === 'installed') {
    throw new ApiError(409, `Skill already installed: ${slug}`, MARKET_ERROR_CODES.alreadyInstalled)
  }
  if (detail.installState === 'not-installable') {
    throw new ApiError(
      422,
      `Skill is not installable (${detail.notInstallableReason}): ${slug}`,
      MARKET_ERROR_CODES.notInstallable,
    )
  }

  // Re-fetch the file list at install time (detail may be cached).
  let files
  try {
    files = await providers[source].listFiles(slug, detail.version)
  } catch (error) {
    throw toUpstreamApiError(error)
  }
  if (!files.length || !files.some((f) => f.path === 'SKILL.md')) {
    throw new ApiError(422, `Skill has no installable files: ${slug}`, MARKET_ERROR_CODES.notInstallable)
  }
  if (files.length > MARKET_LIMITS.maxFileCount) {
    throw new ApiError(422, `Skill has too many files: ${slug}`, MARKET_ERROR_CODES.notInstallable)
  }
  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0)
  if (files.some((f) => f.size > MARKET_LIMITS.maxFileSize) || totalSize > MARKET_LIMITS.maxTotalSize) {
    throw new ApiError(422, `Skill files exceed the size limit: ${slug}`, MARKET_ERROR_CODES.notInstallable)
  }

  const skillsDir = getMarketSkillsDir()
  const target = path.join(skillsDir, dirName)

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haha-market-install-'))
  try {
    for (const file of files) {
      if (!isSafeRelativeFilePath(file.path)) {
        throw new ApiError(422, `Unsafe file path in skill: ${file.path}`, MARKET_ERROR_CODES.notInstallable)
      }
      let fetched
      try {
        fetched = await providers[source].fetchFile(slug, file.path)
      } catch (error) {
        throw toUpstreamApiError(error)
      }
      if (file.sha256 && sha256Hex(fetched.content) !== file.sha256.toLowerCase()) {
        throw new ApiError(
          502,
          `Checksum mismatch for ${file.path} — aborting install`,
          MARKET_ERROR_CODES.checksumMismatch,
        )
      }
      const filePath = path.join(tmpDir, file.path)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, fetched.content, 'utf-8')
    }

    const meta: MarketMeta = {
      id: `${source}:${slug}`,
      source,
      slug,
      version: detail.version,
      installedAt: new Date().toISOString(),
      fileCount: files.length,
    }
    await fs.writeFile(path.join(tmpDir, MARKET_META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')

    try {
      await fs.mkdir(skillsDir, { recursive: true })
    } catch (error) {
      throw new ApiError(500, `Cannot create skills directory: ${String(error)}`, MARKET_ERROR_CODES.diskError)
    }

    // Last-moment conflict check (races with manual installs).
    try {
      await fs.stat(target)
      throw new ApiError(409, `Skill directory already exists: ${dirName}`, MARKET_ERROR_CODES.alreadyInstalled)
    } catch (error) {
      if (error instanceof ApiError) throw error
      // ENOENT — expected, continue.
    }

    try {
      await moveIntoPlace(tmpDir, target)
    } catch (error) {
      throw new ApiError(500, `Failed to write skill to disk: ${String(error)}`, MARKET_ERROR_CODES.diskError)
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  clearSkillCaches()

  const annotated = await annotateInstallState(detail)
  return { installedPath: target, skill: annotated }
}

function toUpstreamApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof MarketUpstreamError) {
    return new ApiError(502, error.message, error.code)
  }
  return new ApiError(502, `Upstream download failed: ${String(error)}`, MARKET_ERROR_CODES.upstreamError)
}

export type UninstallResult = { skill: NormalizedSkill | null; removedPath: string }

export async function uninstallMarketSkill(source: MarketSource, slug: string): Promise<UninstallResult> {
  const dirName = sanitizeDirName(slug)
  if (!dirName) {
    throw ApiError.badRequest(`Invalid skill slug: ${slug}`)
  }
  const target = path.join(getMarketSkillsDir(), dirName)
  try {
    await fs.stat(target)
  } catch {
    throw new ApiError(404, `Skill is not installed: ${slug}`, MARKET_ERROR_CODES.notInstalled)
  }
  const meta = await readMarketMeta(dirName)
  if (!meta) {
    // Never delete directories the market didn't create.
    throw new ApiError(
      409,
      `Skill directory was not installed from the market: ${dirName}`,
      MARKET_ERROR_CODES.notManaged,
    )
  }
  await fs.rm(target, { recursive: true, force: true })
  clearSkillCaches()

  // Best effort: return the refreshed market entry so the UI can sync state.
  let skill: NormalizedSkill | null = null
  try {
    skill = await resolveMarketSkill(source, slug)
  } catch {
    skill = null
  }
  return { skill, removedPath: target }
}

export function resetInstallLocksForTests(): void {
  inFlight.clear()
}

export { marketCache }
