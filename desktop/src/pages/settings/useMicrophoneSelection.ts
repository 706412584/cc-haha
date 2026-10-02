import { useCallback, useEffect, useRef, useState } from 'react'
import { listAudioInputs, type AudioInputDevice } from '@/features/voiceInput/devices'
import { getPreferredMicrophoneId, setPreferredMicrophoneId } from '@/features/voiceInput/devicePreference'
import type { VoiceRecorderErrorCode } from '@/features/voiceInput/recorder'
import type { TranslationKey } from '@/i18n/locales/en'

/** The recorder error code carried by a thrown value, or `failed` for anything else. */
export function recorderErrorCode(error: unknown): VoiceRecorderErrorCode {
  const code = (error as { code?: unknown } | null)?.code
  switch (code) {
    case 'unavailable':
    case 'permission':
    case 'no-device':
    case 'device-busy':
    case 'interrupted':
      return code
    default:
      return 'failed'
  }
}

// Recorder codes and server error codes share the composer's messages.
const ERROR_KEYS: Record<string, TranslationKey> = {
  unavailable: 'voice.composer.error.unavailable',
  permission: 'voice.composer.error.permission',
  'no-device': 'voice.composer.error.noDevice',
  'device-busy': 'voice.composer.error.deviceBusy',
  interrupted: 'voice.composer.error.interrupted',
  'voice/not-ready': 'voice.composer.error.notReady',
  'voice/invalid-audio': 'voice.composer.error.invalidAudio',
  'voice/unknown-provider': 'voice.composer.error.unknownProvider',
}

/** Anything without its own message (`failed`, `voice/failed`, unknown) reads as a failed transcription. */
export function voiceErrorKey(code: unknown): TranslationKey {
  return (typeof code === 'string' && ERROR_KEYS[code]) || 'voice.composer.error.failed'
}

export function recorderErrorKey(error: unknown): TranslationKey {
  return voiceErrorKey(recorderErrorCode(error))
}

/** What a failed `getUserMedia` says about the microphone, or null when it says nothing useful. */
function permissionFailureCode(error: unknown): VoiceRecorderErrorCode | null {
  switch ((error as { name?: unknown } | null)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'permission'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'no-device'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'device-busy'
    default:
      return null
  }
}

/**
 * Microphone choice for the voice settings page.
 *
 * Listing never asks for permission on its own — that would pop the OS prompt
 * just for opening a settings tab. Until the user grants it, browsers hide
 * device names (and may hide ids), so a saved device is only reported as
 * missing once real ids are visible and none of them matches.
 */
export function useMicrophoneSelection(enabled: boolean) {
  const [devices, setDevices] = useState<AudioInputDevice[]>([])
  const [loaded, setLoaded] = useState(false)
  const [listedCount, setListedCount] = useState(0)
  const [savedId, setSavedId] = useState<string | undefined>(() => getPreferredMicrophoneId())
  const [error, setError] = useState<VoiceRecorderErrorCode | null>(null)
  const [requesting, setRequesting] = useState(false)
  // Why the last "allow access" attempt left the names hidden; cleared once names appear.
  const [requestError, setRequestError] = useState<VoiceRecorderErrorCode | null>(null)
  const requestSeqRef = useRef(0)
  const mountedRef = useRef(true)

  const refresh = useCallback(async (requestPermission = false) => {
    const seq = ++requestSeqRef.current
    if (requestPermission) setRequesting(true)
    try {
      let streamFailure: unknown
      const list = await listAudioInputs(requestPermission
        ? { requestPermission: true, onPermissionError: (failure) => { streamFailure = failure } }
        : undefined)
      if (!mountedRef.current || seq !== requestSeqRef.current) return
      // Unauthorized Chromium lists one blank entry (empty id and label), so the
      // raw list is what tells "refused" apart from "no input device at all".
      setDevices(list.filter(device => device.deviceId))
      setListedCount(list.length)
      if (list.some(device => device.label)) setRequestError(null)
      else if (requestPermission) {
        setRequestError(permissionFailureCode(streamFailure) ?? (list.length > 0 ? 'permission' : null))
      }
      setError(null)
    } catch (caught) {
      if (!mountedRef.current || seq !== requestSeqRef.current) return
      setError(recorderErrorCode(caught))
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setLoaded(true)
        setRequesting(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (!mediaDevices?.addEventListener) return
    const onChange = () => { void refresh() }
    mediaDevices.addEventListener('devicechange', onChange)
    return () => mediaDevices.removeEventListener('devicechange', onChange)
  }, [enabled, refresh])

  const savedKnown = !!savedId && devices.some(device => device.deviceId === savedId)
  const savedMissing = !!savedId && devices.length > 0 && !savedKnown
  // '' is the system default; a saved id we cannot verify yet stays selected.
  const selectedId = savedId && !savedMissing ? savedId : ''

  const select = useCallback((id: string) => {
    const next = id || undefined
    setPreferredMicrophoneId(next)
    setSavedId(next)
  }, [])

  const needsPermission = loaded && (devices.length === 0 || devices.some(device => !device.label))

  // Only "the browser lists no input at all" is a missing microphone. Before
  // permission Chromium lists one blank entry, which is not.
  const noInputDevices = loaded && listedCount === 0

  return {
    devices,
    loaded,
    selectedId,
    savedId,
    savedMissing,
    needsPermission,
    noInputDevices,
    requesting,
    error: requestError ?? error,
    select,
    requestPermission: () => refresh(true),
  }
}
