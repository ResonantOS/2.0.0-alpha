// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { createRemoteAdapter } from '../shared/dsh-remote.mjs'

test('Typert requests and streamed session events preserve the extension contract', async t => {
  const calls = [], notices = [], sockets = []
  const event = { type: 'assistant/message', seq: 2, time: 1, data: { message: { content: [{ type: 'text', text: 'hello' }] } } }
  let followSocket
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk
    const message = JSON.parse(data)
    calls.push(message)
    assert.equal(req.url, `/api/${message.method}`)
    let value = {}
    if (message.method === 'session/list') value = { items: [{ sessionId: 's', projections: { values: { title: 'Saved title' } } }] }
    if (message.method === 'session/page') value = { records: [{ type: 'event', event }], hasMore: false }
    if (message.method === 'session/prompt') {
      assert(followSocket, 'follow must be established before admitting a prompt')
      assert.equal(typeof message.payload.args.request.requestId, 'string')
      followSocket.send(JSON.stringify({ type: 'item', streamId: 'augmentor', value: { type: 'event', event } }))
      value = { accepted: true }
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }))
  })
  const wss = new WebSocketServer({ server, path: '/api/remote.mux' })
  wss.on('connection', socket => {
    sockets.push(socket)
    socket.on('message', raw => {
      const message = JSON.parse(String(raw))
      assert.equal(message.endpoint, 'session/follow')
      assert.deepEqual(message.payload.args.request.address, { kind: 'session', sessionId: 's' })
      followSocket = socket
      socket.send(JSON.stringify({ type: 'item', streamId: 'augmentor', value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, header: { id: 's' } } }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const adapter = createRemoteAdapter(base, { fetch: (route, options) => fetch(base + route, options), websocketHeaders: async () => ({}) }, item => notices.push(item))
  t.after(() => { adapter.close(); for (const socket of sockets) socket.terminate(); wss.close(); server.closeAllConnections(); server.close() })
  assert.equal((await adapter.call('session.list')).items[0].title, 'Saved title')
  assert.deepEqual(await adapter.call('session.prompt', { sessionId: 's', mode: 'queue', content: [{ type: 'text', text: 'test' }] }), { accepted: true })
  const history = await adapter.call('session.history', { sessionId: 's' })
  assert.deepEqual(history.events, [{ type: 'event', event }])
  assert.equal(notices[0].method, 'session.event')
  assert.equal(notices[0].params.event.seq, 2)
  await adapter.call('session.cancel', { sessionId: 's' })
  assert.deepEqual(calls.at(-1).payload, { args: { request: { sessionId: 's' } } })
  assert.equal(calls.filter(call => call.method === 'session/prompt').length, 1)
})

test('a command with an unknown network outcome is never retried', async () => {
  let calls = 0
  const adapter = createRemoteAdapter('http://127.0.0.1', { fetch: async () => { calls++; throw new Error('connection lost') } }, () => {})
  await assert.rejects(adapter.call('session.create', { sessionId: 's' }), /connection lost/)
  assert.equal(calls, 1)
  adapter.close()
})

test('host status uses emit frames and unhandled approval waterfalls continue to the DSH UI', async t => {
  const notices = [], replies = [], sockets = []
  const server = createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', socket => {
    sockets.push(socket)
    socket.on('message', () => {
      for (const value of [
        { type: 'ready', clientId: 'client', host: { home: '/test' } },
        { type: 'emit', event: 'api-session/status', args: ['s', true] },
        { type: 'waterfall', event: 'approval/request', eventId: 'approval', agentId: 's', request: {} },
      ]) socket.send(JSON.stringify({ type: 'item', streamId: 'augmentor', value }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const adapter = createRemoteAdapter(`http://127.0.0.1:${server.address().port}`, {
    websocketHeaders: async () => ({}),
    fetch: async (route, options) => {
      const message = JSON.parse(options.body); replies.push({ route, message })
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: {} } })
    },
  }, item => notices.push(item))
  t.after(() => { adapter.close(); for (const socket of sockets) socket.terminate(); wss.close(); server.close() })
  adapter.start()
  for (let i = 0; i < 100 && !replies.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(notices[0].params.status, 'running')
  assert.equal(replies[0].route, '/api/$events/result')
  assert.deepEqual(replies[0].message.payload.args, { clientId: 'client', eventId: 'approval', outcome: { kind: 'next' } })
})
