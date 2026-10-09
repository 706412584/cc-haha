import { useEffect, useState } from 'react'
import { isTouchH5Document } from '../lib/touchH5'

const MOBILE_VIEWPORT_QUERY = '(max-width: 767px)'
const MOBILE_USER_AGENT_QUERY = /Android|iPhone|iPad|iPod|Mobile/i

function isForcedMobileViewport() {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('forceMobile') === '1'
}

function isMobileUserAgent() {
  if (typeof navigator === 'undefined') return false
  return MOBILE_USER_AGENT_QUERY.test(navigator.userAgent)
}

function getInitialMobileViewport() {
  if (isForcedMobileViewport() || isMobileUserAgent()) return true
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(MOBILE_VIEWPORT_QUERY).matches
}

/**
 * True when controls should take their touch form: narrower than a tablet, or
 * any touch H5 browser. A tablet is wide enough for the desktop sizes but has
 * no hover and no precise pointer, so it gets the same 44px targets and bottom
 * sheets as a phone; only the page layout around them differs.
 */
export function useMobileViewport() {
  const [isMobile, setIsMobile] = useState(getInitialMobileViewport)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    const forcedMobile = isForcedMobileViewport()
    const mobileUserAgent = isMobileUserAgent()
    const mediaQuery = window.matchMedia(MOBILE_VIEWPORT_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobile(forcedMobile || mobileUserAgent || event.matches)
    }

    setIsMobile(forcedMobile || mobileUserAgent || mediaQuery.matches)
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
    } else {
      mediaQuery.addListener(handleChange)
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleChange)
      } else {
        mediaQuery.removeListener(handleChange)
      }
    }
  }, [])

  return isMobile || isTouchH5Document()
}
