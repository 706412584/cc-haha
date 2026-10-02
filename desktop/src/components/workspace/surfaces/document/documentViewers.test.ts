import { describe, expect, it } from 'vitest'
import { documentViewers, isDocumentPreviewType } from './documentViewers'

describe('isDocumentPreviewType', () => {
  it.each(['pdf', 'docx', 'xlsx'])('names %s as a document, whose bytes are fetched apart from its metadata', (type) => {
    expect(isDocumentPreviewType(type)).toBe(true)
  })

  it.each(['text', 'image', undefined, ''])('does not take %s for one', (type) => {
    expect(isDocumentPreviewType(type)).toBe(false)
  })
})

describe('the document viewers', () => {
  it('has a viewer for each kind of document the panel can draw', () => {
    expect(Object.keys(documentViewers).sort()).toEqual(['docx', 'pdf', 'xlsx'])
  })
})
