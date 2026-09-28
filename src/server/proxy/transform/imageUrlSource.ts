/**
 * Image URL validation shared by the OpenAI wire-format transforms.
 *
 * An Anthropic `image` block may carry a remote URL (`source.type: 'url'`)
 * instead of inline base64. That URL is forwarded verbatim as `image_url` /
 * `input_image`, so an unusable one becomes an invalid request parameter — and
 * because the offending block is part of the conversation transcript, every
 * later turn resends it. A single bad URL therefore breaks the session
 * permanently, including `/compact`.
 *
 * Observed in the wild: an MCP tool returned
 * `https://host/qr.png "扫描此二维码测试游戏"` — a caption appended to the URL.
 * `new URL()` accepts it by percent-encoding the trailing text
 * (`...qr.png%20%22...`), so nothing upstream of the gateway noticed until the
 * provider rejected the whole request with `model_param_invalid`.
 *
 * Degrading to a text notice keeps the request valid and still tells the model
 * that an image was present and where it came from, matching how file-based
 * sources are already handled.
 */

/**
 * Characters that cannot appear in a URL. `new URL()` silently percent-encodes
 * most of these rather than rejecting, so they are checked explicitly.
 * Non-ASCII is covered separately by `NON_ASCII_URL_CHARS`.
 */
const UNENCODABLE_URL_CHARS = /[\s"'<>`\\{}|^[\]]/

/** Non-ASCII bytes: a URL that needs them was never encoded properly. */
const NON_ASCII_URL_CHARS = /[^\x20-\x7E]/

/** True when a URL image source can be forwarded to the upstream endpoint. */
export function isForwardableImageUrl(url: string): boolean {
  if (!url) return false
  if (UNENCODABLE_URL_CHARS.test(url) || NON_ASCII_URL_CHARS.test(url)) return false
  // A relative reference carries no scheme to send to the gateway.
  return /^https?:\/\//i.test(url)
}

/**
 * Model-visible notice replacing an unfowardable URL image source. The URL is
 * included deliberately: dropping it silently would hide the tool's output,
 * and the malformed value is exactly what the reader needs to fix it.
 */
export function unfowardableImageUrlText(url: string): string {
  return `\n[Image omitted: its URL is not a valid absolute http(s) URL and cannot be forwarded. Source: ${url}]\n`
}
