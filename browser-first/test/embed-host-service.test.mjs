import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmbedHostService, readEmbedHostConfig } from '../host/embed-host-service.mjs';
import { startBridgeServer, startBridgeServerWithFallback } from '../host/bridge-server.mjs';

const extensionId = 'cdpdmmalhmokbfcfgogoepnjplaakgnl';
const token = 'test-embed-private-bearer';
const auth = { 'X-ResonantOS-Bridge-Token': 'bridge-test', 'X-ResonantOS-Bridge-Capability-Token': 'cap-test' };
async function fixture(t, { fallback = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ros-embed-test-'));
  const tokenFile = path.join(root, 'token');
  await writeFile(tokenFile, `  ${token}\n`);
  const seen = [];
  const sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'Content-Security-Policy': "default-src 'self'; frame-ancestors http://old; script-src 'self'; connect-src 'self'", 'Set-Cookie': 'upstream=private', 'Content-Type': 'text/plain' });
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
  assert.deepEqual(service.embedRoutes, []);
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
  assert.equal((await f.request('/embed/poc/', { method: 'HEAD', headers: { cookie } })).body, '');
});

test('POST body over 1 MiB is rejected before upstream contact', async t => {
  const f = await fixture(t);
  const { cookie } = await f.session();
  assert.equal((await f.request('/embed/poc/preferences', { method: 'POST', headers: { cookie, origin: f.origin }, body: 'a'.repeat(1024 * 1024 + 1) })).response.status, 413);
  assert.equal(f.seen.length, 0);
});

function upgrade(origin, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}/embed/poc/native?q=%2F`, { headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } });
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
    const req = http.request(`${f.origin}/embed/poc/preferences`, { method: 'POST', headers: { cookie, origin: f.origin } }, res => { res.resume(); resolve(res.statusCode); });
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
