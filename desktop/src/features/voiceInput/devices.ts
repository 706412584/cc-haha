export type AudioInputDevice = { deviceId: string; label: string }

function readInputs(devices: MediaDeviceInfo[]): AudioInputDevice[] {
  return devices
    .filter(device => device.kind === 'audioinput')
    // Chromium adds a virtual "communications" alias of another entry.
    .filter(device => device.deviceId !== 'communications')
    .map(device => ({ deviceId: device.deviceId, label: device.label }))
}

/**
 * Lists microphones. Labels stay empty until the page holds a microphone
 * permission; `requestPermission` opens a stream just long enough to unlock
 * them and closes it again before returning.
 */
export async function listAudioInputs(options?: {
  requestPermission?: boolean
  /**
   * Called with the `getUserMedia` failure when the permission stream cannot
   * open. The returned list is unchanged; this only tells the caller why the
   * labels stayed hidden (denied, no device, device busy).
   */
  onPermissionError?: (error: unknown) => void
}): Promise<AudioInputDevice[]> {
  const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  if (!mediaDevices?.enumerateDevices) return []

  let inputs = readInputs(await mediaDevices.enumerateDevices().catch(() => []))
  const needsLabels = inputs.length === 0 || inputs.some(device => !device.label)
  if (options?.requestPermission && needsLabels && mediaDevices.getUserMedia) {
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      inputs = readInputs(await mediaDevices.enumerateDevices().catch(() => []))
    } catch (error) {
      // Denied or nothing plugged in: report the unlabeled list we already have.
      options.onPermissionError?.(error)
    }
  }
  return inputs
}
