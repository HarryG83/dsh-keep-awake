/**
 * Unit tests for lib/request-source.js — the web/desktop split that the config
 * route relies on. Dependency-free: `node --test test/` runs them as-is.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRequestSource } from '../lib/request-source.js'

/** Minimal IncomingMessage shape the classifier reads; `host: null` omits the header. */
function req({ host = '127.0.0.1:19387', origin, site, peer = '127.0.0.1' } = {}) {
  const headers = {}
  if (host !== null) headers.host = host
  if (origin !== undefined) headers.origin = origin
  if (site !== undefined) headers['sec-fetch-site'] = site
  return { headers, socket: { remoteAddress: peer } }
}

test('web: browser request whose origin matches a loopback host', () => {
  assert.equal(classifyRequestSource(req({ origin: 'http://127.0.0.1:19387' })), 'web')
  assert.equal(classifyRequestSource(req({ host: 'localhost:19387', origin: 'http://localhost:19387' })), 'web')
  assert.equal(
    classifyRequestSource(req({ origin: 'http://127.0.0.1:19387', site: 'same-origin' })),
    'web',
  )
  // sec-fetch-site without an origin is the legacy browser shape.
  assert.equal(classifyRequestSource(req({ site: 'same-origin' })), 'web')
})

test('desktop: forwarded request with no origin and no sec-fetch-site', () => {
  // This is the exact shape Electron's forwardWebRequest() produces.
  assert.equal(classifyRequestSource(req()), 'desktop')
  assert.equal(classifyRequestSource(req({ host: 'localhost:19387' })), 'desktop')
  assert.equal(classifyRequestSource(req({ host: '[::1]:19387', peer: '::1' })), 'desktop')
  assert.equal(classifyRequestSource(req({ peer: '::ffff:127.0.0.1' })), 'desktop')
})

test('refused: cross-site and opaque origins', () => {
  assert.equal(classifyRequestSource(req({ origin: 'http://evil.example' })), null)
  assert.equal(classifyRequestSource(req({ origin: 'http://evil.example', site: 'cross-site' })), null)
  // DNS rebinding: origin matches its own Host, but neither is loopback.
  assert.equal(
    classifyRequestSource(req({ host: 'evil.example:19387', origin: 'http://evil.example:19387' })),
    null,
  )
  assert.equal(classifyRequestSource(req({ origin: 'null' })), null)
  // The shell's own document origin is never a valid Origin header value.
  assert.equal(classifyRequestSource(req({ origin: 'dsh-app://app' })), null)
})

test('refused: origin that does not match the request host', () => {
  assert.equal(classifyRequestSource(req({ origin: 'http://127.0.0.1:19388' })), null)
  assert.equal(classifyRequestSource(req({ host: 'localhost:19387', origin: 'http://127.0.0.1:19387' })), null)
})

test('refused: explicit non-same-origin sec-fetch-site', () => {
  assert.equal(classifyRequestSource(req({ site: 'cross-site' })), null)
  assert.equal(classifyRequestSource(req({ site: 'same-site' })), null)
  assert.equal(classifyRequestSource(req({ site: 'none' })), null)
})

test('refused: non-loopback peers and hosts', () => {
  assert.equal(classifyRequestSource(req({ peer: '192.168.1.79' })), null)
  assert.equal(classifyRequestSource(req({ host: '192.168.1.79:19387', peer: '192.168.1.79' })), null)
  // A tunnel can make the peer look local; the Host header then gives it away.
  assert.equal(classifyRequestSource(req({ host: 'tunnel.example' })), null)
})

test('refused: missing or unparseable host header', () => {
  assert.equal(classifyRequestSource(req({ host: null })), null)
  assert.equal(classifyRequestSource(req({ host: '' })), null)
  assert.equal(classifyRequestSource(req({ host: 'http://[bad' })), null)
  assert.equal(classifyRequestSource({}), null)
  assert.equal(classifyRequestSource({ headers: {} }), null)
})

test('refused: no socket information for the bare-request branch', () => {
  assert.equal(classifyRequestSource({ headers: { host: '127.0.0.1:19387' } }), null)
})
