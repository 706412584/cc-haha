import { execFileSync } from 'node:child_process'
import path from 'node:path'

export type ProcessSnapshot = {
  pid: number
  command: string
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
}

export function findRunningElectronOutputProcesses(
  outputDir: string,
  processes: readonly ProcessSnapshot[],
): ProcessSnapshot[] {
  const outputPrefix = `${normalizePath(path.resolve(outputDir))}/`
  return processes.filter(({ command }) => {
    const normalizedCommand = normalizePath(command)
    return normalizedCommand.includes(outputPrefix)
      && normalizedCommand.includes('.app/Contents/')
  })
}

export function parseProcessSnapshots(output: string): ProcessSnapshot[] {
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), command: match[2] }]
  })
}

export function readProcessSnapshots(
  platform: NodeJS.Platform = process.platform,
): ProcessSnapshot[] {
  if (platform === 'win32') return []

  const output = execFileSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
  })
  return parseProcessSnapshots(output)
}

export function assertElectronOutputIdle(
  outputDir: string,
  processes: readonly ProcessSnapshot[] = readProcessSnapshots(),
): void {
  const running = findRunningElectronOutputProcesses(outputDir, processes)
  if (running.length === 0) return

  const normalizedOutputPrefix = `${normalizePath(path.resolve(outputDir))}/`
  const processDetails = running
    .slice(0, 3)
    .map(({ pid, command }) => {
      const normalizedCommand = normalizePath(command)
      const relativeCommand = normalizedCommand.slice(
        normalizedCommand.indexOf(normalizedOutputPrefix) + normalizedOutputPrefix.length,
      )
      const executable = relativeCommand.split(' --')[0]
      return `PID ${pid}: ${executable}`
    })
    .join('\n')
  const remaining = running.length > 3
    ? `\n... and ${running.length - 3} more process(es) from this app bundle`
    : ''
  throw new Error([
    'Quit the packaged app before rebuilding it.',
    'Replacing a running .app mixes old and new Electron resources and can break startup.',
    `Electron output: ${path.resolve(outputDir)}`,
    `${processDetails}${remaining}`,
  ].join('\n'))
}
