/**
 * HTTP-level tests for `GET /api/sessions/:id/workspace/raw`, the route that
 * streams a document's bytes to an in-app viewer. The boundary rules themselves
 * are covered against `WorkspaceService.resolveRawFile` in
 * workspace-service.test.ts; this file pins what only the route can get wrong:
 * status mapping, headers, and that the body is the file's exact bytes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import {
  clearFilesystemAccessRootsForTests,
  registerFilesystemAccessRoot,
} from '../services/filesystemAccessRoots.js'
import { WORKSPACE_DOCUMENT_FORMATS } from '../services/workspaceDocumentPreview.js'

let tmpDir: string
let baseUrl: string
let server: ReturnType<typeof Bun.serve> | null = null
let sessionId: string
let workDir: string

/** Bytes a text decoder would mangle: NULs, a lone 0xff, and a UTF-8 lead byte. */
const BINARY_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x00, 0x0a])

beforeEach(async () => {
  clearFilesystemAccessRootsForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-raw-route-'))
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'config')
  await fs.mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), { recursive: true })
  workDir = path.join(tmpDir, 'work')
  await fs.mkdir(workDir)

  const { handleApiRequest } = await import('../router.js')
  const { resolveCors, withCors } = await import('../middleware/cors.js')
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      // The two layers the real server puts around every API route: the monitor that
      // stamps timing on it, inside `handleApiRequest`, and CORS outside it. Each once
      // rebuilt the response, and a file served from disk that has been rebuilt goes out
      // chunked and buffered in memory. Testing the route bare would not have seen it.
      const cors = await resolveCors(req.headers.get('Origin'), url.origin)
      return withCors(await handleApiRequest(req, url), cors)
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
  sessionId = (await new SessionService().createSession(workDir)).sessionId
})

afterEach(async () => {
  server?.stop(true)
  server = null
  clearFilesystemAccessRootsForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function raw(requestPath: string | null, session = sessionId): Promise<Response> {
  const query = requestPath === null ? '' : `?path=${encodeURIComponent(requestPath)}`
  return fetch(`${baseUrl}/api/sessions/${session}/workspace/raw${query}`)
}

describe('GET /api/sessions/:id/workspace/raw', () => {
  it('streams the exact bytes with the format headers and no caching', async () => {
    await fs.writeFile(path.join(workDir, 'thesis.pdf'), BINARY_BYTES)

    const res = await raw('thesis.pdf')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-length')).toBe(String(BINARY_BYTES.length))
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // Exactness matters: a text decode anywhere on the path would corrupt these.
    expect(Buffer.from(await res.arrayBuffer()).equals(BINARY_BYTES)).toBe(true)
  })

  it('goes out with its length and the headers the server adds to every response', async () => {
    // Big enough that Bun does not simply read a rebuilt body whole and count it.
    const bytes = Buffer.alloc(300 * 1024, 0x41)
    await fs.writeFile(path.join(workDir, 'thesis.pdf'), bytes)

    const res = await raw('thesis.pdf')

    // Present only if nothing between the route and the socket rebuilt the response
    // (which would send it chunked), and each layer still did its own work.
    expect(res.headers.get('content-length')).toBe(String(bytes.length))
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
    expect(res.headers.get('server-timing')).toMatch(/^app;dur=/)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it.each(Object.entries(WORKSPACE_DOCUMENT_FORMATS))(
    'labels .%s with its own media type',
    async (extension, format) => {
      await fs.writeFile(path.join(workDir, `file.${extension}`), BINARY_BYTES)

      const res = await raw(`file.${extension}`)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe(format.mimeType)
    },
  )

  it('serves a document under a nested workspace path', async () => {
    await fs.mkdir(path.join(workDir, 'out', 'final'), { recursive: true })
    await fs.writeFile(path.join(workDir, 'out', 'final', 'thesis.docx'), BINARY_BYTES)

    const res = await raw('out/final/thesis.docx')

    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(BINARY_BYTES)).toBe(true)
  })

  it('requires a path query', async () => {
    const res = await raw(null)

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'BAD_REQUEST' })
  })

  it('answers 404 for an unknown session', async () => {
    const res = await raw('thesis.pdf', crypto.randomUUID())

    expect(res.status).toBe(404)
  })

  it('answers 404 for a missing file', async () => {
    const res = await raw('missing.pdf')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'NOT_FOUND' })
  })

  it('answers 415 for a type outside the document allowlist', async () => {
    await fs.writeFile(path.join(workDir, 'notes.txt'), 'plain text\n')
    await fs.writeFile(path.join(workDir, 'photo.png'), BINARY_BYTES)

    for (const name of ['notes.txt', 'photo.png']) {
      const res = await raw(name)
      expect(res.status).toBe(415)
      expect(await res.json()).toMatchObject({ error: 'UNSUPPORTED_MEDIA_TYPE' })
    }
  })

  it('answers 413 for a file above the format limit', async () => {
    const target = path.join(workDir, 'huge.docx')
    await fs.writeFile(target, '')
    await fs.truncate(target, WORKSPACE_DOCUMENT_FORMATS.docx!.maxBytes + 1)

    const res = await raw('huge.docx')

    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'PAYLOAD_TOO_LARGE' })
  })

  it('answers 403 for traversal and for an absolute path outside the workspace', async () => {
    await fs.writeFile(path.join(tmpDir, 'secret.pdf'), BINARY_BYTES)

    for (const requested of ['../secret.pdf', path.join(tmpDir, 'secret.pdf')]) {
      const res = await raw(requested)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'FORBIDDEN' })
    }
  })

  it.skipIf(process.platform === 'win32')('answers 403 for a symlink that points outside the workspace', async () => {
    await fs.writeFile(path.join(tmpDir, 'secret.pdf'), BINARY_BYTES)
    await fs.symlink(path.join(tmpDir, 'secret.pdf'), path.join(workDir, 'innocent.pdf'))

    const res = await raw('innocent.pdf')

    expect(res.status).toBe(403)
  })

  it('serves a document in a registered access root outside the workdir', async () => {
    const outsideDir = path.join(tmpDir, 'elsewhere')
    await fs.mkdir(outsideDir)
    const outsideFile = path.join(outsideDir, 'report.xlsx')
    await fs.writeFile(outsideFile, BINARY_BYTES)

    expect((await raw(outsideFile)).status).toBe(403)

    registerFilesystemAccessRoot(outsideDir)
    const res = await raw(outsideFile)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(BINARY_BYTES)).toBe(true)
  })
})
