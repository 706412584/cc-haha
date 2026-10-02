import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchServerImageBlobUrl } from './authedImage'

/**
 * Let an `<img>` that a plain request could not load try once more with the app's
 * credential (see {@link fetchServerImageBlobUrl}).
 *
 * Spread `src` and `onError` onto the image. `onFailure` runs only when the
 * authenticated attempt has also failed — a missing or denied file, or a body that
 * is not an image — so callers keep their own failure notice for real failures and
 * never flash it for a request that was merely missing a header.
 */
export function useAuthedImageFallback(src: string | undefined, onFailure?: () => void, retryWithCredential = false) {
  const attempt = useRef({ src, state: 'idle' as 'idle' | 'fetching' | 'resolved' | 'failed' })
  if (attempt.current.src !== src) attempt.current = { src, state: 'idle' }
  const current = attempt.current
  const [resolved, setResolved] = useState<{ attempt: typeof current; url: string } | null>(null)
  const alive = useRef(true)
  const objectUrls = useRef<string[]>([])
  const onFailureRef = useRef(onFailure)
  onFailureRef.current = onFailure

  useEffect(() => {
    alive.current = true
    const owned = objectUrls.current
    return () => {
      alive.current = false
      for (const url of owned) URL.revokeObjectURL(url)
      owned.length = 0
    }
  }, [])

  const onError = useCallback(() => {
    if (attempt.current !== current || current.state === 'fetching' || current.state === 'failed') return
    if (!src || current.state === 'resolved') {
      current.state = 'failed'
      onFailureRef.current?.()
      return
    }
    current.state = 'fetching'
    const request = retryWithCredential ? fetchServerImageBlobUrl(src, true) : fetchServerImageBlobUrl(src)
    void request.then((url) => {
      if (!alive.current || attempt.current !== current) {
        URL.revokeObjectURL(url)
        return
      }
      current.state = 'resolved'
      objectUrls.current.push(url)
      setResolved({ attempt: current, url })
    }).catch(() => {
      if (alive.current && attempt.current === current) {
        current.state = 'failed'
        onFailureRef.current?.()
      }
    })
  }, [src, current, retryWithCredential])

  useEffect(() => {
    if (retryWithCredential) onError()
  }, [retryWithCredential, onError])

  return { src: resolved?.attempt === current ? resolved.url : retryWithCredential ? undefined : src, onError }
}
