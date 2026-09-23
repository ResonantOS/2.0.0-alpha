import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
const credentialsModule = await import('../host/harness-credentials.mjs').catch(() => ({}));
const transportModule = await import('../host/harness-transport.mjs').catch(() => ({}));
const canary = () => randomBytes(24).toString('base64url');
async function make(endpoint, options = {}) {
  assert.equal(typeof transportModule.createHarnessTransport, 'function', 'authenticated pinned harness transport must exist');
  const runtime = { adapterId: 'dsh-typert-v1', authScheme: 'dsh-action-token', credentialBinding: 'dsh.main', endpoint };
  const credentials = credentialsModule.createHarnessCredentials({ bindings: [{ name: 'dsh.main', addonId: 'addon.dsh', ...runtime, endpoint: options.approvedEndpoint ?? endpoint, source: { env: 'DSH_AUGMENTOR_WS_TOKEN' } }], env: { DSH_AUGMENTOR_WS_TOKEN: options.actionToken ?? canary() } });
  return transportModule.createHarnessTransport({ credentials, addonId: 'addon.dsh', runtime, ...options });
}
async function server(t, handler) {
  const instance = createServer(handler), sockets = new Set();
  instance.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => instance.close(resolve)); });
  return { instance, endpoint: `http://127.0.0.1:${instance.address().port}` };
}
function authentication(action, launch, cookie, seen) {
  return (req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/api/augmentor/auth') {
      if (req.headers['x-augmentor-token'] !== action) { res.writeHead(403).end(); return; }
      res.end(JSON.stringify({ token: launch })); return;
    }
    if (req.url === `/?token=${launch}`) { res.writeHead(303, { 'set-cookie': `${cookie}; HttpOnly; Path=/`, location: '/' }).end(); return; }
    if (req.headers.cookie !== cookie) { res.writeHead(401).end(); return; }
    res.end(req.url === '/' ? '' : JSON.stringify({ ok: true, text: `${action} ${launch} ${cookie}` }));
  };
}

test('authenticated HTTP and built-in websocket use host-only action token and session cookie', async t => {
  const action = canary(), launch = canary(), cookie = `dsh-auth-test=${canary()}`, seen = [];
  const { instance, endpoint } = await server(t, authentication(action, launch, cookie, seen));
  let upgrade;
  instance.on('upgrade', (req, socket) => {
    upgrade = req;
    if (req.headers.cookie !== cookie || req.headers['x-augmentor-token'] !== action) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const transport = await make(endpoint, { actionToken: action }); t.after(() => transport.dispose());
  const result = await transport.request('/api/session/list', { body: { request: {} } });
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  for (const value of [action, launch, cookie]) assert.ok(!JSON.stringify(result).includes(value));
  const stream = await transport.openStream();
  assert.equal(upgrade.url, '/api/remote.mux');
  assert.equal(upgrade.headers.cookie, cookie);
  assert.equal(upgrade.headers['x-augmentor-token'], action);
  assert.equal(seen.filter(req => req.url === '/api/augmentor/auth').length, 1);
  assert.equal(seen.filter(req => req.url === '/api/session/list').length, 2, 'retry only the explicit unauthenticated rejection');
  assert.ok(seen.filter(req => req.url !== `/?token=${launch}`).every(req => !req.url.includes(action) && !req.url.includes(launch)));
  assert.equal(JSON.stringify(transport), '{}');
  stream.close();
});

for (const oversized of ['probe', 'exchange']) {
  test(`authorization cancels an oversized ${oversized} body and subsequent bounded requests work`, async t => {
    const action = canary(), launch = canary(), cookie = `dsh-auth-test=${canary()}`, seen = [];
    const maxResponseBytes = 4096, oversizedBody = 'x'.repeat(maxResponseBytes * 3);
    const auth = authentication(action, launch, cookie, seen);
    let oversizedResponses = 0;
    const { endpoint } = await server(t, (req, res) => {
      if (oversized === 'probe' && req.method === 'GET' && req.url === '/') {
        oversizedResponses++;
        res.writeHead(200).end(oversizedBody); return;
      }
      if (oversized === 'exchange' && req.url === `/?token=${launch}`) {
        oversizedResponses++;
        res.writeHead(303, { 'set-cookie': `${cookie}; HttpOnly; Path=/`, location: '/' }).end(oversizedBody); return;
      }
      auth(req, res);
    });
    const { WebSocketImpl } = fakeNetwork(action, launch, cookie);
    const transport = await make(endpoint, { actionToken: action, maxResponseBytes, WebSocketImpl });
    t.after(() => transport.dispose());
    // openStream invokes the private authorize(), including a second probe with the session cookie.
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.doesNotReject(async () => { (await transport.openStream()).close(); },
        `authorize must accept an oversized ${oversized} body`);
      const result = await transport.request('/api/session/list');
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
    }
    assert.equal(oversizedResponses, oversized === 'probe' ? 2 : 1);
    assert.equal(seen.filter(req => req.url === '/api/augmentor/auth').length, 1);
  });
}

test('HTTP and websocket destinations remain pinned and DNS is re-resolved', async t => {
  const seen = [], action = canary(), launch = canary(), cookie = `dsh-auth-test=${canary()}`;
  const { endpoint } = await server(t, authentication(action, launch, cookie, seen));
  const hostname = endpoint.replace('127.0.0.1', 'localhost');
  let answers = [{ address: '127.0.0.1', family: 4 }], resolutions = 0;
  const transport = await make(hostname, { actionToken: action, lookup: async () => { resolutions++; return answers; } });
  t.after(() => transport.dispose());
  assert.equal((await transport.request('/api/session/list')).status, 200);
  assert.ok(resolutions >= 4, 'each auth and API connection resolves anew');
  const count = seen.length;
  for (const bad of [[{ address: '203.0.113.1', family: 4 }], [{ address: '127.0.0.1', family: 4 }, { address: '::2', family: 6 }], []]) {
    answers = bad;
    await assert.rejects(transport.request('/api/session/list'), { code: 'permission-denied' });
    await assert.rejects(transport.openStream(), { code: 'permission-denied' });
    assert.equal(seen.length, count, 'forbidden DNS causes zero upstream requests');
  }
  for (const proposed of ['http://203.0.113.1:3080', endpoint.replace(/:\d+$/, ':1'), `${endpoint}/path`, `${endpoint}/?token=x`]) {
    await assert.rejects(make(proposed, { approvedEndpoint: endpoint }), { code: 'permission-denied' });
  }
  await assert.rejects(make('http://203.0.113.1:3080'), { code: 'permission-denied' });
});

test('HTTP, authentication, and websocket redirects never reach another server', async t => {
  let prohibited = 0;
  const other = await server(t, (_req, res) => { prohibited++; res.end('{}'); });
  other.instance.on('upgrade', (_req, socket) => { prohibited++; socket.destroy(); });
  const action = canary(), launch = canary(), cookie = `dsh-auth-test=${canary()}`, seen = [];
  let mode = 'http';
  const auth = authentication(action, launch, cookie, seen);
  const source = await server(t, (req, res) => {
    if ((mode === 'http' && req.url === '/api/session/list') || (mode === 'auth' && req.url === '/api/augmentor/auth')) {
      res.writeHead(302, { location: `${other.endpoint}/api/session/list` }).end(); return;
    }
    auth(req, res);
  });
  source.instance.on('upgrade', (_req, socket) => socket.end(`HTTP/1.1 302 Found\r\nLocation: ${other.endpoint.replace('http', 'ws')}/api/remote.mux\r\nContent-Length: 0\r\n\r\n`));
  for (const current of ['http', 'auth', 'ws']) {
    mode = current;
    const transport = await make(source.endpoint, { actionToken: action });
    try { await assert.rejects(current === 'ws' ? transport.openStream() : transport.request('/api/session/list'), { code: 'runtime-unavailable' }); }
    finally { transport.dispose(); }
  }
  assert.equal(prohibited, 0);
});

test('unknown outcomes are never retried, routes and request credentials cannot be overridden', async () => {
  let calls = 0;
  const transport = await make('http://127.0.0.1:3080', { fetchImpl: async () => { calls++; throw new Error(canary()); } });
  await assert.rejects(transport.request('/api/session/prompt', { body: { text: 'hello' } }), { code: 'runtime-unavailable' });
  assert.equal(calls, 1);
  for (const route of ['//example.com/api/session/list', '/api/session/../augmentor/auth', '/api/augmentor/auth', '/api/session/history', '/api/session/list?token=x']) {
    await assert.rejects(transport.request(route), { code: 'permission-denied' });
  }
  await assert.rejects(transport.request('/api/session/list', { headers: { cookie: 'override' } }), { code: 'permission-denied' });
  assert.equal(calls, 1);
  transport.dispose();
  await assert.rejects(transport.request('/api/session/list'), { code: 'runtime-unavailable' });
});

test('401 retry is bounded; oversized auth and API bodies are rejected', async () => {
  let calls = 0;
  const transport = await make('http://127.0.0.1:3080', { fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } });
  await assert.rejects(transport.request('/api/session/prompt'), { code: 'runtime-unavailable' });
  assert.equal(calls, 3, 'API rejection, probe, auth rejection; no mutation replay');
  transport.dispose();
  for (const auth of [false, true]) {
    const big = await make('http://127.0.0.1:3080', { maxResponseBytes: 128, fetchImpl: async url => new Response(JSON.stringify({ ok: true, pad: 'x'.repeat(384) }), { status: auth && !String(url).includes('/api/augmentor/auth') ? 401 : 200 }) });
    await assert.rejects(auth ? big.openStream() : big.request('/api/session/list'), { code: 'runtime-unavailable' });
    big.dispose();
  }
});

function fakeNetwork(action, launch, cookie) {
  const requests = [], upgrades = [], sockets = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), ...options });
    assert.equal(options.redirect, 'manual');
    assert.equal(new URL(url).hostname, '127.0.0.1', 'connect to validated address, without a second DNS lookup');
    if (new URL(url).pathname === '/api/augmentor/auth') {
      assert.equal(options.method, 'POST'); assert.equal(options.headers['x-augmentor-token'], action);
      return Response.json({ token: launch });
    }
    if (new URL(url).searchParams.get('token') === launch) return new Response(null, { status: 303, headers: { 'set-cookie': `${cookie}; HttpOnly`, location: '/' } });
    if (options.headers.cookie !== cookie) return new Response(null, { status: 401 });
    return Response.json({ text: `${action} ${launch} ${cookie}`, ok: true });
  };
  class WebSocketImpl extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    constructor(url, options) {
      super(); upgrades.push({ url: String(url), ...options }); sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    send() {}
  }
  return { fetchImpl, WebSocketImpl, requests, upgrades, sockets };
}

for (const oversized of ['probe', 'exchange']) {
  test(`injected oversized ${oversized} response is canceled without reading`, async t => {
    const action = canary(), launch = canary(), cookie = `dsh-auth-test=${canary()}`;
    const network = fakeNetwork(action, launch, cookie);
    let canceled = 0, reads = 0;
    const transport = await make('http://127.0.0.1:3080', { ...network, actionToken: action, maxResponseBytes: 4096,
      fetchImpl: async (url, options) => {
        const response = await network.fetchImpl(url, options);
        if (oversized === 'probe' ? new URL(url).pathname !== '/' || new URL(url).search : !new URL(url).search) return response;
        const large = new Response('x'.repeat(4096 * 3), {
          status: oversized === 'probe' ? 200 : response.status, headers: response.headers,
        });
        const cancel = large.body.cancel.bind(large.body), getReader = large.body.getReader.bind(large.body);
        large.body.cancel = (...args) => { canceled++; return cancel(...args); };
        large.body.getReader = (...args) => { reads++; return getReader(...args); };
        return large;
      },
    });
    t.after(() => transport.dispose());
    await assert.doesNotReject(async () => { (await transport.openStream()).close(); },
      `authorize must accept an oversized ${oversized} body`);
    assert.equal((await transport.request('/api/session/list')).body.ok, true);
    assert.equal(canceled, 1);
    assert.equal(reads, 0);
  });
}

test('injected transport proves auth exchange, redaction and fresh DNS on both transports', async () => {
  const action = canary(), launch = canary(), cookie = `dsh-auth-test=${canary()}`;
  const network = fakeNetwork(action, launch, cookie);
  let resolutions = 0, answers = [{ address: '127.0.0.1', family: 4 }];
  const transport = await make('http://localhost:3080', { ...network, actionToken: action, lookup: async () => { resolutions++; return answers; } });
  try {
    const result = await transport.request('/api/session/list');
    assert.equal(result.body.ok, true);
    for (const value of [action, launch, cookie]) assert.ok(!JSON.stringify(result).includes(value));
    const messages = [], errors = [];
    await transport.openStream({ onMessage: value => messages.push(value), onError: error => errors.push(error) });
    assert.equal(network.upgrades[0].url, 'ws://127.0.0.1:3080/api/remote.mux');
    assert.equal(network.upgrades[0].headers.cookie, cookie);
    assert.equal(network.upgrades[0].headers['x-augmentor-token'], action);
    assert.equal(resolutions, network.requests.length + network.upgrades.length);
    network.sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ text: launch }) }));
    assert.equal(messages[0].text, '[redacted]');
    network.sockets[0].dispatchEvent(new MessageEvent('message', { data: `invalid ${launch}` }));
    assert.equal(errors[0].code, 'runtime-unavailable');
    assert.ok(!String(errors[0]).includes(launch));
    const count = network.requests.length;
    for (const bad of [[{ address: '203.0.113.1', family: 4 }], [{ address: '127.0.0.1', family: 4 }, { address: '::2', family: 6 }], []]) {
      answers = bad;
      await assert.rejects(transport.request('/api/session/list'), { code: 'permission-denied' });
      await assert.rejects(transport.openStream(), { code: 'permission-denied' });
    }
    assert.equal(network.requests.length, count); assert.equal(network.upgrades.length, 1);
    for (const endpoint of ['http://127.0.0.1:3081', 'http://203.0.113.1:3080', 'http://localhost:3080/path']) {
      await assert.rejects(make(endpoint, { approvedEndpoint: 'http://localhost:3080', ...network }), { code: 'permission-denied' });
    }
    await assert.rejects(make('http://203.0.113.1:3080', network), { code: 'permission-denied' });
  } finally { transport.dispose(); }
});

test('HTTP/auth redirects, unsafe exchange location, abort and deadline fail closed', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const transport = await make('http://127.0.0.1:3080', { fetchImpl: async () => { calls++; return new Response(null, { status, headers: { location: 'http://203.0.113.1/' } }); } });
    await assert.rejects(transport.request('/api/session/list'), { code: 'runtime-unavailable' });
    assert.equal(calls, 1); transport.dispose();
  }
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const transport = await make('http://localhost:3080', { timeoutMs: 20, lookup: () => new Promise(() => {}), fetchImpl: async () => { calls++; return Response.json({}); } });
  await assert.rejects(transport.request('/api/session/list', { signal: controller.signal }));
  await assert.rejects(transport.request('/api/session/list'), { code: 'deadline-exceeded' });
  assert.equal(calls, 0); transport.dispose();
});

test('websocket destination is rechecked after authentication, and closed streams reject late output', async () => {
  const action = canary(), launch = canary(), cookie = `dsh-auth-test=${canary()}`;
  const network = fakeNetwork(action, launch, cookie);
  let lookups = 0;
  const transport = await make('http://localhost:3080', { ...network, actionToken: action,
    lookup: async () => [{ address: ++lookups === 4 ? '203.0.113.1' : '127.0.0.1', family: 4 }] });
  await assert.rejects(transport.openStream(), { code: 'permission-denied' });
  assert.equal(network.requests.length, 3); assert.equal(network.upgrades.length, 0);
  const messages = [], signal = new AbortController();
  const stream = await transport.openStream({ signal: signal.signal, onMessage: frame => messages.push(frame) });
  signal.abort();
  network.sockets[0].dispatchEvent(new MessageEvent('message', { data: '{"late":true}' }));
  assert.equal(messages.length, 0); assert.equal(network.sockets[0].readyState, 3);
  assert.throws(() => stream.send({ type: 'open' }), { code: 'runtime-unavailable' });
  transport.dispose();
});

test('authentication redirects and malformed exchange credentials cannot open a websocket', async () => {
  for (const problem of ['bootstrap-redirect', 'exchange-origin', 'missing-cookie', 'bad-token']) {
    const action = canary(), launch = canary(), cookie = `dsh-auth-test=${canary()}`;
    const network = fakeNetwork(action, launch, cookie);
    const fetchImpl = async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/api/augmentor/auth' && problem === 'bootstrap-redirect') return new Response(null, { status: 302, headers: { location: 'http://203.0.113.1/' } });
      if (path === '/api/augmentor/auth' && problem === 'bad-token') return Response.json({ token: 'bad\r\nheader' });
      if (new URL(url).search && problem === 'exchange-origin') return new Response(null, { status: 303, headers: { location: 'http://127.0.0.1:9999/', 'set-cookie': cookie } });
      if (new URL(url).search && problem === 'missing-cookie') return new Response(null, { status: 303, headers: { location: '/' } });
      return network.fetchImpl(url, options);
    };
    const transport = await make('http://127.0.0.1:3080', { ...network, fetchImpl, actionToken: action });
    await assert.rejects(transport.openStream(), { code: 'runtime-unavailable' });
    assert.equal(network.upgrades.length, 0); transport.dispose();
  }
});

test('DSH transport refuses an approved binding for another adapter or authentication scheme', async () => {
  for (const override of [{ adapterId: 'openai-compatible-v1' }, { authScheme: 'bearer' }]) {
    const runtime = { adapterId: 'dsh-typert-v1', authScheme: 'dsh-action-token', credentialBinding: 'dsh.main', endpoint: 'http://127.0.0.1:3080', ...override };
    const credentials = credentialsModule.createHarnessCredentials({ bindings: [{ name: 'dsh.main', addonId: 'addon.dsh', ...runtime, source: { env: 'TOKEN' } }], env: { TOKEN: canary() } });
    await assert.rejects(transportModule.createHarnessTransport({ credentials, addonId: 'addon.dsh', runtime }), { code: 'permission-denied' });
  }
});
