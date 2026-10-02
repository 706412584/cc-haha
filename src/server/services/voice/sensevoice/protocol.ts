/**
 * Contract between the server-side recognizer and its worker process.
 *
 * The worker listens on 127.0.0.1 with a random port, prints `{"port":N}` as
 * its first stdout line once the model is loaded, and answers
 * `POST /transcribe?language=<code>` (WAV body, `Authorization: Bearer <token>`).
 * The token and configuration arrive through environment variables that the
 * worker deletes as soon as it has read them.
 */

export const WORKER_CONFIG_ENV = 'CC_HAHA_VOICE_WORKER_CONFIG'
export const WORKER_TOKEN_ENV = 'CC_HAHA_VOICE_WORKER_TOKEN'

export const WORKER_LANGUAGES: readonly string[] = ['auto', 'zh', 'en', 'ja', 'ko', 'yue']

export interface WorkerConfig {
  /** Directory whose `node_modules` contains sherpa-onnx-node and its native package. */
  runtimeRoot: string
  model: string
  tokens: string
  vad: string
  threads: number
  maxAudioBytes: number
  vadThreshold: number
  minSilenceSeconds: number
  minSpeechSeconds: number
  /** Longest single VAD segment handed to the recognizer. */
  segmentSeconds: number
}

export interface WorkerTranscript {
  text: string
  audioSeconds: number
  inferenceSeconds: number
}

/** JSON error body; `code: 'invalid-input'` marks a request the worker rejected before inference. */
export interface WorkerErrorBody {
  error: string
  code?: 'invalid-input'
}
