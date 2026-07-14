import { normalizeTokens, Prism } from 'prism-react-renderer'
import type { WorkspaceDiffFile, WorkspaceDiffRow } from './workspaceDiffModel'

export const WORKSPACE_DIFF_TOKENIZE_MAX_LINE_LENGTH = 1_000
const WORKSPACE_DIFF_WORD_MAX_SEGMENTS = 240
const WORKSPACE_DIFF_WORD_MIN_SIMILARITY = 0.6

export interface WorkspaceDiffHighlightToken {
  content: string
  color?: string
  fontStyle?: number
}

export interface WorkspaceDiffWordRange {
  start: number
  end: number
}

export interface WorkspaceDiffHighlightResult {
  engine: 'prism' | 'plain'
  tokensByRowId: Record<string, WorkspaceDiffHighlightToken[]>
  wordRangesByRowId: Record<string, WorkspaceDiffWordRange[]>
}

interface WordSegment extends WorkspaceDiffWordRange {
  text: string
}

const workspaceDiffSyntaxColors: Record<string, string> = {
  comment: 'var(--color-diff-syntax-comment)',
  cdata: 'var(--color-diff-syntax-comment)',
  doctype: 'var(--color-diff-syntax-comment)',
  prolog: 'var(--color-diff-syntax-comment)',
  string: 'var(--color-diff-syntax-string)',
  'attr-value': 'var(--color-diff-syntax-string)',
  'template-string': 'var(--color-diff-syntax-string)',
  regex: 'var(--color-diff-syntax-regexp)',
  boolean: 'var(--color-diff-syntax-number)',
  number: 'var(--color-diff-syntax-number)',
  keyword: 'var(--color-diff-syntax-keyword)',
  tag: 'var(--color-diff-syntax-keyword)',
  function: 'var(--color-diff-syntax-function)',
  builtin: 'var(--color-diff-syntax-type)',
  'class-name': 'var(--color-diff-syntax-type)',
  parameter: 'var(--color-diff-syntax-parameter)',
  property: 'var(--color-diff-syntax-property)',
  'attr-name': 'var(--color-diff-syntax-property)',
  constant: 'var(--color-diff-syntax-variable)',
  symbol: 'var(--color-diff-syntax-variable)',
  variable: 'var(--color-diff-syntax-variable)',
  operator: 'var(--color-diff-syntax-punctuation)',
  punctuation: 'var(--color-diff-syntax-punctuation)',
}

const workspaceDiffPrismLanguages = new Set([
  'bash',
  'c',
  'cpp',
  'css',
  'go',
  'graphql',
  'html',
  'javascript',
  'json',
  'jsx',
  'kotlin',
  'markdown',
  'python',
  'rust',
  'sql',
  'swift',
  'tsx',
  'typescript',
  'xml',
  'yaml',
])

const prismLanguageAliases: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  dockerfile: 'dockerfile',
  go: 'go',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  kotlin: 'kotlin',
  kt: 'kotlin',
  less: 'less',
  lua: 'lua',
  markdown: 'markdown',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  prisma: 'prisma',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  rs: 'rust',
  rust: 'rust',
  sass: 'sass',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

function basename(path: string) {
  return path.split('/').pop()?.toLowerCase() ?? path.toLowerCase()
}

export function getWorkspaceDiffPrismLanguage(path: string) {
  const name = basename(path)
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  if (name === '.gitignore') return 'text'
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return prismLanguageAliases[extension] ?? 'text'
}

function tokenizeWords(value: string): WordSegment[] {
  const segments: WordSegment[] = []
  const pattern = /\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value))) {
    segments.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return segments
}

function mergeRanges(value: string, ranges: WorkspaceDiffWordRange[]) {
  const sorted = [...ranges].sort((left, right) => left.start - right.start)
  const merged: WorkspaceDiffWordRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && /^\s*$/.test(value.slice(previous.end, range.start))) {
      previous.end = range.end
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function diffWordRanges(oldValue: string, newValue: string) {
  if (
    oldValue.length > WORKSPACE_DIFF_TOKENIZE_MAX_LINE_LENGTH
    || newValue.length > WORKSPACE_DIFF_TOKENIZE_MAX_LINE_LENGTH
  ) return null

  const oldSegments = tokenizeWords(oldValue)
  const newSegments = tokenizeWords(newValue)
  if (
    oldSegments.length > WORKSPACE_DIFF_WORD_MAX_SEGMENTS
    || newSegments.length > WORKSPACE_DIFF_WORD_MAX_SEGMENTS
  ) return null

  const matrix = Array.from(
    { length: oldSegments.length + 1 },
    () => new Uint16Array(newSegments.length + 1),
  )
  for (let oldIndex = oldSegments.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newSegments.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex]![newIndex] = oldSegments[oldIndex]!.text === newSegments[newIndex]!.text
        ? matrix[oldIndex + 1]![newIndex + 1]! + 1
        : Math.max(matrix[oldIndex + 1]![newIndex]!, matrix[oldIndex]![newIndex + 1]!)
    }
  }

  const matchedOld = new Set<number>()
  const matchedNew = new Set<number>()
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldSegments.length && newIndex < newSegments.length) {
    if (oldSegments[oldIndex]!.text === newSegments[newIndex]!.text) {
      matchedOld.add(oldIndex)
      matchedNew.add(newIndex)
      oldIndex += 1
      newIndex += 1
    } else if (matrix[oldIndex + 1]![newIndex]! >= matrix[oldIndex]![newIndex + 1]!) {
      oldIndex += 1
    } else {
      newIndex += 1
    }
  }

  const oldMeaningfulCount = oldSegments.filter((segment) => !/^\s+$/.test(segment.text)).length
  const newMeaningfulCount = newSegments.filter((segment) => !/^\s+$/.test(segment.text)).length
  const matchedMeaningfulCount = [...matchedOld]
    .filter((index) => !/^\s+$/.test(oldSegments[index]!.text))
    .length
  const similarity = oldMeaningfulCount + newMeaningfulCount === 0
    ? 1
    : (2 * matchedMeaningfulCount) / (oldMeaningfulCount + newMeaningfulCount)
  if (similarity < WORKSPACE_DIFF_WORD_MIN_SIMILARITY) return null

  const toRanges = (value: string, segments: WordSegment[], matched: Set<number>) => mergeRanges(
    value,
    segments.flatMap((segment, index) => (
      matched.has(index) || /^\s+$/.test(segment.text)
        ? []
        : [{ start: segment.start, end: segment.end }]
    )),
  )

  return {
    oldRanges: toRanges(oldValue, oldSegments, matchedOld),
    newRanges: toRanges(newValue, newSegments, matchedNew),
  }
}

function flushChangeGroup(
  deletions: WorkspaceDiffRow[],
  additions: WorkspaceDiffRow[],
  rangesByRowId: Record<string, WorkspaceDiffWordRange[]>,
) {
  if (deletions.length !== additions.length) {
    deletions.length = 0
    additions.length = 0
    return
  }
  const pairCount = Math.min(deletions.length, additions.length)
  for (let index = 0; index < pairCount; index += 1) {
    const deletion = deletions[index]!
    const addition = additions[index]!
    const ranges = diffWordRanges(deletion.text, addition.text)
    if (!ranges) continue
    if (ranges.oldRanges.length > 0) rangesByRowId[deletion.id] = ranges.oldRanges
    if (ranges.newRanges.length > 0) rangesByRowId[addition.id] = ranges.newRanges
  }
  deletions.length = 0
  additions.length = 0
}

export function buildWorkspaceDiffWordRanges(files: WorkspaceDiffFile[]) {
  const rangesByRowId: Record<string, WorkspaceDiffWordRange[]> = {}
  for (const file of files) {
    const deletions: WorkspaceDiffRow[] = []
    const additions: WorkspaceDiffRow[] = []
    let activeHunkId: string | null = null

    for (const row of file.rows) {
      const isChange = row.kind === 'deletion' || row.kind === 'addition'
      if (!isChange || row.hunkId !== activeHunkId) {
        flushChangeGroup(deletions, additions, rangesByRowId)
        activeHunkId = isChange ? row.hunkId : null
      }
      if (row.kind === 'deletion') deletions.push(row)
      else if (row.kind === 'addition') additions.push(row)
    }
    flushChangeGroup(deletions, additions, rangesByRowId)
  }
  return rangesByRowId
}

function getHighlightDocuments(file: WorkspaceDiffFile) {
  const documents: Array<{ rows: WorkspaceDiffRow[]; path: string }> = []
  const hunkIds = [...new Set(file.rows.flatMap((row) => row.hunkId ? [row.hunkId] : []))]
  const path = file.newPath ?? file.oldPath ?? ''
  for (const hunkId of hunkIds) {
    const hunkRows = file.rows.filter((row) => row.hunkId === hunkId && row.selectable)
    const oldRows = hunkRows.filter((row) => row.kind === 'context' || row.kind === 'deletion')
    const newRows = hunkRows.filter((row) => row.kind === 'context' || row.kind === 'addition')
    if (oldRows.length > 0) documents.push({ rows: oldRows, path: file.oldPath ?? path })
    if (newRows.length > 0) documents.push({ rows: newRows, path: file.newPath ?? path })
  }
  return documents
}

export async function highlightWorkspaceDiff({
  files,
  path,
}: {
  files: WorkspaceDiffFile[]
  path: string
}): Promise<WorkspaceDiffHighlightResult> {
  const tokensByRowId: Record<string, WorkspaceDiffHighlightToken[]> = {}
  const wordRangesByRowId = buildWorkspaceDiffWordRanges(files)

  try {
    for (const file of files) {
      for (const document of getHighlightDocuments(file)) {
        const language = getWorkspaceDiffPrismLanguage(document.path || path)
        const grammar = (
          workspaceDiffPrismLanguages.has(language)
            ? Prism.languages[language]
            : undefined
        ) ?? Prism.languages.text
        if (!grammar) continue
        const lines = normalizeTokens(Prism.tokenize(
          document.rows.map((row) => row.text).join('\n'),
          grammar,
        ))
        document.rows.forEach((row, index) => {
          tokensByRowId[row.id] = (lines[index] ?? []).map((token) => ({
            content: token.content,
            color: token.types.map((type) => workspaceDiffSyntaxColors[type]).find(Boolean),
            fontStyle: token.types.includes('italic') ? 1 : token.types.includes('bold') ? 2 : undefined,
          }))
        })
      }
    }
    return { engine: 'prism', tokensByRowId, wordRangesByRowId }
  } catch {
    return { engine: 'plain', tokensByRowId: {}, wordRangesByRowId }
  }
}
