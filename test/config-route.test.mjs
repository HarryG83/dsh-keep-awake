/**
 * Integration tests for the host half: a real HTTP server in front of the real
 * plugin, driven with the request shapes the two front ends actually produce.
 *
 * The desktop cases are the regression this file exists for. Electron's
 * `forwardWebRequest()` deletes `host`, `origin`, `cookie` and
 * `sec-fetch-site` before proxying a renderer request to the Host web server,
 * so a config write from the DSH Desktop settings page arrives bare — and the
 * route used to answer 403, which the settings page renders as "连接错误".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const plugin = await import('../lib/index.js')

/** Headers the web UI sends: a same-origin fetch from the HTTP page. */
function webHeaders(base) {
  return { origin: base, 'sec-fetch-site': 'same-origin' }
}

/**
 * Headers the DSH Desktop shell leaves behind: forwardWebRequest() strips
 * origin and sec-fetch-site and re-attaches only the host-issued auth cookie.
 */
const DESKTOP_HEADERS = {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Boot the real plugin with minimal stand-ins for the Cordis services it
 * injects, behind a real HTTP server on a loopback port.
 */
async function bootPlugin() {
  const routes = new Map()
  const disposers = []
  const warnings = []
  let stored = { enabled: true, graceMs: 60000, preventDisplaySleep: false, manualHold: false }

  const ctx = {
    get(name) {
      if (name === 'settings') {
        // The real service validates against KeepAwakeSchema and persists; these
        // tests only need the route to read and write it.
        return {
          register: () => ({
            get: () => ({ ...stored }),
            replace: async (next) => {
              stored = { ...next }
            },
          }),
        }
      }
      if (name === 'webServer') {
        return {
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }
      }
      if (name === 'timer') return {}
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(typeof dispose === 'function' ? dispose : () => {})
      return () => {}
    },
    on: () => () => {},
    interval: () => () => {},
    timeout(fn, ms) {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
    logger: { warn: (message) => warnings.push(String(message)) },
  }

  await plugin.apply(ctx)

  const server = http.createServer((req, res) => {
    const handler = routes.get((req.url ?? '').split('?')[0])
    if (handler === undefined) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    settings: () => stored,
    warnings,
    async close() {
      for (const dispose of disposers) dispose()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function request(base, path, { method = 'GET', headers = {}, body, contentType = 'application/json' } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      connection: 'close',
      ...(body === undefined || contentType === null ? {} : { 'content-type': contentType }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* deliberately non-JSON response */
  }
  return { status: res.status, json }
}

const putConfig = (base, headers, section) =>
  request(base, '/dsh-keep-awake/config', { method: 'PUT', headers, body: { section } })

test('state route reports activity, helper and config', async (t) => {
  const app = await bootPlugin()
  t.after(() => app.close())

  const res = await request(app.base, '/dsh-keep-awake/state')
  assert.equal(res.status, 200)
  assert.equal(res.json.enabled, true)
  assert.equal(res.json.helperState, 'off')
  assert.equal(res.json.holdingWakeLock, false)
  assert.equal(res.json.helperDisplayOn, false)
})

test('desktop shell: a bare PUT is accepted (regression: used to be 403)', async (t) => {
  const app = await bootPlugin()
  t.after(() => app.close())

  const res = await putConfig(app.base, DESKTOP_HEADERS, { enabled: false })

  assert.equal(res.status, 200)
  assert.equal(res.json.enabled, false)
  assert.equal(app.settings().enabled, false, 'the settings scope must be updated too')
})

test('web UI over HTTP: a same-origin PUT is accepted', async (t) => {
  const app = await bootPlugin()
  t.after(() => app.close())

  const res = await putConfig(app.base, webHeaders(app.base), { preventDisplaySleep: true })

  assert.equal(res.status, 200)
  assert.equal(res.json.preventDisplaySleep, true)
  assert.equal(app.settings().preventDisplaySleep, true)
})

test('a partial patch leaves unrelated settings alone', async (t) => {
  const app = await bootPlugin()
  t.after(() => app.close())

  await putConfig(app.base, DESKTOP_HEADERS, { graceMs: 300000 })
  const res = await putConfig(app.base, DESKTOP_HEADERS, { preventDisplaySleep: true })

  assert.equal(res.status, 200)
  assert.equal(res.json.graceMs, 300000, 'graceMs must survive an unrelated patch')
  assert.equal(res.json.enabled, true)
  assert.equal(res.json.manualHold, false)
  assert.equal(res.json.preventDisplaySleep, true)
})

test('cross-site and opaque origins are still refused', async (t) => {
  const app = await bootPlugin()
  t.after(() => app.close())

  const refused = [
    { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'dsh-app://app' },
    webHeaders(app.base.replace('127.0.0.1', 'evil.example')),
  ]
  for (const headers of refused) {
    const res = await putConfig(app.base, headers, { enabled: false })
    assert.equal(res.status, 403, JSON.stringify(headers))
    assert.match(res.json.error, /local web UI or the DSH Desktop app/)
  }

  assert.equal(app.settings().enabled, true, 'nothing may have been written')
})

test('method and body guards', async (t) => {
  const app = await bootPlugin()
  t.after(() => app.close())

  assert.equal((await request(app.base, '/dsh-keep-awake/config')).status, 405)
  assert.equal(
    (await request(app.base, '/dsh-keep-awake/config', {
      method: 'PUT',
      headers: DESKTOP_HEADERS,
      body: '{}',
      contentType: 'text/plain',
    })).status,
    415,
  )
  assert.equal(
    (await request(app.base, '/dsh-keep-awake/config', {
      method: 'PUT',
      headers: DESKTOP_HEADERS,
      body: '{}',
      contentType: 'application/json',
    })).status,
    400,
  )
})

/**
 * Spawns the real OS helper, so it is opt-in and Windows-only:
 *   KEEP_AWAKE_SPAWN_TEST=1 node --test
 */
const spawnTest = process.platform === 'win32' && process.env.KEEP_AWAKE_SPAWN_TEST === '1' ? test : test.skip

spawnTest('manual hold starts a helper, and the display flag replaces it', async (t) => {
  const app = await bootPlugin()
  t.after(() => app.close())

  await putConfig(app.base, DESKTOP_HEADERS, { manualHold: true })
  await sleep(1500)
  const started = (await request(app.base, '/dsh-keep-awake/state')).json
  assert.equal(started.helperState, 'on')
  assert.equal(started.helperDisplayOn, false)

  await putConfig(app.base, DESKTOP_HEADERS, { preventDisplaySleep: true })
  await sleep(1500)
  const displayed = (await request(app.base, '/dsh-keep-awake/state')).json
  assert.equal(displayed.helperState, 'on')
  assert.equal(displayed.helperDisplayOn, true)
  assert.notEqual(displayed.helperPid, started.helperPid, 'the helper must be replaced, not kept')

  await putConfig(app.base, DESKTOP_HEADERS, { graceMs: 1000, manualHold: false })
  await sleep(1800)
  const released = (await request(app.base, '/dsh-keep-awake/state')).json
  assert.equal(released.helperState, 'off')
})
