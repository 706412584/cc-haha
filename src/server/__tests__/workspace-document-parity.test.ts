/**
 * The server decides what it will serve (`workspaceDocumentPreview.ts`); the
 * desktop decides what a link may open in the workspace (`fileCapabilities.ts`).
 * Link routing has to be synchronous, so the desktop cannot ask the server, and
 * two lists that must agree are exactly the kind that drift: this repo already
 * carried five different image-extension tables.
 *
 * The rule: they are the same list. A format added to the server table without a
 * route in the desktop would silently open the system application for it; a
 * route without a server entry would send a link to a file the server refuses.
 * A new format needs both, and a viewer.
 */

import { describe, expect, it } from 'bun:test'
import { documentViewers } from '../../../desktop/src/components/workspace/surfaces/document/documentViewers.js'
import { WORKSPACE_DOCUMENT_EXTENSIONS } from '../../../desktop/src/lib/fileCapabilities.js'
import { documentFormatForPath, workspaceDocumentExtensions } from '../services/workspaceDocumentPreview.js'

describe('workspace document preview parity', () => {
  const served = new Set(workspaceDocumentExtensions())
  const routed = new Set(WORKSPACE_DOCUMENT_EXTENSIONS)

  it('routes nothing to the workspace that the server would refuse to serve', () => {
    const unservable = [...routed].filter((extension) => !served.has(extension))

    expect(unservable).toEqual([])
  })

  it('routes every format the server serves', () => {
    const unrouted = [...served].filter((extension) => !routed.has(extension))

    // A format added to the server table without deciding where the desktop
    // stands would silently open the system application for it. Decide, here.
    expect(unrouted).toEqual([])
  })

  it('has a viewer for every format it routes', () => {
    // A link to a document with no viewer would land on "this file type can't be
    // previewed here" instead of opening the application that can show it.
    const viewerless = [...routed].filter((extension) => {
      const format = documentFormatForPath(`file.${extension}`)
      return !format || !documentViewers[format.previewType]
    })

    expect(viewerless).toEqual([])
  })

  it('has a viewer for exactly the formats it routes', () => {
    const viewerTypes = Object.keys(documentViewers).sort()
    const routedTypes = [...new Set([...routed].map((extension) => documentFormatForPath(`file.${extension}`)?.previewType))].sort()

    expect(viewerTypes).toEqual(routedTypes)
  })
})
