import { describe, expect, it } from 'bun:test'
import { contentTypeForPath } from '../api/previewFs.js'

describe('contentTypeForPath', () => {
  it('announces a PDF as one, so a browser surface renders it instead of downloading it', () => {
    expect(contentTypeForPath('/w/report.pdf')).toBe('application/pdf')
    expect(contentTypeForPath('/w/REPORT.PDF')).toBe('application/pdf')
  })

  it('still falls back to a byte stream for a type it does not serve', () => {
    // The fallback is what makes an unknown type a download rather than something
    // the browser tries to interpret; only types we deliberately serve escape it.
    expect(contentTypeForPath('/w/archive.zip')).toBe('application/octet-stream')
    expect(contentTypeForPath('/w/no-extension')).toBe('application/octet-stream')
  })

  it('keeps serving the existing web and media types inline', () => {
    expect(contentTypeForPath('/w/page.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeForPath('/w/clip.mp4')).toBe('video/mp4')
  })
})
