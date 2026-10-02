import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAudioInputs } from './devices'

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

function device(kind: string, deviceId: string, label: string) {
  return { kind, deviceId, label } as MediaDeviceInfo
}

function stubMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true })
}

describe('listAudioInputs', () => {
  beforeEach(() => {
    stubMediaDevices(undefined)
  })

  afterEach(() => {
    if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices
  })

  it('returns an empty list when the browser has no media devices API', async () => {
    await expect(listAudioInputs()).resolves.toEqual([])
  })

  it('keeps only audio inputs and drops the communications alias', async () => {
    stubMediaDevices({
      enumerateDevices: vi.fn(async () => [
        device('videoinput', 'cam', 'Camera'),
        device('audiooutput', 'spk', 'Speakers'),
        device('audioinput', 'default', 'Default - Built-in'),
        device('audioinput', 'communications', 'Communications'),
        device('audioinput', 'usb', 'USB Mic'),
      ]),
    })

    await expect(listAudioInputs()).resolves.toEqual([
      { deviceId: 'default', label: 'Default - Built-in' },
      { deviceId: 'usb', label: 'USB Mic' },
    ])
  })

  it('does not open a stream unless permission is requested', async () => {
    const getUserMedia = vi.fn()
    stubMediaDevices({
      enumerateDevices: vi.fn(async () => [device('audioinput', 'a', '')]),
      getUserMedia,
    })

    await expect(listAudioInputs()).resolves.toEqual([{ deviceId: 'a', label: '' }])
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('opens and immediately closes a stream to unlock labels', async () => {
    const stop = vi.fn()
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }, { stop }] }))
    const enumerateDevices = vi.fn()
      .mockResolvedValueOnce([device('audioinput', 'a', '')])
      .mockResolvedValueOnce([device('audioinput', 'a', 'Studio Mic')])
    stubMediaDevices({ enumerateDevices, getUserMedia })

    await expect(listAudioInputs({ requestPermission: true })).resolves.toEqual([
      { deviceId: 'a', label: 'Studio Mic' },
    ])
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('skips the permission prompt when labels are already readable', async () => {
    const getUserMedia = vi.fn()
    stubMediaDevices({
      enumerateDevices: vi.fn(async () => [device('audioinput', 'a', 'Studio Mic')]),
      getUserMedia,
    })

    await listAudioInputs({ requestPermission: true })
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('returns the unlabeled list when permission is denied', async () => {
    stubMediaDevices({
      enumerateDevices: vi.fn(async () => [device('audioinput', 'a', '')]),
      getUserMedia: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError') }),
    })

    await expect(listAudioInputs({ requestPermission: true })).resolves.toEqual([{ deviceId: 'a', label: '' }])
  })

  it('reports why the permission stream failed without changing the returned list', async () => {
    const denied = new DOMException('denied', 'NotAllowedError')
    const onPermissionError = vi.fn()
    stubMediaDevices({
      enumerateDevices: vi.fn(async () => [device('audioinput', '', '')]),
      getUserMedia: vi.fn(async () => { throw denied }),
    })

    await expect(listAudioInputs({ requestPermission: true, onPermissionError })).resolves.toEqual([{ deviceId: '', label: '' }])
    expect(onPermissionError).toHaveBeenCalledWith(denied)
  })

  it('does not report a permission error when the stream opens', async () => {
    const onPermissionError = vi.fn()
    stubMediaDevices({
      enumerateDevices: vi.fn(async () => [device('audioinput', 'a', '')]),
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] })),
    })

    await listAudioInputs({ requestPermission: true, onPermissionError })
    expect(onPermissionError).not.toHaveBeenCalled()
  })

  it('returns an empty list when enumeration itself fails', async () => {
    stubMediaDevices({ enumerateDevices: vi.fn(async () => { throw new Error('boom') }) })
    await expect(listAudioInputs()).resolves.toEqual([])
  })
})
