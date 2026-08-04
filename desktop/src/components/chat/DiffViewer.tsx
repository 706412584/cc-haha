import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { Highlight, type PrismTheme } from 'prism-react-renderer'
import { CopyButton } from '@/components/ui/CopyButton'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'

type Props = {
  filePath: string
  oldString: string
  newString: string
}

function inferLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', css: 'css', html: 'markup', xml: 'markup',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  }
  return langMap[ext ?? ''] || 'text'
}

/** Shared warm syntax theme — must stay in sync with CodeViewer */
const warmSyntaxTheme: PrismTheme = {
  plain: {
    color: 'var(--color-code-fg)',
    backgroundColor: 'transparent',
  },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--color-code-comment)', fontStyle: 'italic' as const } },
    { types: ['string', 'attr-value', 'template-string'], style: { color: 'var(--color-code-string)' } },
    { types: ['keyword', 'selector', 'important', 'atrule'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['function'], style: { color: 'var(--color-code-function)' } },
    { types: ['tag'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['number', 'boolean'], style: { color: 'var(--color-code-number)' } },
    { types: ['operator'], style: { color: 'var(--color-code-fg)' } },
    { types: ['punctuation'], style: { color: 'var(--color-code-punctuation)' } },
    { types: ['variable', 'parameter'], style: { color: 'var(--color-code-fg)' } },
    { types: ['property', 'attr-name'], style: { color: 'var(--color-code-property)' } },
    { types: ['builtin', 'class-name', 'constant', 'symbol'], style: { color: 'var(--color-code-type)' } },
    { types: ['regex'], style: { color: 'var(--color-primary-container)' } },
    { types: ['inserted'], style: { color: 'var(--color-code-inserted)' } },
    { types: ['deleted'], style: { color: 'var(--color-code-deleted)' } },
  ],
}

function highlightSyntax(str: string, language: string) {
  return (
    <Highlight theme={warmSyntaxTheme} code={str} language={language}>
      {({ tokens, getTokenProps }) => (
        <>
          {tokens.map((line, i) => (
            <span key={i}>
              {line.map((token, key) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </span>
          ))}
        </>
      )}
    </Highlight>
  )
}

const diffStyles = {
  variables: {
    light: {
      diffViewerBackground: 'var(--color-code-bg)',
      diffViewerColor: 'var(--color-code-fg)',
      addedBackground: 'var(--color-diff-added-bg)',
      addedColor: 'var(--color-code-fg)',
      removedBackground: 'var(--color-diff-removed-bg)',
      removedColor: 'var(--color-code-fg)',
      wordAddedBackground: 'var(--color-diff-added-word)',
      wordRemovedBackground: 'var(--color-diff-removed-word)',
      addedGutterBackground: 'var(--color-diff-added-gutter)',
      removedGutterBackground: 'var(--color-diff-removed-gutter)',
      gutterBackground: 'var(--color-surface-container-low)',
      gutterBackgroundDark: 'var(--color-surface-container)',
      highlightBackground: 'var(--color-diff-highlight-bg)',
      highlightGutterBackground: 'var(--color-diff-highlight-gutter)',
      codeFoldGutterBackground: 'var(--color-surface-container-high)',
      codeFoldBackground: 'var(--color-surface-container-highest)',
      emptyLineBackground: 'var(--color-surface-container-low)',
      gutterColor: 'var(--color-text-tertiary)',
      addedGutterColor: 'var(--color-diff-added-text)',
      removedGutterColor: 'var(--color-diff-removed-text)',
      codeFoldContentColor: 'var(--color-text-tertiary)',
      diffViewerTitleBackground: 'var(--color-diff-title-bg)',
      diffViewerTitleColor: 'var(--color-diff-title-color)',
      diffViewerTitleBorderColor: 'var(--color-diff-title-border)',
    },
  },
  diffContainer: {
    borderRadius: '0',
    fontSize: '13px',
    lineHeight: '1.7',
    fontFamily: 'var(--font-mono)',
  },
  line: {
    padding: '0',
  },
  gutter: {
    padding: '0 10px',
    minWidth: '44px',
    fontSize: '12px',
  },
  wordDiff: {
    padding: '1px 2px',
    borderRadius: '2px',
  },
}

export function DiffViewer({ filePath, oldString, newString }: Props) {
  const t = useTranslation()
  const theme = useUIStore((state) => state.theme)
  const language = inferLanguage(filePath)

  const oldLines = oldString.split('\n')
  const newLines = newString.split('\n')
  const additions = newLines.filter((l, i) => l !== (oldLines[i] ?? null)).length
  const deletions = oldLines.filter((l, i) => l !== (newLines[i] ?? null)).length

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-code-bg)]">
      {/* Header — mono path on the left, Copy path chip on the right */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--color-text-secondary)]">
          {filePath}
        </span>
        <CopyButton
          text={`--- ${filePath}\n+++ ${filePath}`}
          label={t('chat.copyPath')}
          className="shrink-0 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-1 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        />
      </div>

      {/* Change counts */}
      <div className="flex gap-2 px-3.5 pb-2 font-mono text-[12px] font-semibold">
        <span className="rounded-[var(--radius-sm)] bg-[var(--color-diff-added-gutter)] px-2 py-0.5 text-[var(--color-diff-added-text)]">+{additions}</span>
        <span className="rounded-[var(--radius-sm)] bg-[var(--color-diff-removed-gutter)] px-2 py-0.5 text-[var(--color-diff-removed-text)]">-{deletions}</span>
      </div>

      {/* Diff area */}
      <div className="max-h-[400px] overflow-auto">
        <ReactDiffViewer
          oldValue={oldString}
          newValue={newString}
          splitView={false}
          compareMethod={DiffMethod.WORDS}
          renderContent={(str) => highlightSyntax(str, language)}
          hideLineNumbers={false}
          styles={diffStyles}
          useDarkTheme={theme === 'dark'}
        />
      </div>
    </div>
  )
}
