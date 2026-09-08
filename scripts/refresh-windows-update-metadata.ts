#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, relative, resolve } from 'node:path'
import { parse, stringify } from 'yaml'

type UpdateFileMetadata = {
  url?: string
  sha512?: string
  sha2?: string
  size?: number
  [key: string]: unknown
}

type UpdateMetadata = {
  files?: UpdateFileMetadata[]
  path?: string
  sha512?: string
  sha2?: string
  [key: string]: unknown
}

export type RefreshWindowsUpdateMetadataOptions = {
  installerPath: string
  metadataPath: string
}

export type RefreshWindowsUpdateMetadataResult = {
  installerName: string
  sha512: string
  size: number
}

type AppBuilderModule = {
  executeAppBuilderAsJson(args: string[]): Promise<unknown>
}

function usage() {
  return 'Usage: bun run scripts/refresh-windows-update-metadata.ts --installer <path> --metadata <path>'
}

function readArgValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}\n${usage()}`)
  }
  return value
}

function parseArgs(argv: string[]): RefreshWindowsUpdateMetadataOptions {
  let installerPath: string | undefined
  let metadataPath: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--installer') {
      installerPath = readArgValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg === '--metadata') {
      metadataPath = readArgValue(argv, index, arg)
      index += 1
    }
  }

  if (!installerPath || !metadataPath) {
    throw new Error(usage())
  }

  return { installerPath, metadataPath }
}

function fileNameFromUrl(url: string) {
  return url.replace(/\\/g, '/').split('/').at(-1)
}

async function sha512File(filePath: string) {
  const hash = createHash('sha512')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolvePromise)
  })
  return hash.digest('base64')
}

export async function rebuildWindowsInstallerBlockmap(installerPath: string) {
  const resolvedInstallerPath = resolve(installerPath)
  const moduleCandidates = [
    resolve('desktop/node_modules/app-builder-lib/out/util/appBuilder.js'),
    resolve('node_modules/app-builder-lib/out/util/appBuilder.js'),
  ]
  const modulePath = moduleCandidates.find(existsSync)
  if (!modulePath) {
    throw new Error('Cannot find app-builder-lib; install desktop dependencies before rebuilding the blockmap')
  }

  const require = createRequire(import.meta.url)
  const { executeAppBuilderAsJson } = require(modulePath) as AppBuilderModule
  await executeAppBuilderAsJson([
    'blockmap',
    '--input',
    resolvedInstallerPath,
    '--output',
    `${resolvedInstallerPath}.blockmap`,
  ])
}

function readMetadata(filePath: string): UpdateMetadata {
  const parsed = parse(readFileSync(filePath, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Update metadata must be a YAML object: ${filePath}`)
  }
  return parsed as UpdateMetadata
}

export async function refreshWindowsUpdateMetadata(
  options: RefreshWindowsUpdateMetadataOptions,
): Promise<RefreshWindowsUpdateMetadataResult> {
  const installerPath = resolve(options.installerPath)
  const metadataPath = resolve(options.metadataPath)
  const installerName = basename(installerPath)
  const metadata = readMetadata(metadataPath)
  const matchingFiles = Array.isArray(metadata.files)
    ? metadata.files.filter(file => file.url && fileNameFromUrl(file.url) === installerName)
    : []

  if (matchingFiles.length !== 1) {
    throw new Error(
      `Expected exactly one update file for ${installerName} in ${metadataPath}, found ${matchingFiles.length}`,
    )
  }
  if (!metadata.path || fileNameFromUrl(metadata.path) !== installerName) {
    throw new Error(`Primary update path does not reference ${installerName} in ${metadataPath}`)
  }

  const size = statSync(installerPath).size
  const sha512 = await sha512File(installerPath)
  const [file] = matchingFiles
  file.sha512 = sha512
  file.size = size
  delete file.sha2
  metadata.sha512 = sha512
  delete metadata.sha2
  writeFileSync(metadataPath, stringify(metadata))

  return { installerName, sha512, size }
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2))
    await rebuildWindowsInstallerBlockmap(options.installerPath)
    const result = await refreshWindowsUpdateMetadata(options)
    console.log(
      `[refresh-windows-update-metadata] updated ${relative(process.cwd(), resolve(options.metadataPath))} for ${result.installerName} (${result.size} bytes)`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
