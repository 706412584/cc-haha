import { StreamLanguage, type Language, type LanguageSupport } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { shikiLanguageAliases } from './workspaceDiffHighlighter'

/**
 * CodeMirror language resolution for the workspace editor.
 *
 * The editor previously mapped ten extensions by hand, so every other file
 * opened with no language: no token classification, no colour, and the text
 * rendered as one flat run of the theme's default foreground. The read-only
 * preview was unaffected because it highlights through shiki, which is why the
 * same file looked correct in preview and colourless in edit.
 *
 * Extension → language names come from `shikiLanguageAliases`, the same table
 * the preview and diff surfaces resolve through. Reusing it keeps one source of
 * truth: a language added for the preview is automatically recognised here, and
 * the two surfaces can never disagree about what a `.mjs` is.
 *
 * Each loader is a dynamic `import()` so a language only costs a chunk when a
 * file of that type is actually opened; the editor is reachable from the main
 * workspace bundle, so static imports here would pull all of them into it.
 */

/**
 * A grammar is either a full `LanguageSupport` (a `lang-*` package) or a
 * `StreamLanguage` wrapped from a legacy mode. Both are valid compartment
 * contents; only the former carries structure for completion.
 */
type LoadedLanguage = LanguageSupport | Language
type LanguageLoader = () => Promise<LoadedLanguage>

/** Languages with a dedicated `@codemirror/lang-*` package. */
const packageLoaders: Record<string, LanguageLoader> = {
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  jsonc: () => import('@codemirror/lang-json').then((m) => m.json()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
}

/**
 * Languages that only exist as a legacy stream parser. They classify tokens for
 * highlighting but provide no structure for completion or folding, which is the
 * best available for these grammars.
 */
const legacyLoaders: Record<string, () => Promise<LoadedLanguage>> = {
  bash: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  c: () => import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.c)),
  cpp: () => import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.cpp)),
  csharp: () => import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.csharp)),
  dockerfile: () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => StreamLanguage.define(m.dockerFile)),
  kotlin: () => import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.kotlin)),
  lua: () => import('@codemirror/legacy-modes/mode/lua').then((m) => StreamLanguage.define(m.lua)),
  ruby: () => import('@codemirror/legacy-modes/mode/ruby').then((m) => StreamLanguage.define(m.ruby)),
  swift: () => import('@codemirror/legacy-modes/mode/swift').then((m) => StreamLanguage.define(m.swift)),
  toml: () => import('@codemirror/legacy-modes/mode/toml').then((m) => StreamLanguage.define(m.toml)),
}

const loadersByLanguage: Record<string, LanguageLoader> = { ...packageLoaders, ...legacyLoaders }

/** Languages the editor can highlight, for tests and diagnostics. */
export const EDITOR_LANGUAGES = Object.keys(loadersByLanguage)

/**
 * Language names the editor has no grammar for. They still resolve through the
 * alias table (shiki knows them), but there is nothing to load, so the file
 * opens as plain text rather than pretending to be highlighted.
 */
const KNOWN_BUT_UNSUPPORTED = new Set(['graphql', 'less', 'prisma', 'sass', 'scss', 'svelte', 'vue'])

export function editorLanguageNameForPath(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? path
  const lower = name.toLowerCase()
  // Extensionless files that are still a known language.
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile' || lower === '.gitignore') return null
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  const language = shikiLanguageAliases[extension]
  if (!language || language === 'text') return null
  return loadersByLanguage[language] ? language : null
}

/**
 * Resolve a language for a path, or `null` when the file should stay plain.
 *
 * The promise rejects only if the chunk fails to load; callers treat that the
 * same as an unknown language so a broken chunk degrades to unhighlighted text
 * instead of an editor that never mounts.
 */
export async function loadEditorLanguage(path: string): Promise<Extension | null> {
  const language = editorLanguageNameForPath(path)
  if (!language) return null
  return await loadersByLanguage[language]!()
}

/** True when the alias table knows the language but no grammar is available. */
export function isKnownUnsupportedLanguage(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path
  const lower = name.toLowerCase()
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  return KNOWN_BUT_UNSUPPORTED.has(shikiLanguageAliases[extension] ?? '')
}
