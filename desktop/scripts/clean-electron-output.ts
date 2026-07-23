#!/usr/bin/env bun

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { assertElectronOutputIdle } from './electron-output-guard'

const desktopRoot = path.resolve(import.meta.dir, '..')
const electronOutputDir = path.join(desktopRoot, 'build-artifacts', 'electron')
const checkOnly = process.argv.includes('--check-only')

try {
  assertElectronOutputIdle(electronOutputDir)
} catch (error) {
  console.error(`[clean-electron-output] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
if (checkOnly) {
  console.log(`[clean-electron-output] output is idle: ${electronOutputDir}`)
  process.exit(0)
}
await rm(electronOutputDir, { recursive: true, force: true })
console.log(`[clean-electron-output] removed ${electronOutputDir}`)
