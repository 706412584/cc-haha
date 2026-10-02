// pdf.js ships its worker entry without type declarations. Only the part the tests
// use to run a worker on the far end of a MessageChannel is described here.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: {
    initializeFromPort(port: unknown): void
  }
}
