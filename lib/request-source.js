/**
 * dsh-keep-awake — request-source classification for the mutating route.
 *
 * The plugin is driven by two front ends that look nothing alike on the wire, so
 * "may this write proceed?" cannot be answered by a single same-origin test.
 *
 * `web`
 *   The settings page served over HTTP by the DSH web server (the standalone
 *   `dsh web` UI, and the same page reached through the LAN / mobile remote UI).
 *   Chromium attaches `origin` to every fetch/XHR; the origin must equal the
 *   request host and that host must be a loopback name. The loopback requirement
 *   is what stops DNS rebinding: a page on `evil.example` that resolves to
 *   127.0.0.1 sends `Origin: http://evil.example`, which *does* match its own
 *   `Host` header, so comparing origin to host alone is not enough.
 *
 * `desktop`
 *   The DSH Desktop renderer, whose document origin is `dsh-app://app`. Every
 *   request is proxied by Electron's `protocol.handle('dsh-app')` →
 *   `forwardWebRequest()`, which deletes `host`, `origin`, `cookie` and
 *   `sec-fetch-site` before forwarding to the Host web server and re-attaches
 *   only the Host-issued auth cookie. Such a request therefore arrives with no
 *   `origin` and no `sec-fetch-site` at all, leaving the loopback peer address
 *   as the strongest signal available — and it is sufficient: browsers always
 *   attach `sec-fetch-site` to fetch/XHR, so a remote page cannot produce this
 *   shape.
 *
 * Anything else — a cross-site or opaque origin, an explicit `sec-fetch-site`
 * that is not `same-origin`, or a non-loopback peer — classifies as `null` and
 * the caller answers 403.
 */

/** Host names that only ever resolve to this machine. */
export const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Loopback peer addresses, including the IPv4-mapped IPv6 form a dual-stack socket reports. */
export function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** `Host` header → hostname, or null when it is missing or unparseable. */
function hostnameOf(host) {
  if (typeof host !== 'string' || host === '') return null
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === '' ? null : hostname
  } catch {
    return null
  }
}

/**
 * Classify a mutating request.
 *
 * @param {import('node:http').IncomingMessage} req - the Host web-server request.
 * @returns {'web' | 'desktop' | null} the front end that sent it, or null to refuse.
 */
export function classifyRequestSource(req) {
  const headers = req?.headers ?? {}
  const hostname = hostnameOf(headers.host)
  if (hostname === null) return null

  const loopbackHost = LOOPBACK_HOSTNAMES.has(hostname)

  const origin = headers.origin
  if (typeof origin === 'string') {
    // An opaque origin ("null") comes from sandboxed frames and redirects and
    // never identifies the web UI.
    if (origin === 'null') return null
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return null
    }
    const httpOrigin = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    return httpOrigin && parsed.host === headers.host && loopbackHost ? 'web' : null
  }

  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== '') {
    // "same-origin" without an origin header is the legacy browser shape;
    // cross-site, same-site and none are refused.
    return site === 'same-origin' && loopbackHost ? 'web' : null
  }

  // No origin and no sec-fetch-site: the Desktop shell's forwarded request, or
  // another local client. Both the peer and the Host header must be loopback.
  return loopbackHost && isLoopbackAddress(req?.socket?.remoteAddress) ? 'desktop' : null
}
