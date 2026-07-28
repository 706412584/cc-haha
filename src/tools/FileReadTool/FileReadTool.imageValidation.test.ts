/**
 * Regression coverage for the IMAGE_FORMAT_UNSUPPORTED loop.
 *
 * Background: when an HTTP endpoint returns a JSON error body and curl -s writes
 * it into a file named `*.png`, `readImageWithTokenBudget` previously trusted
 * the extension, packaged the JSON bytes into a base64 image content block, and
 * Bedrock rejected the request with `IMAGE_FORMAT_UNSUPPORTED`. The bad block
 * stayed in the conversation history, so every subsequent turn re-triggered the
 * same 400 — the loop the user actually saw.
 *
 * These tests lock in: when the file's magic bytes don't match a known image
 * format, the tool surfaces a typed error (`InvalidImageDataError`) instead of
 * silently shipping malformed bytes to the model API.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { crc32 } from '../../utils/crc32.js'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../utils/fsOperations.js'
import {
  InvalidImageDataError,
  readImageWithTokenBudget,
} from './FileReadTool.js'

// Minimal valid 1x1 PNG — magic bytes `89 50 4E 47 0D 0A 1A 0A` then a real IHDR.
// Hand-crafted so we don't need sharp/node-canvas at test time.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

// The actual bug payload: 43 bytes of JSON error body written into a `.png` file.
const NOT_A_PNG_43_BYTES = Buffer.from(
  '{"ok":false,"message":"not found"}\n',
  'utf8',
)

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  body.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(body), 8 + data.length)
  return chunk
}

function pngWithImageData(data: Buffer): Buffer {
  return Buffer.concat([
    TINY_PNG.subarray(0, 33),
    pngChunk('IDAT', data),
    TINY_PNG.subarray(TINY_PNG.length - 12),
  ])
}

function installFakeFs(fileMap: Record<string, Buffer>): void {
  const realFs = getFsImplementation()
  setFsImplementation({
    ...realFs,
    async readFileBytes(p: string) {
      const buf = fileMap[p]
      if (!buf) {
        throw new Error(`fake fs: no file at ${p}`)
      }
      return buf
    },
  })
}

describe('readImageWithTokenBudget — magic byte validation', () => {
  beforeEach(() => {
    setOriginalFsImplementation()
  })
  afterEach(() => {
    setOriginalFsImplementation()
  })

  test('throws InvalidImageDataError when a .png is actually a JSON error body', async () => {
    installFakeFs({
      '/fake/home_3_0_after_restart.png': NOT_A_PNG_43_BYTES,
    })

    let caught: unknown
    try {
      await readImageWithTokenBudget('/fake/home_3_0_after_restart.png')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(InvalidImageDataError)
    const err = caught as InvalidImageDataError
    // Error message has to carry enough context that the model can correct
    // course on the next turn — path + size + first bytes hex.
    expect(err.message).toContain('home_3_0_after_restart.png')
    expect(err.message).toContain(String(NOT_A_PNG_43_BYTES.length))
    // First 4 bytes of `{"ok` in hex
    expect(err.message).toContain('7b226f6b')
    expect(err.filePath).toBe('/fake/home_3_0_after_restart.png')
    expect(err.actualSize).toBe(NOT_A_PNG_43_BYTES.length)
  })

  test('throws InvalidImageDataError when the file is too small to validate', async () => {
    installFakeFs({
      '/fake/tiny.png': Buffer.from([0x89, 0x50, 0x4e]), // 3 bytes — PNG header truncated
    })

    await expect(
      readImageWithTokenBudget('/fake/tiny.png'),
    ).rejects.toBeInstanceOf(InvalidImageDataError)
  })

  test('preserves existing empty-file error (regression)', async () => {
    installFakeFs({
      '/fake/empty.png': Buffer.alloc(0),
    })

    await expect(
      readImageWithTokenBudget('/fake/empty.png'),
    ).rejects.toThrow(/empty/i)
  })

  test('rejects a PNG whose IDAT chunk is truncated despite valid magic bytes', async () => {
    const truncatedPng = Buffer.from(TINY_PNG)
    truncatedPng.writeUInt32BE(TINY_PNG.length, 33)
    installFakeFs({
      '/fake/truncated.png': truncatedPng,
    })

    await expect(
      readImageWithTokenBudget('/fake/truncated.png'),
    ).rejects.toBeInstanceOf(InvalidImageDataError)
  })

  test('rejects a PNG with IHDR and IEND but no image data', async () => {
    const pngWithoutIdat = Buffer.concat([
      TINY_PNG.subarray(0, 33),
      TINY_PNG.subarray(TINY_PNG.length - 12),
    ])
    installFakeFs({
      '/fake/no-idat.png': pngWithoutIdat,
    })

    await expect(
      readImageWithTokenBudget('/fake/no-idat.png'),
    ).rejects.toBeInstanceOf(InvalidImageDataError)
  })

  test('rejects a PNG whose chunk CRC is corrupt', async () => {
    const corruptCrcPng = Buffer.from(TINY_PNG)
    const idatLength = corruptCrcPng.readUInt32BE(33)
    const idatCrcOffset = 33 + 8 + idatLength
    corruptCrcPng[idatCrcOffset] ^= 0xff
    installFakeFs({
      '/fake/corrupt-crc.png': corruptCrcPng,
    })

    await expect(
      readImageWithTokenBudget('/fake/corrupt-crc.png'),
    ).rejects.toBeInstanceOf(InvalidImageDataError)
  })

  test('rejects a PNG with valid chunk CRCs but corrupt pixel data', async () => {
    const corruptPixelsPng = Buffer.from(TINY_PNG)
    const idatLength = corruptPixelsPng.readUInt32BE(33)
    const idatDataOffset = 33 + 8
    corruptPixelsPng[idatDataOffset] ^= 0xff
    const idatCrcOffset = idatDataOffset + idatLength
    corruptPixelsPng.writeUInt32BE(
      crc32(corruptPixelsPng.subarray(33 + 4, idatCrcOffset)),
      idatCrcOffset,
    )
    installFakeFs({
      '/fake/corrupt-pixels.png': corruptPixelsPng,
    })

    await expect(
      readImageWithTokenBudget('/fake/corrupt-pixels.png'),
    ).rejects.toBeInstanceOf(InvalidImageDataError)
  })

  test('rejects a PNG whose valid zlib stream has no scanline data', async () => {
    installFakeFs({
      '/fake/empty-scanlines.png': pngWithImageData(deflateSync(Buffer.alloc(0))),
    })

    await expect(
      readImageWithTokenBudget('/fake/empty-scanlines.png'),
    ).rejects.toBeInstanceOf(InvalidImageDataError)
  })

  test('rejects decompressed scanlines larger than the IHDR requires', async () => {
    installFakeFs({
      '/fake/oversized-scanlines.png': pngWithImageData(
        deflateSync(Buffer.alloc(8 * 1024 * 1024, 0)),
      ),
    })

    await expect(
      readImageWithTokenBudget('/fake/oversized-scanlines.png'),
    ).rejects.toBeInstanceOf(InvalidImageDataError)
  })

  test('accepts a real PNG with valid magic bytes', async () => {
    installFakeFs({
      '/fake/real.png': TINY_PNG,
    })

    const result = await readImageWithTokenBudget('/fake/real.png')
    expect(result.type).toBe('image')
    expect(result.file.type).toMatch(/^image\/(png|jpeg|webp|gif)$/)
  })
})
