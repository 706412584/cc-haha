/**
 * Worker entry for pdf.js. Evaluating pdf.js' worker module inside a worker global
 * is what starts it (it wires itself to `self` in a static block), so the whole
 * file is one import. Loaded through Vite's `?worker`, which bundles it into a
 * self-contained script the renderer can start from `file://`, from the packaged
 * app's asar, and from the H5 static host alike.
 */
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
