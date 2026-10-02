/**
 * A Blob a test can read the bytes of. jsdom's `Blob` has no `arrayBuffer()`,
 * which every browser this app runs in does; the viewers call it, so under jsdom
 * it is supplied here, one fresh copy per call — as the real one returns — since an
 * engine is free to transfer (and so detach) the buffer it is handed.
 */
export function blobWithBytes(bytes: ArrayLike<number>, type = 'application/octet-stream'): Blob {
  const data = Uint8Array.from(bytes)
  const blob = new Blob([data], { type })
  Object.defineProperty(blob, 'arrayBuffer', {
    configurable: true,
    value: async () => data.slice().buffer,
  })
  return blob
}
