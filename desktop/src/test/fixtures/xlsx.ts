import * as XLSX from 'xlsx'

/**
 * Workbooks built in a test, with SheetJS itself: the real writer, so that what the viewer
 * reads back is what a real file holds — merged cells, column widths, hidden sheets, a
 * BIFF8 (.xls) twin — and not a hand-made imitation of it.
 */

export type FixtureSheet = {
  name: string
  /** Cell values, row by row. A cell object gives a type and number format of its own. */
  rows: Array<Array<XLSX.CellObject | string | number | boolean | null>>
  merges?: XLSX.Range[]
  columns?: XLSX.ColInfo[]
  rowInfo?: XLSX.RowInfo[]
  /** 0 = visible, 1 = hidden, 2 = very hidden. */
  hidden?: 0 | 1 | 2
}

export function workbookOf(sheets: FixtureSheet[], bookType: 'xlsx' | 'biff8' | 'xlsm' = 'xlsx'): Uint8Array {
  const book = XLSX.utils.book_new()
  for (const sheet of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows)
    if (sheet.merges) worksheet['!merges'] = sheet.merges
    if (sheet.columns) worksheet['!cols'] = sheet.columns
    if (sheet.rowInfo) worksheet['!rows'] = sheet.rowInfo
    XLSX.utils.book_append_sheet(book, worksheet, sheet.name)
  }
  book.Workbook = { Sheets: sheets.map((sheet) => ({ Hidden: sheet.hidden ?? 0 })) }
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType }))
}

/** A date, a percentage, a currency, and a plain number: the same value, four ways to print it. */
export const FORMATTED_ROW: Array<XLSX.CellObject | string> = [
  { t: 'n', v: 45000, z: 'yyyy-mm-dd' },
  { t: 'n', v: 0.256, z: '0.0%' },
  { t: 'n', v: 1234.5, z: '"¥"#,##0.00' },
  { t: 'n', v: 1234.5 },
]

/** A small results table with a merged title, as a thesis would carry. */
export function resultsWorkbook(): Uint8Array {
  return workbookOf([
    {
      name: '结果 Results',
      rows: [
        ['实验结果 Experimental results', null, null],
        ['组别', '样本量', '均值'],
        ['对照组', 30, 12.5],
        ['实验组', 30, 15.75],
        ['合计', { t: 'n', v: 60, f: 'B3+B4' }, { t: 'n', v: 14.125, f: 'AVERAGE(C3:C4)' }],
        [{ t: 'b', v: true }, { t: 'e', v: 7 }, '<img src=x onerror="window.parent.__cellXss=1">'],
        FORMATTED_ROW,
      ],
      merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
      columns: [{ wpx: 140 }, { wch: 12 }, { hidden: true }],
    },
    { name: 'Hidden data', rows: [['secret']], hidden: 1 },
    { name: 'Second', rows: [['only', 'here'], ['second', 'sheet']] },
  ])
}
