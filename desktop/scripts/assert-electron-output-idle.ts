#!/usr/bin/env bun

import { assertElectronOutputIdle } from './electron-output-guard'

const outputDirs = process.argv.slice(2)
if (outputDirs.length === 0) {
  throw new Error('Pass at least one Electron output directory to check')
}

try {
  for (const outputDir of outputDirs) {
    assertElectronOutputIdle(outputDir)
  }
} catch (error) {
  console.error(`[electron-output-guard] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

console.log(`[electron-output-guard] output is idle: ${outputDirs.join(', ')}`)
