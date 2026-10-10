import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmbedHostService, readEmbedHostConfig } from '../host/embed-host-service.mjs';
import { startBridgeServer, startBridgeServerWithFallback } from '../host/bridge-server.mjs';

const extensionId = 'cdpdmmalhmokbfcfgogoepnjplaakgnl';
const token = 'test-embed-private-bearer';
const auth = { 'X-ResonantOS-Bridge-Token': 'bridge-test', 'X-ResonantOS-Bridge-Capability-Token': 'cap-test' };
async function fixture(t, { fallback = false, csp = "default-src 'self'; frame-ancestors http://old; script-src 'self'; connect-src 'self'" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ros-embed-test-'));
  const tokenFile = path.join(root, 'token');
  await writeFile(tokenFile, `  ${token}\n`, { mode: 0o600 });
  const seen = [];
  const sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { ...(csp === null ? {} : { 'Content-Security-Policy': csp }), 'Set-Cookie': 'upstream=private', 'Content-Type': 'text/plain' });
    res.end('upstream reply');
  });
  upstream.on('upgrade', (req, socket, head) => {
    seen.push({ url: req.url, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.write('server-first');
    if (head.length) socket.write(head);
    socket.on('data', chunk => socket.write(chunk));
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const env = { RESONANTOS_EMBED_POC: '1', RESONANTOS_EMBED_UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}`, RESONANTOS_EMBED_PROFILE: 'poc', RESONANTOS_EMBED_TOKEN_FILE: tokenFile };
  let now = 1000;
  const service = createEmbedHostService({ env, now: () => now });
  const options = { port: 0, host: '127.0.0.1', bridgeToken: 'bridge-test', bridgeCapabilityTokens: { 'addon-runtime-control': 'cap-test' }, routes: service.embedRoutes, embedService: service };
  const server = fallback ? (await startBridgeServerWithFallback(options)).server : await startBridgeServer(options);
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    service.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]);
    await rm(root, { recursive: true, force: true });
  });
  async function request(url, options = {}) {
    const response = await fetch(origin + url, options);
    const body = await response.text();
    assert.ok(!body.includes(token));
    assert.ok(!JSON.stringify([...response.headers]).includes(token));
    return { response, body };
  }
  async function ticket() {
    const result = await request('/embed/session', { method: 'POST', headers: auth });
    assert.equal(result.response.status, 200);
    const hostPath = JSON.parse(result.body).hostPath;
    assert.match(hostPath, /^\/embed-host\/\?ticket=[A-Za-z0-9_-]{43}$/);
    return hostPath;
  }
  async function session() {
    const result = await request(await ticket());
    assert.equal(result.response.status, 200);
    return { ...result, cookie: result.response.headers.get('set-cookie').split(';')[0] };
  }
  return { env, service, server, origin, seen, request, ticket, session, advance: ms => { now += ms; } };
}

test('embed service is disabled by default without reading credentials', () => {
  const service = createEmbedHostService({ env: {} });
  assert.equal(service.enabled, false);
  assert.deepEqual(service.embedRoutes.map(({ method, path, requiredCapability }) =>
  ({ method, path, requiredCapability })), [
  { method: 'GET', path: '/embed/status', requiredCapability: 'addon-runtime-control' }
]);
  assert.equal(service.matches('/embed/poc/'), false);
  service.close();
});

test('invalid enabled environment is rejected without exposing values', async t => {
  const f = await fixture(t);
  for (const [key, value] of [
    ['RESONANTOS_EMBED_UPSTREAM_URL', 'https://127.0.0.1:1'],
    ['RESONANTOS_EMBED_UPSTREAM_URL', 'http://example.com:1'],
    ['RESONANTOS_EMBED_UPSTREAM_URL', 'http://127.0.0.1:1/path'],
    ['RESONANTOS_EMBED_UPSTREAM_URL', 'http://user:pass@localhost:1'],
    ['RESONANTOS_EMBED_UPSTREAM_URL', 'http://localhost'],
    ['RESONANTOS_EMBED_UPSTREAM_URL', 'http://localhost:70000'],
    ['RESONANTOS_EMBED_PROFILE', '../bad'],
    ['RESONANTOS_EMBED_EXTENSION_ID', '<bad>'],
    ['RESONANTOS_EMBED_TOKEN_FILE', ''],
  ]) assert.throws(() => readEmbedHostConfig({ ...f.env, [key]: value }), /Invalid embed configuration/);
  await writeFile(f.env.RESONANTOS_EMBED_TOKEN_FILE, ' \n ');
  assert.throws(() => createEmbedHostService({ env: f.env }), /Invalid embed credential/);
});

test('session route requires bridge authentication and addon-runtime-control', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/embed/session', { method: 'POST' })).response.status, 401);
  assert.equal((await f.request('/embed/session', { method: 'POST', headers: { 'X-ResonantOS-Bridge-Token': 'bridge-test' } })).response.status, 403);
  assert.equal(f.seen.length, 0);
});

test('tickets are single use and expire at 60 seconds; host page has restricted framing and no credentials', async t => {
  const f = await fixture(t);
  const ticket = await f.ticket();
  const page = await f.request(ticket);
  assert.equal(page.response.status, 200);
  assert.match(page.response.headers.get("set-cookie"), /^ros_embed=[\w-]{43}; HttpOnly; Secure; SameSite=None; Path=\/embed\/$/);
  const csp = page.response.headers.get('content-security-policy');
  assert.match(csp, new RegExp(`frame-ancestors chrome-extension://${extensionId}`));
  assert.match(csp, /default-src 'none'; script-src 'nonce-[\w-]+'; style-src 'unsafe-inline'; frame-src 'self'/);
  assert.match(page.body, /title="Augmentor"/);
  assert.match(page.body, /allow="clipboard-write"/);
  assert.match(page.body, /\/embed\/poc\//);
  assert.equal((await f.request(ticket)).response.status, 403);
  const expired = await f.ticket();
  f.advance(60_000);
  assert.equal((await f.request(expired)).response.status, 403);
});

test('proxy refuses missing cookie, foreign origins and cross/same-site before contacting upstream', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/embed/poc/')).response.status, 403);
  const { cookie } = await f.session();
  for (const headers of [{ origin: 'http://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    assert.equal((await f.request('/embed/poc/', { headers: { cookie, ...headers } })).response.status, 403);
  }
  assert.equal(f.seen.length, 0);
});

test('proxy preserves path/query/body, injects startup bearer, removes client credentials and upstream cookies, rewrites CSP', async t => {
  const f = await fixture(t, { fallback: true });
  const { cookie } = await f.session();
  await writeFile(f.env.RESONANTOS_EMBED_TOKEN_FILE, 'changed-after-startup');
  const url = '/embed/poc/preferences?encoded=%2F&x=1&x=2';
  const result = await f.request(url, { method: 'POST', headers: { cookie: `${cookie}; other=private`, authorization: 'client-secret', origin: f.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...auth }, body: '{"hello":true}' });
  assert.equal(result.response.status, 200);
  assert.equal(f.seen[0].url, url);
  assert.equal(f.seen[0].body, '{"hello":true}');
  assert.equal(f.seen[0].headers.authorization, `Bearer ${token}`);
  assert.equal(f.seen[0].headers.origin, f.origin);
  assert.equal(f.seen[0].headers.host, new URL(f.env.RESONANTOS_EMBED_UPSTREAM_URL).host);
  assert.equal(f.seen[0].headers.cookie, undefined);
  assert.equal(f.seen[0].headers['x-resonantos-bridge-token'], undefined);
  assert.equal(result.response.headers.get('set-cookie'), null);
  assert.equal(result.response.headers.get('content-security-policy'), `default-src 'self'; frame-ancestors ${f.origin} chrome-extension://${extensionId}; script-src 'self'; connect-src 'self'`);
  assert.equal((await f.request('/embed/poc/', { method: 'HEAD', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).body, '');
});

test('POST body over 1 MiB is rejected before upstream contact', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  assert.equal((await f.request('/embed/poc/preferences', { method: 'POST', headers: { cookie, origin: f.origin, 'sec-fetch-site': 'same-origin' }, body: 'a'.repeat(1024 * 1024 + 1) })).response.status, 413);
  assert.equal(f.seen.length, 0);
});

function upgrade(origin, headers, path = "/embed/poc/native?q=%2F") {
  return new Promise((resolve, reject) => {
    const req = http.request(origin, { path, headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } });
    req.on('upgrade', (res, socket, head) => resolve({ res, socket, head }));
    req.on('response', res => { res.resume(); resolve({ res }); });
    req.on('error', reject);
    req.end();
  });
}
test('WebSocket upgrade requires session and exact Origin before contacting upstream', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  for (const headers of [{ origin: f.origin }, { cookie }, { cookie, origin: 'http://evil.test' }, { cookie, origin: f.origin, 'sec-fetch-site': 'same-site' }]) {
    assert.equal((await upgrade(f.origin, headers)).res.statusCode, 403);
  }
  assert.equal(f.seen.length, 0);
});

test('WebSocket tunnels both directions and closes active sockets on service close', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  const { res, socket, head } = await upgrade(f.origin, { cookie, origin: f.origin, authorization: 'client-secret' });
  t.after(() => socket.destroy());
  assert.equal(res.statusCode, 101);
  assert.ok(!JSON.stringify(res.headers).includes(token));
  let received = head.toString();
  socket.on('data', chunk => { received += chunk.toString(); });
  socket.write('client-bytes');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(new Error('tunnel did not echo')); }, 2000);
    const poll = setInterval(() => { if (received.includes('server-first') && received.includes('client-bytes')) { clearTimeout(timeout); clearInterval(poll); resolve(); } }, 10);
  });
  assert.equal(f.seen[0].headers.authorization, `Bearer ${token}`);
  assert.equal(f.seen[0].headers.origin, f.origin);
  assert.equal(f.seen[0].headers.cookie, undefined);
  assert.equal(f.seen[0].url, '/embed/poc/native?q=%2F');
  const closed = once(socket, 'close');
  f.service.close();
  await closed;
});

test('chunked POST over 1 MiB returns 413 without opening upstream', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${f.origin}/embed/poc/preferences`, { method: 'POST', headers: { cookie, origin: f.origin, 'sec-fetch-site': 'same-origin' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('a'.repeat(1024 * 1024));
    req.end('b');
  });
  assert.equal(status, 413);
  assert.equal(f.seen.length, 0);
});


test('host relay allows only the iframe origin/source and four parent command types', async t => {
  const f = await fixture(t);
  const { body } = await f.session();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(body)[1];
  const sentToParent = [];
  const sentToFrame = [];
  const frameWindow = { postMessage: (...args) => sentToFrame.push(args) };
  const parent = { postMessage: (...args) => sentToParent.push(args) };
  const iframe = { contentWindow: frameWindow };
  let listener;
  vm.runInNewContext(script, { document: { querySelector: () => iframe }, window: { addEventListener: (_type, fn) => { listener = fn; } }, parent, location: { origin: f.origin } });
  assert.equal(iframe.src, '/embed/poc/');
  listener({ source: {}, origin: f.origin, data: { type: 'augmentor-ready' } });
  listener({ source: frameWindow, origin: 'http://evil.test', data: { type: 'augmentor-ready' } });
  assert.equal(sentToParent.length, 0);
  listener({ source: frameWindow, origin: f.origin, data: { type: 'augmentor-ready' } });
  assert.deepEqual(sentToParent, [[{ type: 'augmentor-ready' }, `chrome-extension://${extensionId}`]]);
  for (const type of ['augmentor-prompt', 'augmentor-new-chat', 'augmentor-focus', 'augmentor-context']) {
    listener({ source: parent, origin: `chrome-extension://${extensionId}`, data: { type } });
  }
  assert.equal(sentToFrame.length, 4);
  assert.ok(sentToFrame.every(([, origin]) => origin === f.origin));
  for (const event of [
    { source: {}, origin: `chrome-extension://${extensionId}`, data: { type: 'augmentor-focus' } },
    { source: parent, origin: 'http://evil.test', data: { type: 'augmentor-focus' } },
    { source: parent, origin: `chrome-extension://${extensionId}`, data: { type: 'execute' } },
    { source: parent, origin: `chrome-extension://${extensionId}`, data: null },
  ]) listener(event);
  assert.equal(sentToFrame.length, 4);
});


function rawRequest(origin, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(origin, { path, method, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

test('unsafe raw proxy paths are rejected for HTTP and upgrades before upstream contact', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  const headers = { cookie, origin: f.origin, 'sec-fetch-site': 'same-origin' };
  for (const path of [
    '/embed/poc/../private', '/embed/poc/./native', '/embed/poc/.', '/embed/poc/..',
    '/embed/poc/a/../../private', '/embed/poc/\\private',
    '/embed/poc/%2e%2e/private', '/embed/poc/%2E/native', '/embed/poc/a%2fb',
    '/embed/poc/a%2Fb', '/embed/poc/a%5cb', '/embed/poc/a%5Cb',
    '/embed/poc/%ZZ', '/embed/poc%2fnative',
    '/embed/poc\\..\\private', '/embed/other/', '/embed/poc',
  ]) {
    assert.equal((await rawRequest(f.origin, path, headers)).statusCode, 403, path);
    const result = await upgrade(f.origin, headers, path);
    result.socket?.destroy();
    assert.equal(result.res.statusCode, 403, path);
    assert.equal(f.seen.length, 0, path);
  }
});

test('HTTP handler rejects paths outside its decoded profile namespace', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  for (const url of ['/private', '/embed/other/', '/embed/poc', '//evil.test/embed/poc/']) {
    let status;
    await f.service.handleHttp({ url, method: 'GET', headers: { host: new URL(f.origin).host, cookie, 'sec-fetch-site': 'same-origin' }, resume() {}, destroy() {} }, {
      writeHead(value) { status = value; }, end() {}, once() {},
    });
    assert.equal(status, 403, url);
    assert.equal(f.seen.length, 0);
  }
});


test('HTTP fetch metadata is an exact same-origin allowlist', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  for (const value of [undefined, 'none', 'same-site', 'cross-site', 'Same-Origin', '']) {
    const headers = { cookie, origin: f.origin };
    if (value !== undefined) headers['sec-fetch-site'] = value;
    assert.equal((await rawRequest(f.origin, '/embed/poc/', headers)).statusCode, 403, String(value));
  }
  assert.equal(f.seen.length, 0);
  assert.equal((await rawRequest(f.origin, '/embed/poc/', { cookie, 'sec-fetch-site': 'same-origin' })).statusCode, 200);
});

test('WebSocket fetch metadata may be absent but otherwise must be same-origin', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  for (const value of ['none', 'same-site', 'cross-site', 'Same-Origin', '']) {
    const result = await upgrade(f.origin, { cookie, origin: f.origin, 'sec-fetch-site': value });
    result.socket?.destroy();
    assert.equal(result.res.statusCode, 403, value);
  }
  assert.equal(f.seen.length, 0);
  for (const metadata of [{}, { 'sec-fetch-site': 'same-origin' }]) {
    const result = await upgrade(f.origin, { cookie, origin: f.origin, ...metadata });
    result.socket?.destroy();
    assert.equal(result.res.statusCode, 101);
  }
});

test('sessions expire at 12 hours and checks prune expired sessions', async t => {
  const f = await fixture(t);
  const first = await f.session();
  const second = await f.session();
  const request = cookie => rawRequest(f.origin, '/embed/poc/', { cookie, 'sec-fetch-site': 'same-origin' });
  f.advance(12 * 60 * 60 * 1000 - 1);
  assert.equal((await request(first.cookie)).statusCode, 200);
  f.advance(1);
  assert.equal((await request(first.cookie)).statusCode, 403);
  f.advance(-1); // An expired entry must not revive if the clock moves backwards.
  assert.equal((await request(second.cookie)).statusCode, 403);
  const result = await upgrade(f.origin, { cookie: first.cookie, origin: f.origin });
  result.socket?.destroy();
  assert.equal(result.res.statusCode, 403);
  assert.equal(f.seen.length, 1);
});

test('creating a session prunes expired entries and retains at most 64 live sessions', async t => {
  const f = await fixture(t);
  const expired = await f.session();
  f.advance(12 * 60 * 60 * 1000);
  const first = await f.session();
  f.advance(-1);
  assert.equal((await rawRequest(f.origin, '/embed/poc/', { cookie: expired.cookie, 'sec-fetch-site': 'same-origin' })).statusCode, 403);
  const cookies = [first.cookie];
  for (let i = 1; i < 64; i++) cookies.push((await f.session()).cookie);
  assert.equal((await rawRequest(f.origin, '/embed/poc/', { cookie: cookies[0], 'sec-fetch-site': 'same-origin' })).statusCode, 200);
  cookies.push((await f.session()).cookie);
  assert.equal((await rawRequest(f.origin, '/embed/poc/', { cookie: cookies.shift(), 'sec-fetch-site': 'same-origin' })).statusCode, 403);
  for (const cookie of cookies) {
    assert.equal((await rawRequest(f.origin, '/embed/poc/', { cookie, 'sec-fetch-site': 'same-origin' })).statusCode, 200);
  }
});


test('proxy supplies frame-ancestors when upstream has no CSP', async t => {
  const f = await fixture(t, { csp: null });
  const { cookie } = await f.session();
  const res = await rawRequest(f.origin, '/embed/poc/', { cookie, 'sec-fetch-site': 'same-origin' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-security-policy'], `frame-ancestors ${f.origin} chrome-extension://${extensionId}`);
});

test('HTTP and upgrade requests before public origin initialization are refused safely with debug enabled', async t => {
  const f = await fixture(t);
  const service = createEmbedHostService({ env: { ...f.env, RESONANTOS_EMBED_DEBUG: '1' } });
  t.after(() => service.close());
  const logs = [];
  t.mock.method(process.stderr, 'write', line => { logs.push(line); return true; });
  for (const url of ['/embed-host/?ticket=unused', '/embed/poc/']) {
    let status;
    const req = { url, method: 'GET', headers: { host: '127.0.0.1', 'sec-fetch-site': 'same-origin', upgrade: 'websocket' }, resume() {}, destroy() {} };
    await service.handleHttp(req, { writeHead(value) { status = value; }, end() {}, once() {} });
    assert.equal(status, 403);
    let handshake;
    service.handleUpgrade(req, { end(value) { handshake = value; } }, Buffer.alloc(0));
    assert.match(handshake, /^HTTP\/1.1 403 Forbidden/);
  }
  assert.equal(logs.length, 2);
  assert.ok(logs.every(line => line.startsWith('[embed-debug] upgrade ') && !line.includes(token)));
  assert.equal(f.seen.length, 0);
});


async function exchangeUntilClosed(origin, payload) {
  const url = new URL(origin);
  const socket = net.connect(Number(url.port), url.hostname);
  let reply = '';
  const timer = setTimeout(() => socket.destroy(new Error('refused connection stayed open')), 2000);
  try {
    socket.on('data', chunk => { reply += chunk.toString(); });
    const closed = once(socket, 'close');
    // Keep the write side open to test server-initiated closure.
    socket.write(payload);
    await closed;
    return reply;
  } finally { clearTimeout(timer); socket.destroy(); }
}

test('refused and oversized requests close keep-alive connections with unread bodies', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  const host = new URL(f.origin).host;
  const valid = `Cookie: ${cookie}\r\nSec-Fetch-Site: same-origin\r\n`;
  const cases = [
    { path: '/embed/poc/', headers: '', body: 'Content-Length: 100\r\n\r\nx', status: 403 },
    { path: '/embed-host/?ticket=bad', headers: valid, body: 'Content-Length: 100\r\n\r\nx', status: 403 },
    { path: '/embed/poc/../private', headers: valid, body: 'Content-Length: 100\r\n\r\nx', status: 403 },
    { path: '/embed/poc/', method: 'PUT', headers: valid, body: 'Content-Length: 100\r\n\r\nx', status: 405 },
    { path: '/embed/poc/', headers: valid, body: `Content-Length: ${1024 * 1024 + 1}\r\n\r\nx`, status: 413 },
    { path: '/embed/poc/', headers: valid, body: `Transfer-Encoding: chunked\r\n\r\n100001\r\n${'x'.repeat(1024 * 1024 + 1)}\r\n`, status: 413 },
  ];
  for (const entry of cases) {
    const reply = await exchangeUntilClosed(f.origin,
      `${entry.method ?? 'POST'} ${entry.path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n${entry.headers}${entry.body}`);
    assert.match(reply, new RegExp(`^HTTP/1.1 ${entry.status} `));
    assert.match(reply, /\r\nconnection: close\r\n/i);
  }
  assert.equal(f.seen.length, 0);
});

test('refusal prevents a pipelined request from reaching upstream', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  const host = new URL(f.origin).host;
  const reply = await exchangeUntilClosed(f.origin,
    `POST /embed/poc/ HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\nContent-Length: 4\r\n\r\nbody` +
    `GET /embed/poc/ HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\nSec-Fetch-Site: same-origin\r\nConnection: close\r\n\r\n`);
  assert.match(reply, /^HTTP\/1.1 403 /);
  assert.match(reply, /\r\nconnection: close\r\n/i);
  assert.equal((reply.match(/HTTP\/1.1/g) ?? []).length, 1);
  assert.equal(f.seen.length, 0);
});


test('token file must be regular, private, and owned by the current uid; failures disable with one value-free line', async t => {
  const f = await fixture(t);
  const tokenFile = f.env.RESONANTOS_EMBED_TOKEN_FILE;
  const link = `${tokenFile}-symlink`;
  await symlink(tokenFile, link);
  const logs = [];
  t.mock.method(process.stderr, 'write', line => { logs.push(line); return true; });
  const checkDisabled = file => {
    const start = logs.length;
    let service;
    assert.doesNotThrow(() => { service = createEmbedHostService({ env: { ...f.env, RESONANTOS_EMBED_TOKEN_FILE: file } }); });
    t.after(() => service?.close());
    assert.equal(service.enabled, false);
    assert.deepEqual(service.embedRoutes.map(({ method, path, requiredCapability }) =>
  ({ method, path, requiredCapability })), [
  { method: 'GET', path: '/embed/status', requiredCapability: 'addon-runtime-control' }
]);
    assert.equal(service.matches('/embed/poc/'), false);
    assert.equal(logs.length, start + 1);
    assert.match(logs[start], /^[^\r\n]+\n$/);
    assert.ok(!logs[start].includes(file));
    assert.ok(!logs[start].includes(token));
  };
  for (const mode of [0o640, 0o604, 0o620, 0o602, 0o610, 0o601]) {
    await chmod(tokenFile, mode);
    checkDisabled(tokenFile);
  }
  await chmod(tokenFile, 0o600);
  checkDisabled(link);
  checkDisabled(path.dirname(tokenFile));
  checkDisabled(`${tokenFile}-missing`);
  const uid = process.getuid();
  const uidMock = t.mock.method(process, 'getuid', () => uid + 1);
  checkDisabled(tokenFile);
  uidMock.mock.restore();
  for (const mode of [0o600, 0o400, 0o700]) {
    await chmod(tokenFile, mode);
    const service = createEmbedHostService({ env: f.env });
    assert.equal(service.enabled, true);
    service.close();
  }
  assert.equal(logs.length, 10);
});

test('embed status is gated, credential-free and never proxied', async t => {
  const f = await fixture(t);
  assert.equal(f.service.matches('/embed/status'), false);
  assert.equal(f.service.matches('/embed/status?probe=1'), false);
  assert.equal((await f.request('/embed/status')).response.status, 401);
  assert.equal((await f.request('/embed/status', {
    headers: { 'X-ResonantOS-Bridge-Token': 'bridge-test' }
  })).response.status, 403);
  const result = await f.request('/embed/status', { headers: auth });
  assert.equal(result.response.status, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true, available: true, profile: 'poc' });
  assert.equal(result.response.headers.get('set-cookie'), null);
  assert.equal(f.seen.length, 0);
  f.service.close();
  const route = f.service.embedRoutes.find(route => route.path === '/embed/status');
  assert.deepEqual(await route.handler(), { available: false, profile: null });
});

test('disabled embed status is a gated route with no session capability', async t => {
  const service = createEmbedHostService({ env: {} });
  const server = await startBridgeServer({
    host: '127.0.0.1', port: 0, bridgeToken: 'bridge-test',
    bridgeCapabilityTokens: { 'addon-runtime-control': 'cap-test' },
    routes: service.embedRoutes, embedService: service
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/embed/status`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, {
    headers: { 'X-ResonantOS-Bridge-Token': 'bridge-test' }
  })).status, 403);
  assert.deepEqual(await (await fetch(url, { headers: auth })).json(),
    { ok: true, available: false, profile: null });
  assert.equal(service.embedRoutes.some(route => route.path === '/embed/session'), false);
});
