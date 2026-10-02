/**
 * Set headers on a response, keeping its body as it is.
 *
 * They are set in place. Building a new `Response` from `response.body` is what a
 * response with immutable headers needs (one that came from `fetch`), but for a file
 * served as `new Response(Bun.file(path))` it turns the file into a JavaScript stream
 * the server reads ahead of the client and buffers — a 300 MiB file held about three
 * times over while the client had read 4 MiB — and drops the Content-Length Bun would
 * have worked out from the file. So a response is rebuilt only when it cannot be set.
 *
 * Everything that decorates a response on its way out (CORS, timing, the security
 * headers of remote access) goes through here, because one layer that rebuilds is
 * enough to undo the others.
 */
export function setResponseHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value)
    }
    return response
  } catch {
    const rebuilt = new Headers(response.headers)
    for (const [key, value] of Object.entries(headers)) {
      rebuilt.set(key, value)
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: rebuilt,
    })
  }
}
