import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHarnessTransport } from '../host/harness-transport.mjs';
const runtime = { adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081', credentialBinding: 'dsh.native' };
function credentials() {
  const loginToken = randomBytes(24).toString('base64url');
  let cookie = '', generation = 0, failure = 0, disposed = false;
  const signal = new AbortController().signal;
  return { loginToken, failed: () => failure,
    async acquire() { return { epoch: 'epoch', signal, deadline: Date.now() + 30000, version: '0.2.0-rc.2',
      async use(fn) { assert.equal(disposed, false); return fn({ endpoint: runtime.endpoint, loginToken, cookie, generation }); },
      async authenticate(exchange, { refresh = false } = {}) { if (!cookie || refresh) { cookie = await exchange({ endpoint: runtime.endpoint, loginToken, signal }); generation++; } },
      remember() {}, sanitize: value => value, ready() {}, fail() { failure++; },
      cleanupUse(fn, cleanupSignal) { if (cleanupSignal.aborted || !cookie) throw new Error('cleanup unavailable'); return fn(cookie); },
      dispose() { disposed = true; },
    }; },
  };
}
async function fixture(headers = { 'set-cookie': 'dsh-auth-test=synthetic; HttpOnly', location: '/' }, exchangeStatus = 303, socketOutcomes = [], limits = {}, { cancelHang = false } = {}) {
  const creds = credentials(), calls = [], sockets = [];
  let statuses = [], promptCalls = 0, responseBody = { ok: true };
  class Socket extends EventTarget {
    bufferedAmount = 0;
    constructor(url, options) { super(); sockets.push({ url: String(url), options, socket: this }); const outcome = socketOutcomes.shift() ?? 'open';
      if (outcome === 'denied') throw Object.assign(new Error('synthetic guard denial'), { code: 'permission-denied' });
      if (outcome === 'constructor-failure') throw new Error('synthetic constructor failure');
      if (outcome === 'hold') return;
      queueMicrotask(() => { const event = new Event(outcome.startsWith('status-') ? 'error' : outcome); if (outcome.startsWith('status-')) event.status = Number(outcome.slice(7)); this.dispatchEvent(event); }); }
    close() {} send() {}
  }
  const transport = await createHarnessTransport({ credentials: creds, addonId: 'addon.native', runtime, signal: new AbortController().signal, WebSocketImpl: Socket, ...limits,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (new URL(url).search) return new Response(null, { status: exchangeStatus, headers });
      if (new URL(url).pathname === '/api/session/prompt') promptCalls++;
      if (new URL(url).pathname === '/api/session/cancel' && cancelHang) return new Promise(() => {});
      const status = statuses.shift() ?? 200;
      if (status === 'lost') throw new Error('synthetic uncertain result');
      return Response.json(responseBody, { status });
    },
  });
  return { transport, calls, sockets, creds, statuses: value => { statuses = value; }, responseBody: value => { responseBody = value; }, promptCalls: () => promptCalls };
}
test('native exchanges before RPC, uses cookie only, refuses plugin route', async () => {
  const f = await fixture();
  await f.transport.request('/api/session/modelCatalog');
  await f.transport.openStream();
  assert.equal(f.calls.filter(c => c.url.includes('?token=')).length, 1);
  assert.ok(f.calls[0].url.includes('?token='));
  assert.ok(f.calls.every(c => !c.url.includes('/augmentor') && !('x-augmentor-token' in c.options.headers)));
  assert.deepEqual(f.sockets[0].options.headers, { cookie: 'dsh-auth-test=synthetic' });
  await assert.rejects(f.transport.request('/api/augmentor'), { code: 'permission-denied' });
  await f.transport.dispose();
});
for (const setCookie of ['', 'dsh-auth-test=bad value', 'dsh-auth-test=x; Max-Age=0', 'dsh-auth-test=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'dsh-auth-test=' + 'x'.repeat(8192)]) {
  test('reject invalid native cookie ' + setCookie.length, async () => {
    const f = await fixture({ 'set-cookie': setCookie });
    await assert.rejects(f.transport.authenticate()); await f.transport.dispose();
  });
}
test('only one explicit 401 retry; 5xx and uncertain prompt never replay', async () => {
  const f = await fixture(); await f.transport.authenticate();
  f.statuses([401, 200]); await f.transport.request('/api/session/prompt'); assert.equal(f.promptCalls(), 2);
  f.statuses([503]); await assert.rejects(f.transport.request('/api/session/prompt')); assert.equal(f.promptCalls(), 3);
  f.statuses([401, 401]); await assert.rejects(f.transport.request('/api/session/prompt')); assert.equal(f.promptCalls(), 5); assert.equal(f.creds.failed(), 1);
  await f.transport.dispose();
});
test('only exact 303 root redirect with one live auth cookie is accepted', async () => {
  for (const [headers, status] of [
    [{ 'set-cookie': 'dsh-auth-test=x', location: '/' }, 200],
    [{ 'set-cookie': 'dsh-auth-test=x', location: '/' }, 302],
    [{ 'set-cookie': 'dsh-auth-test=x', location: 'http://evil.invalid/' }, 303],
    [{ 'set-cookie': 'dsh-auth-test=x', location: '/other' }, 303],
    [[['set-cookie', 'dsh-auth-one=x'], ['set-cookie', 'dsh-auth-two=y']], 303],
    [{ 'set-cookie': 'dsh-auth-test=x; Max-Age=1; Max-Age=2' }, 303],
  ]) { const f = await fixture(headers, status); await assert.rejects(f.transport.authenticate()); await f.transport.dispose(); }
});
test('native exchange accepts an absent Location with one valid auth cookie', async () => {
  const f = await fixture({ 'set-cookie': 'dsh-auth-test=synthetic' });
  await f.transport.authenticate();
  await f.transport.request('/api/session/modelCatalog');
  assert.equal(f.calls.filter(call => call.url.includes('?token=')).length, 1);
  await f.transport.dispose();
});
test('uncertain prompt response is sent only once', async () => {
  const f = await fixture(); await f.transport.authenticate(); f.statuses(['lost']);
  await assert.rejects(f.transport.request('/api/session/prompt')); assert.equal(f.promptCalls(), 1);
  assert.equal(f.calls.filter(call => call.url.includes('?token=')).length, 1); await f.transport.dispose();
});
for (const outcome of ['denied', 'constructor-failure', 'status-503']) test(`WS ${outcome} never runs an auth diagnostic`, async () => {
  const f = await fixture(undefined, 303, [outcome]); await f.transport.authenticate();
  // A tempting diagnostic 401 must never be requested in these cases.
  f.statuses([401]);
  await assert.rejects(f.transport.openStream(), { code: outcome === 'denied' ? 'permission-denied' : 'runtime-unavailable' });
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/api/session/modelCatalog').length, 0);
  assert.equal(f.calls.filter(call => call.url.includes('?token=')).length, 1);
  await f.transport.dispose();
});
for (const diagnostic of [200, 401, 503]) test(`generic WS failure diagnoses ${diagnostic} without guessing auth`, async () => {
  const f = await fixture(undefined, 303, ['error', 'open']); await f.transport.authenticate(); f.statuses([diagnostic]);
  if (diagnostic === 401) { const stream = await f.transport.openStream(); stream.close(); assert.equal(f.sockets.length, 2); }
  else { await assert.rejects(f.transport.openStream()); assert.equal(f.sockets.length, 1); }
  assert.equal(f.promptCalls(), 0);
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/api/session/modelCatalog').length, 1);
  assert.equal(f.calls.filter(call => call.url.includes('?token=')).length, diagnostic === 401 ? 2 : 1);
  await f.transport.dispose();
});
test('observed handshake 401 refreshes once without a diagnostic; a second 401 fences the epoch', async () => {
  const f = await fixture(undefined, 303, ['status-401', 'open']); await f.transport.authenticate();
  const stream = await f.transport.openStream(); stream.close();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.calls.filter(call => call.url.includes('?token=')).length, 2);
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/api/session/modelCatalog').length, 0);
  await f.transport.dispose();

  const twice = await fixture(undefined, 303, ['status-401', 'status-401']); await twice.transport.authenticate();
  await assert.rejects(twice.transport.openStream(), { code: 'runtime-unavailable' });
  assert.equal(twice.sockets.length, 2);
  assert.equal(twice.creds.failed(), 1);
  assert.equal(twice.calls.filter(call => new URL(call.url).pathname === '/api/session/modelCatalog').length, 0);
  await twice.transport.dispose();
});
for (const replacement of ['status-503', 'constructor-failure']) test(`refreshed WS replacement ${replacement} fails only its opening`, async () => {
  const f = await fixture(undefined, 303, ['status-401', replacement, 'open']); await f.transport.authenticate();
  await assert.rejects(f.transport.openStream(), { code: 'runtime-unavailable' });
  assert.equal(f.sockets.length, 2, 'one replacement only');
  assert.equal(f.creds.failed(), 0, 'non-auth replacement failure leaves epoch live');
  const stream = await f.transport.openStream(); stream.close();
  assert.equal(f.promptCalls(), 0, 'no prompt replay');
  await f.transport.dispose();
});
for (const diagnosticStatus of [401, 503]) test(`opaque refreshed WS replacement diagnostic ${diagnosticStatus} has exact auth scope`, async () => {
  const f = await fixture(undefined, 303, ['status-401', 'error', 'open']); await f.transport.authenticate();
  f.statuses([diagnosticStatus]);
  await assert.rejects(f.transport.openStream(), { code: 'runtime-unavailable' });
  assert.equal(f.sockets.length, 2, 'opaque replacement never opens a third socket');
  assert.equal(f.creds.failed(), diagnosticStatus === 401 ? 1 : 0, 'epoch fence requires confirmed second 401');
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/api/session/modelCatalog').length, 1, 'one read-only diagnostic');
  if (diagnosticStatus === 503) { const stream = await f.transport.openStream(); stream.close(); }
  await f.transport.dispose();
});
test('caller cancellation during refreshed WS replacement leaves epoch live', async () => {
  const f = await fixture(undefined, 303, ['status-401', 'hold', 'open']); await f.transport.authenticate();
  const caller = new AbortController();
  const opening = f.transport.openStream({ signal: caller.signal });
  for (let i = 0; f.sockets.length < 2 && i < 50; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sockets.length, 2, 'replacement opening reached before caller cancellation');
  caller.abort();
  await assert.rejects(opening, { code: 'runtime-unavailable' });
  assert.equal(f.creds.failed(), 0, 'caller cancellation cannot fence shared runtime');
  const stream = await f.transport.openStream(); stream.close();
  await f.transport.dispose();
});
test('owned-session cleanup is limited to one second and refuses another session ID', async () => {
  const f = await fixture(undefined, 303, [], {}, { cancelHang: true }); await f.transport.authenticate();
  const owned = 'resonantos-00000000-0000-4000-8000-000000000001';
  f.transport.bindSession(owned);
  assert.throws(() => f.transport.cancelOwnedSession('resonantos-00000000-0000-4000-8000-000000000002'), { code: 'permission-denied' });
  const started = Date.now();
  await assert.rejects(f.transport.cancelOwnedSession(owned), { code: 'runtime-unavailable' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 1800, `cleanup must expire near one second, observed ${elapsed}ms`);
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/api/session/cancel').length, 1, 'no cleanup retry');
  await f.transport.dispose();
});
test('native request and socket byte limits reject valid oversized JSON in both directions', async () => {
  const f = await fixture(undefined, 303, [], { maxResponseBytes: 128, maxMessageBytes: 128 });
  await f.transport.authenticate();
  await assert.rejects(f.transport.request('/api/session/list', { body: { pad: 'x'.repeat(256) } }), { code: 'permission-denied' });
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/api/session/list').length, 0);
  f.responseBody({ pad: 'x'.repeat(256) });
  await assert.rejects(f.transport.request('/api/session/list'), { code: 'runtime-unavailable' });
  f.responseBody({ ok: true });
  const errors = [];
  const stream = await f.transport.openStream({ onError: error => errors.push(error) });
  assert.throws(() => stream.send({ pad: 'x'.repeat(256) }), { code: 'runtime-unavailable' });
  const inbound = await f.transport.openStream({ onError: error => errors.push(error) });
  f.sockets.at(-1).socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ pad: 'x'.repeat(256) }) }));
  assert.equal(errors.length, 1, 'oversized inbound JSON must report one error');
  assert.equal(errors[0].code, 'runtime-unavailable');
  inbound.close();
  await f.transport.dispose();
});

import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { getGlobalDispatcher, setGlobalDispatcher, ProxyAgent } from 'undici';
import { createHarnessCredentials as realCredentials } from '../host/harness-credentials.mjs';
test('both DSH schemes bypass hostile environment and global proxies for real HTTP and WS', async () => {
  let proxyTraffic = 0, directHttp = 0, upgrades = 0;
  const sockets = new Set();
  const sink = createHttpServer((request, response) => { proxyTraffic++; response.writeHead(502); response.end(); });
  sink.on('connect', (_request, socket) => { proxyTraffic++; socket.destroy(); });
  sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
  const token = randomBytes(24).toString('base64url'), cookie = `dsh-auth-local=${randomBytes(24).toString('base64url')}`;
  const server = createHttpServer(async (request, response) => {
    directHttp++; request.resume();
    if (request.url.startsWith('/?token=')) { response.writeHead(303, { location: '/', 'set-cookie': cookie }); response.end(); return; }
    if (request.url === '/api/augmentor/auth') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ token })); return; }
    if (request.headers.cookie !== cookie) { response.writeHead(401); response.end(); return; }
    response.setHeader('content-type', 'application/json'); response.end('{}');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket) => {
    if (request.headers.cookie !== cookie) { socket.destroy(); return; }
    upgrades++;
    const key = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  assert.notEqual(server.address().port, 19387); assert.notEqual(sink.address().port, 19387);
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const savedDispatcher = getGlobalDispatcher(), proxy = new ProxyAgent(`http://127.0.0.1:${sink.address().port}`);
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) if (name.toLowerCase().endsWith('_proxy') && !name.toLowerCase().startsWith('no_')) process.env[name] = `http://127.0.0.1:${sink.address().port}`;
    delete process.env.NO_PROXY; delete process.env.no_proxy; process.env.NODE_USE_ENV_PROXY = '1'; setGlobalDispatcher(proxy);
    for (const authScheme of ['dsh-native-cookie', 'dsh-action-token']) {
      const selected = { ...runtime, endpoint, authScheme }, lifetime = new AbortController();
      const custody = realCredentials({ bindings: [{ name: selected.credentialBinding, addonId: 'addon.native', adapterId: selected.adapterId, authScheme, endpoint,
        source: authScheme === 'dsh-native-cookie' ? { managedDsh: true } : { env: 'SYNTHETIC_TOKEN' } }], env: { SYNTHETIC_TOKEN: token },
        nativeRuntime: { acquire: async () => ({ epoch: 'proxy-test', signal: lifetime.signal, deadline: Date.now() + 30000, version: '0.2.0-rc.2',
          use: fn => fn({ endpoint, loginToken: token }), ready() {}, fail() { lifetime.abort(); }, release() {} }) } });
      const transport = await createHarnessTransport({ credentials: custody, addonId: 'addon.native', runtime: selected, signal: lifetime.signal, timeoutMs: 1000 });
      let failure;
      try { await transport.request('/api/session/modelCatalog'); const stream = await transport.openStream(); stream.close(); }
      catch (error) { failure = error; }
      finally { await transport.dispose(); }
      assert.equal(proxyTraffic, 0, 'proxy must never receive DSH credentials or requests');
      assert.equal(failure, undefined, 'real direct connectors must complete HTTP and upgrade');
    }
    assert.equal(upgrades, 2); assert.ok(directHttp >= 4);
  } finally {
    setGlobalDispatcher(savedDispatcher); for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    for (const socket of sockets) socket.destroy(); await proxy.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => sink.close(resolve))]);
  }
});
