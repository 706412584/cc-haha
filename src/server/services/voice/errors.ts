import type { VoiceErrorBody, VoiceErrorCode } from './types.js'

const STATUS_BY_CODE: Record<VoiceErrorCode, number> = {
  'voice/invalid-audio': 400,
  'voice/unknown-provider': 404,
  'voice/not-ready': 409,
  'voice/failed': 500,
}

export class VoiceServiceError extends Error {
  readonly code: VoiceErrorCode
  readonly status: number

  constructor(code: VoiceErrorCode, message: string) {
    super(message)
    this.name = 'VoiceServiceError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
  }

  toBody(): VoiceErrorBody {
    return { error: this.code, message: this.message }
  }
}
