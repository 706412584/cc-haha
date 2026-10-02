/**
 * Where pdf.js finds the data it reads at run time, by URL, when a document needs
 * it: CMaps (the glyph tables of CJK fonts that a PDF names but does not embed),
 * the 14 standard fonts, wasm image decoders and ICC colour profiles. Without them
 * a Chinese PDF renders as blanks or boxes, and nothing in the build or the type
 * checker says so.
 *
 * Shared by the engine, which asks for these folders, and the Vite plugin
 * (`scripts/vite-pdfjs-assets.ts`), which ships them: the two cannot drift apart.
 * Plain data on purpose, so the build script can import it without a DOM.
 */

/** pdf.js' `getDocument` option that takes a folder URL, and the folder in pdfjs-dist it names. */
export const PDFJS_ASSET_FOLDERS = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
  iccUrl: 'iccs',
} as const

/** The pdfjs-dist folders that ship with the app. */
export const PDFJS_ASSET_DIRS = Object.values(PDFJS_ASSET_FOLDERS)

/**
 * Where the folders are served, relative to the app. The version is in the name, so
 * an upgrade cannot be served the previous version's data from a cache.
 */
export function pdfjsAssetsPrefix(version: string): string {
  return `assets/pdfjs-${version}/`
}
