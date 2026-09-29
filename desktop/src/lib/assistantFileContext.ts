import { parseFilePathRef } from './filePathBoundary'

/** Only an explicit project/output directory declaration establishes a prose base. */
function declaredDirectories(content: string): string[] {
  const withoutFences = content.replace(/```[^]*?```|~~~[^]*?~~~/g, (block) => ' '.repeat(block.length))
  const pattern = /(?:项目根目录|项目目录|输出目录|project\s+root(?:\s+directory)?|output\s+directory)\s*(?:是|为|在|is|at|[:：])\s*[:：]?\s*(?:`([^`\n]+)`|((?:\/|[A-Za-z]:[\\/])[^\s，。；：]+))/giu
  return [...withoutFences.matchAll(pattern)].flatMap((match) => {
    const path = (match[1] ?? match[2] ?? '').trim().replaceAll('\\', '/')
    return /^(?:\/|[A-Za-z]:\/)/.test(path) && !/[\r\n]/.test(path)
      ? [path.replace(/\/+$/, '')]
      : []
  })
}

/** A single declared root applies to the whole reply, including prose and cards. */
export function resolveAssistantFileHref(href: string, content: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|\\\\|~[\\/])/i.test(href) || !parseFilePathRef(href)) return href
  const directories = declaredDirectories(content)
  if (directories.length === 0) return href
  if (new Set(directories).size !== 1) return href
  return `${directories[0]}/${href.replace(/^\.\//, '')}`
}
