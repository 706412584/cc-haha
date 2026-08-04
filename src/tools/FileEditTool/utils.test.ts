import { describe, expect, test } from 'bun:test'
import { findActualString, preserveIndentationStyle } from './utils.js'

describe('FileEditTool indentation matching', () => {
  test('matches a unique tab-indented line when the model returns spaces', () => {
    const file = '\t\t中文目标：旧值\n\t相邻内容'

    expect(findActualString(file, '    中文目标：旧值')).toBe(
      '\t\t中文目标：旧值',
    )
  })

  test('matches the full file indentation instead of a whitespace suffix', () => {
    expect(
      findActualString(
        '        中文目标：旧值',
        '    中文目标：旧值',
      ),
    ).toBe('        中文目标：旧值')
  })

  test('matches mixed indentation across multiple lines', () => {
    const file = ['function demo() {', '\tif (ready) {', '\t\t运行()', '\t}', '}'].join(
      '\n',
    )
    const search = [
      '  if (ready) {',
      '    运行()',
      '  }',
    ].join('\n')

    expect(findActualString(file, search)).toBe(
      ['\tif (ready) {', '\t\t运行()', '\t}'].join('\n'),
    )
  })

  test('refuses an indentation-insensitive match when the target is ambiguous', () => {
    const file = [
      '\t\t重复目标：只修改其中一行',
      '        重复目标：只修改其中一行',
    ].join('\n')

    expect(findActualString(file, '    重复目标：只修改其中一行')).toBeNull()
  })

  test('prefers exact indentation over a fuzzy alternative', () => {
    const file = '    重复目标\n\t重复目标\n'

    expect(findActualString(file, '    重复目标')).toBe('    重复目标')
  })

  test('preserves the file indentation when the replacement keeps model indentation', () => {
    expect(
      preserveIndentationStyle(
        '    中文目标：旧值',
        '\t\t中文目标：旧值',
        '    中文目标：新值',
      ),
    ).toBe('\t\t中文目标：新值')
  })

  test('keeps an intentional indentation change from the replacement', () => {
    expect(
      preserveIndentationStyle(
        '    中文目标：旧值',
        '\t\t中文目标：旧值',
        '  中文目标：新值',
      ),
    ).toBe('  中文目标：新值')
  })

  test('keeps substring matching for non-indentation whitespace', () => {
    expect(findActualString('前缀 中文目标：旧值', ' 中文目标：旧值')).toBe(
      ' 中文目标：旧值',
    )
  })

  test('keeps quote normalization when indentation fallback does not apply', () => {
    expect(findActualString('const value = “中文”', 'const value = "中文"')).toBe(
      'const value = “中文”',
    )
  })

  test('leaves replacements with a different line count unchanged', () => {
    expect(
      preserveIndentationStyle('  旧值', '\t旧值', '  新值\n  新增值'),
    ).toBe('  新值\n  新增值')
  })

  test('does not transform indentation after an exact match', () => {
    expect(preserveIndentationStyle('\t旧值', '\t旧值', '\t新值')).toBe(
      '\t新值',
    )
  })
})
