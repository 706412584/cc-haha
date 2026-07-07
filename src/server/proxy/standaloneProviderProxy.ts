import { handleProxyRequest } from './handler.js'

let standaloneProviderProxy: ReturnType<typeof Bun.serve> | null = null

export function ensureStandaloneProviderProxy(): number {
  if (standaloneProviderProxy) {
    return standaloneProviderProxy.port
  }

  standaloneProviderProxy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' })
      }
      if (url.pathname.startsWith('/proxy/')) {
        return handleProxyRequest(req, url)
      }
      return Response.json({ error: 'Not Found' }, { status: 404 })
    },
  })

  return standaloneProviderProxy.port
}

export function stopStandaloneProviderProxyForTests(): void {
  standaloneProviderProxy?.stop(true)
  standaloneProviderProxy = null
}
