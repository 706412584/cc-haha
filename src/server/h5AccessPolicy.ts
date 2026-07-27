export type H5RequestKind = 'local-trusted' | 'internal-sdk' | 'h5-browser'
export type H5RequestContext = {
  clientAddress: string | null
  localAccessTokenConfigured?: boolean
  localAccessAuthorized?: boolean
  internalSdkAuthorized?: boolean
}

const LOCAL_DESKTOP_ORIGINS = new Set(['file://'])
const PROXY_TRACE_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
] as const

export function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length))
  }
  return normalized === 'localhost' || normalized === '::1' || isLoopbackIPv4(normalized)
}

function isLoopbackIPv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') {
    return false
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false
    }

    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

function isLoopbackBrowserOrigin(origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false
  }

  return isLoopbackHost(parsed.hostname)
}

/**
 * A cross-site subresource load (`<img>`, `<script>`, `no-cors` fetch) reaches
 * us without an `Origin` header, so it would otherwise be indistinguishable
 * from a genuine local navigation. Fetch Metadata is what tells them apart:
 * a top-level navigation carries `Sec-Fetch-Mode: navigate`, a subresource
 * does not. Clients that send no Fetch Metadata at all (curl, adapters, the
 * CLI subprocess) stay trusted — they are not a browser CSRF vector.
 */
function isCrossSiteSubresource(headers: Headers): boolean {
  const site = headers.get('Sec-Fetch-Site')
  if (site !== 'cross-site' && site !== 'same-site') {
    return false
  }

  const mode = headers.get('Sec-Fetch-Mode')
  return mode !== null && mode !== 'navigate'
}

function isLocalDesktopOrNavigationOrigin(
  request: Request,
  origin: string | null,
): boolean {
  if (!origin) return !isCrossSiteSubresource(request.headers)
  return LOCAL_DESKTOP_ORIGINS.has(origin) || isLoopbackBrowserOrigin(origin)
}

function hasProxyTraceHeaders(headers: Headers): boolean {
  return PROXY_TRACE_HEADERS.some((header) => headers.has(header))
}

function isLocalTrustedRequest(
  request: Request,
  url: URL,
  context: H5RequestContext,
  origin: string | null,
): boolean {
  // The process token the desktop shell injects is the strongest credential we
  // have: it identifies the app's own components (renderer, adapters, the CLI
  // subprocess) regardless of how they reach us.
  if (context.localAccessAuthorized === true) return true

  // Its *absence* must not demote loopback, though. Plenty of legitimate local
  // traffic can never carry that token — the OAuth success page the system
  // browser opens, `/preview-fs` links, a `curl` against the local API. Gating
  // loopback behind the token turned all of those into 401/403 (issue: "Missing
  // H5 access token" on /api/haha-grok-oauth/success). Loopback stays trusted
  // on its own; the Host, proxy-trace and Origin checks below are what keep a
  // remote client from claiming it.
  const clientAddress = context.clientAddress
  if (!clientAddress) return false
  if (hasProxyTraceHeaders(request.headers)) return false

  return isLoopbackHost(clientAddress) &&
    isLoopbackHost(url.hostname) &&
    isLocalDesktopOrNavigationOrigin(request, origin)
}

function isFilesystemCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/local-file/') ||
    pathname.startsWith('/preview-fs/')
}

export function classifyH5Request(
  request: Request,
  url: URL,
  context: H5RequestContext,
): H5RequestKind {
  const origin = request.headers.get('Origin')
  const localTrusted = isLocalTrustedRequest(request, url, context, origin)
  if (isFilesystemCapabilityPath(url.pathname)) {
    return localTrusted ? 'local-trusted' : 'h5-browser'
  }

  if (url.pathname.startsWith('/sdk/') && (localTrusted || context.internalSdkAuthorized)) {
    return 'internal-sdk'
  }

  if (localTrusted) {
    return 'local-trusted'
  }

  return 'h5-browser'
}

export function shouldRequireH5Token({
  request,
  url,
  h5Enabled,
  context,
}: {
  request: Request
  url: URL
  h5Enabled: boolean
  context: H5RequestContext
}): boolean {
  if (!h5Enabled) {
    return false
  }

  if (!isH5BrowserCapabilityPath(url.pathname)) {
    return false
  }

  return classifyH5Request(request, url, context) === 'h5-browser'
}

export function shouldBlockDisabledH5Access({
  request,
  url,
  h5Enabled,
  explicitAuthRequired,
  context,
}: {
  request: Request
  url: URL
  h5Enabled: boolean
  explicitAuthRequired: boolean
  context: H5RequestContext
}): boolean {
  if (h5Enabled || explicitAuthRequired) {
    return false
  }

  if (!isH5ProtectedCapabilityPath(url.pathname)) {
    return false
  }

  return classifyH5Request(request, url, context) === 'h5-browser'
}

function isH5ProtectedCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/api/') ||
    isFilesystemCapabilityPath(pathname) ||
    pathname.startsWith('/proxy/') ||
    pathname.startsWith('/ws/') ||
    pathname.startsWith('/sdk/')
}

export function isH5AccessControlPath(pathname: string): boolean {
  return pathname.startsWith('/api/h5-access') &&
    pathname !== '/api/h5-access/verify'
}

/**
 * The control plane — enabling remote access, minting and revoking H5 tokens —
 * is the one surface where loopback alone is deliberately not enough. Once the
 * desktop shell has injected its process token, only components holding that
 * token may change who can reach this machine; another browser or script on the
 * same box must not be able to publish the user's sessions to the network.
 * This is the boundary `harden desktop request isolation` set out to protect,
 * and it is kept here instead of being applied to every local request.
 */
export function requiresLocalAccessCredential(
  pathname: string,
  context: H5RequestContext,
): boolean {
  if (!context.localAccessTokenConfigured) return false
  if (!isH5AccessControlPath(pathname)) return false
  return context.localAccessAuthorized !== true
}

function isH5BrowserCapabilityPath(pathname: string): boolean {
  return pathname.startsWith('/api/') ||
    isFilesystemCapabilityPath(pathname) ||
    pathname.startsWith('/proxy/') ||
    pathname.startsWith('/ws/')
}
