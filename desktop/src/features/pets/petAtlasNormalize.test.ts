import { describe, expect, it } from 'vitest'
import { PET_ATLAS_V2 } from './petAnimation'
import {
  PET_ATLAS_ROW_FRAME_COUNTS,
  PET_SOURCE_SHEET_COLUMNS,
  PET_SOURCE_SHEET_LAYOUT,
  PET_SOURCE_SHEET_ROWS,
  PET_SOURCE_SHEET_SIZE,
  detectPetSheetShape,
  getAlphaBounds,
  getPetAtlasRowPlan,
  getPetCellPlacement,
  getPetSilhouetteShiftX,
  getPetSourceCellRect,
} from './petAtlasNormalize'

/**
 * The reference values below come from desktop/scripts/assemble-generated-pet-atlas.py,
 * which produced the four built-in pets. Keeping them in a test means a change to the
 * animation definitions surfaces here instead of silently breaking imported pets.
 */
const PYTHON_FRAME_COUNTS = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]
const PYTHON_NINE_ROW_MAPPING = [0, 1, 1, 2, 3, 4, 5, 6, 6, 7, 8]

describe('pet atlas normalization', () => {
  it('derives row frame counts that match the reference assembler', () => {
    expect([...PET_ATLAS_ROW_FRAME_COUNTS]).toEqual(PYTHON_FRAME_COUNTS)
    expect(PET_ATLAS_ROW_FRAME_COUNTS).toHaveLength(PET_ATLAS_V2.rows)
  })

  it('expands nine authored rows into the eleven atlas rows, mirroring only the left run', () => {
    const plan = getPetAtlasRowPlan(PET_SOURCE_SHEET_ROWS)

    expect(plan.map(row => row.sourceRow)).toEqual(PYTHON_NINE_ROW_MAPPING)
    expect(plan.filter(row => row.mirrored).map(row => row.atlasRow)).toEqual([2])
    expect(plan.map(row => row.frameCount)).toEqual(PYTHON_FRAME_COUNTS)
  })

  it('passes an eleven-row sheet straight through without mirroring', () => {
    const plan = getPetAtlasRowPlan(PET_ATLAS_V2.rows)

    expect(plan.map(row => row.sourceRow)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(plan.some(row => row.mirrored)).toBe(false)
  })

  it('rejects sheets that are neither authored nor finished', () => {
    expect(() => getPetAtlasRowPlan(10)).toThrow(RangeError)
    expect(() => getPetAtlasRowPlan(0)).toThrow(RangeError)
  })

  it('describes the nine rows an author has to draw', () => {
    expect(PET_SOURCE_SHEET_LAYOUT.map(row => row.key)).toEqual([
      'idle', 'run', 'wave', 'jump', 'fail', 'wait', 'work', 'look-upper', 'look-lower',
    ])
    // The run row feeds both run-right and run-left, so it needs the wider count.
    expect(PET_SOURCE_SHEET_LAYOUT.map(row => row.frameCount)).toEqual([6, 8, 4, 5, 8, 6, 6, 8, 8])
    expect(PET_SOURCE_SHEET_SIZE).toEqual({ width: 1536, height: 1872 })
  })

  describe('slicing the source grid', () => {
    it('produces seamless cells that cover the whole sheet', () => {
      const width = 1024
      const height = 1152

      for (let row = 0; row < PET_SOURCE_SHEET_ROWS; row += 1) {
        let cursor = 0
        for (let column = 0; column < PET_SOURCE_SHEET_COLUMNS; column += 1) {
          const rect = getPetSourceCellRect(width, height, PET_SOURCE_SHEET_ROWS, row, column)
          expect(rect.x).toBe(cursor)
          cursor += rect.width
        }
        expect(cursor).toBe(width)
      }

      const lastRow = getPetSourceCellRect(width, height, PET_SOURCE_SHEET_ROWS, 8, 0)
      expect(lastRow.y + lastRow.height).toBe(height)
    })

    it('handles sheets whose size is not a multiple of the grid', () => {
      const rect = getPetSourceCellRect(1000, 1000, PET_SOURCE_SHEET_ROWS, 4, 3)

      expect(rect).toEqual({ x: 375, y: 444, width: 125, height: 112 })
    })
  })

  describe('fitting a cell', () => {
    it('scales to fit and centres inside the 192x208 cell', () => {
      expect(getPetCellPlacement(500, 500, 0)).toEqual({ width: 192, height: 192, x: 0, y: 8 })
    })

    it('keeps the artwork inside the gutter', () => {
      expect(getPetCellPlacement(500, 500, 8)).toEqual({ width: 176, height: 176, x: 8, y: 16 })
    })

    it('never collapses a sliver to zero', () => {
      const placement = getPetCellPlacement(4000, 1, 0)

      expect(placement.width).toBeGreaterThanOrEqual(1)
      expect(placement.height).toBeGreaterThanOrEqual(1)
    })
  })

  describe('recentring the silhouette', () => {
    it('pushes an off-centre silhouette toward the middle', () => {
      expect(getPetSilhouetteShiftX({ left: 0, right: 50 }, 0)).toBe(71)
      expect(getPetSilhouetteShiftX({ left: 150, right: 192 }, 0)).toBe(-75)
    })

    it('leaves a centred silhouette alone', () => {
      expect(getPetSilhouetteShiftX({ left: 71, right: 121 }, 0)).toBe(0)
    })

    it('never shifts artwork out past the gutter', () => {
      const shift = getPetSilhouetteShiftX({ left: 0, right: 20 }, 8)

      expect(shift).toBeLessThanOrEqual(PET_ATLAS_V2.cellWidth - 8 - 20)
      expect(0 + shift).toBeGreaterThanOrEqual(8)
    })

    it('ignores a fully transparent frame', () => {
      expect(getPetSilhouetteShiftX(null, 0)).toBe(0)
    })
  })

  describe('alpha bounds', () => {
    it('finds the box around visible pixels with an exclusive far edge', () => {
      const width = 4
      const height = 3
      const data = new Uint8ClampedArray(width * height * 4)
      const setOpaque = (x: number, y: number) => {
        data[(y * width + x) * 4 + 3] = 255
      }
      setOpaque(1, 1)
      setOpaque(2, 2)

      expect(getAlphaBounds(data, width, height)).toEqual({ left: 1, top: 1, right: 3, bottom: 3 })
    })

    it('returns null when nothing is visible', () => {
      expect(getAlphaBounds(new Uint8ClampedArray(4 * 4), 2, 2)).toBeNull()
    })
  })

  describe('detecting the sheet shape', () => {
    it('treats an exact v2 atlas as finished artwork', () => {
      expect(detectPetSheetShape(PET_ATLAS_V2.width, PET_ATLAS_V2.height)).toEqual({
        sourceRows: PET_ATLAS_V2.rows,
        passthrough: true,
      })
    })

    it('treats everything else as a nine-row action sheet', () => {
      for (const [width, height] of [[1024, 1152], [1536, 1872], [800, 900], [1536, 2287]]) {
        expect(detectPetSheetShape(width!, height!)).toEqual({
          sourceRows: PET_SOURCE_SHEET_ROWS,
          passthrough: false,
        })
      }
    })
  })
})
