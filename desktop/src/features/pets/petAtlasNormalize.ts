import {
  PET_ANIMATION_DEFINITIONS,
  PET_ANIMATION_STATES,
  PET_ATLAS_V2,
  PET_LOOK_DIRECTIONS,
  PET_NEUTRAL_LOOK_FRAME,
} from './petAnimation'

/**
 * Turns a hand-drawn or image-generated action sheet into the exact v2 atlas the
 * renderer expects. Authors only have to supply the nine distinct action rows;
 * the mirrored run row, the reused review row and the neutral look frame are all
 * derived here. Mirrors desktop/scripts/assemble-generated-pet-atlas.py.
 */

/** Frames the renderer actually samples per atlas row, derived from the playback definitions. */
export const PET_ATLAS_ROW_FRAME_COUNTS: readonly number[] = (() => {
  const counts = new Array<number>(PET_ATLAS_V2.rows).fill(0)
  for (const state of PET_ANIMATION_STATES) {
    const definition = PET_ANIMATION_DEFINITIONS[state]
    counts[definition.rowIndex] = definition.frameDurationsMs.length
  }
  const lookRowCount = PET_LOOK_DIRECTIONS.length / PET_ATLAS_V2.columns
  for (let offset = 0; offset < lookRowCount; offset += 1) {
    counts[PET_ATLAS_V2.rows - lookRowCount + offset] = PET_ATLAS_V2.columns
  }
  return counts
})()

export type PetSourceSheetRow = Readonly<{
  /** Row index inside the author's source sheet. */
  sourceRow: number
  /** Stable key used for i18n lookups and template labels. */
  key: 'idle' | 'run' | 'wave' | 'jump' | 'fail' | 'wait' | 'work' | 'look-upper' | 'look-lower'
  /** Frames the author must draw for this row. */
  frameCount: number
}>

/**
 * Atlas row -> source row. Row 2 re-uses the run row mirrored, row 8 (review)
 * re-uses the work row, so the author draws nine rows instead of eleven.
 */
const NINE_ROW_MAPPING = [0, 1, 1, 2, 3, 4, 5, 6, 6, 7, 8] as const

const SOURCE_ROW_KEYS = [
  'idle',
  'run',
  'wave',
  'jump',
  'fail',
  'wait',
  'work',
  'look-upper',
  'look-lower',
] as const satisfies readonly PetSourceSheetRow['key'][]

export const PET_SOURCE_SHEET_ROWS = SOURCE_ROW_KEYS.length

export const PET_SOURCE_SHEET_COLUMNS = PET_ATLAS_V2.columns

/** Per-row drawing brief handed to the author (and rendered into the template image). */
export const PET_SOURCE_SHEET_LAYOUT: readonly PetSourceSheetRow[] = SOURCE_ROW_KEYS.map(
  (key, sourceRow) => ({
    sourceRow,
    key,
    frameCount: NINE_ROW_MAPPING.reduce<number>(
      (widest, mappedSourceRow, atlasRow) => (
        mappedSourceRow === sourceRow
          ? Math.max(widest, PET_ATLAS_ROW_FRAME_COUNTS[atlasRow] ?? 0)
          : widest
      ),
      0,
    ),
  }),
)

export type PetAtlasRowPlan = Readonly<{
  atlasRow: number
  sourceRow: number
  mirrored: boolean
  frameCount: number
}>

/**
 * Builds the atlas assembly plan. An eleven-row sheet is copied straight through;
 * a nine-row sheet is expanded via NINE_ROW_MAPPING with the left-run row mirrored.
 */
export function getPetAtlasRowPlan(sourceRows: number): readonly PetAtlasRowPlan[] {
  if (sourceRows !== PET_SOURCE_SHEET_ROWS && sourceRows !== PET_ATLAS_V2.rows) {
    throw new RangeError(`sourceRows must be ${PET_SOURCE_SHEET_ROWS} or ${PET_ATLAS_V2.rows}`)
  }
  const passthrough = sourceRows === PET_ATLAS_V2.rows
  return NINE_ROW_MAPPING.map((mappedSourceRow, atlasRow) => ({
    atlasRow,
    sourceRow: passthrough ? atlasRow : mappedSourceRow,
    mirrored: !passthrough && atlasRow === PET_ANIMATION_DEFINITIONS['running-left'].rowIndex,
    frameCount: PET_ATLAS_ROW_FRAME_COUNTS[atlasRow] ?? 0,
  }))
}

export type PetSourceCellRect = Readonly<{
  x: number
  y: number
  width: number
  height: number
}>

/**
 * Slices the source sheet on an even grid. Rounding each edge independently (rather
 * than multiplying a rounded cell size) keeps cells seamless on sheets whose
 * dimensions are not a clean multiple of the grid.
 */
export function getPetSourceCellRect(
  sourceWidth: number,
  sourceHeight: number,
  sourceRows: number,
  row: number,
  column: number,
): PetSourceCellRect {
  const left = Math.round((column * sourceWidth) / PET_SOURCE_SHEET_COLUMNS)
  const right = Math.round(((column + 1) * sourceWidth) / PET_SOURCE_SHEET_COLUMNS)
  const top = Math.round((row * sourceHeight) / sourceRows)
  const bottom = Math.round(((row + 1) * sourceHeight) / sourceRows)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export type PetCellPlacement = Readonly<{
  width: number
  height: number
  x: number
  y: number
}>

/** Fits a source cell inside a 192x208 atlas cell, preserving aspect ratio and centring it. */
export function getPetCellPlacement(
  cellWidth: number,
  cellHeight: number,
  gutter: number,
): PetCellPlacement {
  const availableWidth = PET_ATLAS_V2.cellWidth - gutter * 2
  const availableHeight = PET_ATLAS_V2.cellHeight - gutter * 2
  const scale = Math.min(availableWidth / cellWidth, availableHeight / cellHeight)
  const width = Math.max(1, Math.round(cellWidth * scale))
  const height = Math.max(1, Math.round(cellHeight * scale))
  return {
    width,
    height,
    x: Math.floor((PET_ATLAS_V2.cellWidth - width) / 2),
    y: Math.floor((PET_ATLAS_V2.cellHeight - height) / 2),
  }
}

/**
 * Horizontal shift that centres the visible silhouette, clamped so the artwork can
 * never leave the gutter. Generated art rarely sits on the cell centre, and an
 * off-centre silhouette makes the sprite jitter as frames advance.
 */
export function getPetSilhouetteShiftX(
  alphaBounds: Readonly<{ left: number, right: number }> | null,
  gutter: number,
): number {
  if (!alphaBounds) return 0
  const { left, right } = alphaBounds
  const desiredShift = Math.round(PET_ATLAS_V2.cellWidth / 2 - (left + right) / 2)
  const minShift = gutter - left
  const maxShift = PET_ATLAS_V2.cellWidth - gutter - right
  return Math.max(minShift, Math.min(maxShift, desiredShift))
}

/** Bounding box of non-transparent pixels; `right`/`bottom` are exclusive. */
export function getAlphaBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { left: number, top: number, right: number, bottom: number } | null {
  let left = width
  let top = height
  let right = 0
  let bottom = 0
  let found = false
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] === 0) continue
      found = true
      if (x < left) left = x
      if (x >= right) right = x + 1
      if (y < top) top = y
      if (y >= bottom) bottom = y + 1
    }
  }
  return found ? { left, top, right, bottom } : null
}

export type PetAtlasNormalizeOptions = Readonly<{
  /** Rows in the supplied sheet: 9 (authored) or 11 (already expanded). */
  sourceRows?: number
  /** Inset every cell by this many pixels so strokes near the edge are not clipped. */
  gutter?: number
  /** Re-centre each silhouette horizontally after fitting. */
  recenterX?: boolean
}>

export const PET_ATLAS_MAX_GUTTER = 32

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not acquire a 2D canvas context')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

/**
 * Assembles the finished 1536x2288 atlas. The caller supplies an already-decoded
 * image so this stays synchronous and testable.
 */
export function normalizePetSheetToAtlas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  options: PetAtlasNormalizeOptions = {},
): HTMLCanvasElement {
  const sourceRows = options.sourceRows ?? PET_SOURCE_SHEET_ROWS
  const gutter = Math.max(0, Math.min(PET_ATLAS_MAX_GUTTER, Math.trunc(options.gutter ?? 0)))
  const recenterX = options.recenterX ?? true

  const atlas = createCanvas(PET_ATLAS_V2.width, PET_ATLAS_V2.height)
  const atlasCtx = context2d(atlas)
  const cell = createCanvas(PET_ATLAS_V2.cellWidth, PET_ATLAS_V2.cellHeight)
  const cellCtx = context2d(cell)

  const renderCell = (row: number, column: number, mirrored: boolean): number => {
    cellCtx.clearRect(0, 0, PET_ATLAS_V2.cellWidth, PET_ATLAS_V2.cellHeight)
    const rect = getPetSourceCellRect(sourceWidth, sourceHeight, sourceRows, row, column)
    if (rect.width <= 0 || rect.height <= 0) return 0
    const placement = getPetCellPlacement(rect.width, rect.height, gutter)

    cellCtx.save()
    if (mirrored) {
      cellCtx.translate(placement.x * 2 + placement.width, 0)
      cellCtx.scale(-1, 1)
    }
    cellCtx.drawImage(
      source,
      rect.x, rect.y, rect.width, rect.height,
      placement.x, placement.y, placement.width, placement.height,
    )
    cellCtx.restore()

    if (!recenterX) return 0
    const { data } = cellCtx.getImageData(0, 0, PET_ATLAS_V2.cellWidth, PET_ATLAS_V2.cellHeight)
    const bounds = getAlphaBounds(data, PET_ATLAS_V2.cellWidth, PET_ATLAS_V2.cellHeight)
    return getPetSilhouetteShiftX(bounds, gutter)
  }

  for (const plan of getPetAtlasRowPlan(sourceRows)) {
    for (let column = 0; column < plan.frameCount; column += 1) {
      const shiftX = renderCell(plan.sourceRow, column, plan.mirrored)
      atlasCtx.drawImage(
        cell,
        column * PET_ATLAS_V2.cellWidth + shiftX,
        plan.atlasRow * PET_ATLAS_V2.cellHeight,
      )
    }
  }

  // The renderer parks the pet on row 0 / column 6 whenever the pointer is away.
  const neutralShiftX = renderCell(0, 0, false)
  atlasCtx.drawImage(cell, PET_NEUTRAL_LOOK_FRAME.x + neutralShiftX, PET_NEUTRAL_LOOK_FRAME.y)

  return atlas
}

export type PetAtlasSourceShape = Readonly<{
  sourceRows: number
  /** True when the sheet already carries all eleven atlas rows. */
  passthrough: boolean
}>

/**
 * Guesses whether a sheet holds nine authored rows or eleven finished ones.
 * An exact 1536x2288 sheet is already a valid atlas, so it is passed through
 * untouched — re-slicing it would resample finished artwork for nothing.
 * Everything else is treated as a nine-row action sheet, which is what the
 * documented workflow produces.
 */
export function detectPetSheetShape(width: number, height: number): PetAtlasSourceShape {
  if (width === PET_ATLAS_V2.width && height === PET_ATLAS_V2.height) {
    return { sourceRows: PET_ATLAS_V2.rows, passthrough: true }
  }
  return { sourceRows: PET_SOURCE_SHEET_ROWS, passthrough: false }
}

/** Aspect ratio the authored nine-row sheet should aim for (8x192 by 9x208). */
export const PET_SOURCE_SHEET_ASPECT_RATIO =
  (PET_SOURCE_SHEET_COLUMNS * PET_ATLAS_V2.cellWidth)
  / (PET_SOURCE_SHEET_ROWS * PET_ATLAS_V2.cellHeight)

/** Suggested pixel size for the authored sheet, matching the atlas cell grid exactly. */
export const PET_SOURCE_SHEET_SIZE = {
  width: PET_SOURCE_SHEET_COLUMNS * PET_ATLAS_V2.cellWidth,
  height: PET_SOURCE_SHEET_ROWS * PET_ATLAS_V2.cellHeight,
} as const
