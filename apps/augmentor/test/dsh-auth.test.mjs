// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createDshClient } from '../shared/dsh-auth.mjs'

async function fixture(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  return `http://127.0.0.1:${server.address().port}`
}

test('authenticates API and websocket headers, shares concurrent exchange and renews rejected cookies', async t => {
  let generation = 1, exchanges = 0, executed = 0
  const base = await fixture(t, (req, res) => {
    if (req.url === '/api/augmentor/auth') {
      assert.equal(req.headers['x-augmentor-token'], 'local-action-secret')
      exchanges++; res.end(JSON.stringify({ token: 'launch-token' })); return
    }
    if (req.url === '/?token=launch-token') {
      res.writeHead(303, { 'set-cookie': `dsh-auth-test=cookie${generation}; HttpOnly; Path=/`, location: '/' }); res.end(); return
    }
    if (req.headers.cookie !== `dsh-auth-test=cookie${generation}`) { res.writeHead(401); res.end(); return }
    if (req.url.startsWith('/api/')) executed++
    res.end('{}')
  })
  const client = createDshClient(base, 'local-action-secret')
  await Promise.all([client.fetch('/api/session/prompt'), client.fetch('/api/session/list')])
  assert.equal(exchanges, 1); assert.equal(executed, 2)
  assert.deepEqual(await client.websocketHeaders(), { cookie: 'dsh-auth-test=cookie1' })
  generation++
  assert.equal((await client.fetch('/api/session/prompt')).status, 200)
  assert.equal(exchanges, 2); assert.equal(executed, 3)
})

test('does not replay commands after a server error or follow a redirect carrying credentials', async t => {
  let calls = 0
  const base = await fixture(t, (req, res) => {
    calls++; res.writeHead(req.url.endsWith('redirect') ? 307 : 500, { location: 'http://example.com/' }); res.end()
  })
  const client = createDshClient(base, 'secret')
  assert.equal((await client.fetch('/api/error', { method: 'POST' })).status, 500)
  assert.equal((await client.fetch('/api/redirect', { method: 'POST' })).status, 307)
  assert.equal(calls, 2)
})

test('missing or outdated plugin produces an actionable authentication failure', async t => {
  const base = await fixture(t, (req, res) => { res.writeHead(req.url === '/api/augmentor/auth' ? 404 : 401); res.end() })
  await assert.rejects(createDshClient(base, 'secret').fetch('/api/session/list'), /update both the Augmentor plugin and extension/)
})

test('rejects non-loopback origins and credentials embedded in URLs', () => {
  for (const base of ['https://example.com', 'http://localhost.evil.test', 'http://user:secret@127.0.0.1', 'file:///tmp/dsh', 'http://127.0.0.1/path']) {
    assert.throws(() => createDshClient(base, 'secret'), /loopback/)
  }
})
