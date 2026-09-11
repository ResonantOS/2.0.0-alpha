import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'parse5';
import {
  devBridgeConfigPlugin, parseGeneratedBridgeConfig, readGeneratedBridgeConfig,
  createPageNonces, createCspNonce, renderBridgeModule, renderAuthenticatedPage,
} from './vite-dev-bridge-config.mjs';

const PREFIX = '/__resonantos_dev_bridge__/';
const ROUTE = `${PREFIX}config.mjs`;
const RELATIVE = 'browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js';
const PORT = 49152; // unit seam only: no listener is created by this file.
const HOST = `127.0.0.1:${PORT}`;
const META = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' };
const DENY = ['**/bridge-config.generated.js', '**/ResonantOS_User/**', '.env', '.env.*', '*.{crt,pem}', '**/.git/**'];
const CHALLENGE = 'Basic realm="ResonantOS development", charset="UTF-8"';
const token = () => `synthetic-${randomBytes(24).toString('hex')}`;
const nonce = () => randomBytes(32).toString('base64url');
const config = () => ({ bridgeUrl: 'http://127.0.0.1:49153', bridgeToken: token(), capabilityBootstrapToken: token() });
const writer = value => `globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze(${JSON.stringify(value)});`;
const HTML = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; connect-src \'self\' http://127.0.0.1:*; style-src \'self\' \'unsafe-inline\'"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';
const policy = root => ({ root, additionalAllowedHosts: [], server: {
  host: '127.0.0.1', port: PORT, strictPort: true, allowedHosts: ['127.0.0.1'],
  fs: { strict: true, deny: DENY }, cors: false, watch: { ignored: DENY.slice(0, 2) },
} });
const invokeHook = (hook, ...args) => (typeof hook === 'function' ? hook : hook.handler)(...args);
const safe = (body, values) => assert.equal(values.some(value => value && body.includes(value)), false, 'sensitive material absent');
const routeFrom = body => {
  const route = body.match(/src="(\/__resonantos_dev_bridge__\/config\.mjs\?nonce=[A-Za-z0-9_-]{43})"/)?.[1];
  assert.equal(typeof route, 'string', 'one gated module URL');
  return route;
};
function nodes(html) {
  const result = [];
  const visit = node => { result.push(node); for (const child of node.childNodes ?? []) visit(child); };
  visit(parse(html)); return result;
}
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'resonantos-dev-unit-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, RELATIVE, '..'), { recursive: true });
  await writeFile(join(root, 'index.html'), HTML, { mode: 0o600 });
  return root;
}
async function harness(t, options = {}) {
  const root = options.root ?? await tempRoot(t);
  const key = options.key ?? nonce();
  let reads = 0, issues = 0, cspIssues = 0;
  const transforms = [], logs = [], errors = [];
  const httpServer = new EventEmitter();
  const middlewares = [];
  const server = {
    config: policy(root), httpServer,
    middlewares: { use: (...args) => middlewares.push(args.at(-1)) },
    transformIndexHtml: async (...args) => { transforms.push(args); return options.transform ? options.transform(...args) : args[1]; },
    watcher: new EventEmitter(), ws: { send: value => logs.push(value) },
  };
  server.config.logger = Object.fromEntries(['info', 'warn', 'error', 'warnOnce'].map(name => [name, (...args) => logs.push(args)]));
  const plugin = devBridgeConfigPlugin({ expectedPort: PORT,
    env: () => options.env ?? { RESONANTOS_DEV_BRIDGE_CONFIG: '1', RESONANTOS_DEV_BRIDGE_PAGE_KEY: key },
    readConfig: async (...args) => { reads++; return options.readConfig ? options.readConfig(...args) : options.value ?? config(); },
    random: () => { issues++; return options.random ? options.random() : nonce(); },
    createCspNonce: () => { cspIssues++; return options.createCspNonce ? options.createCspNonce() : nonce(); },
    ...(options.now ? { now: options.now } : {}),
  });
  const post = await invokeHook(plugin.configureServer, server);
  if (post) await post();
  t.after(() => httpServer.emit('close'));
  const authorization = `Basic ${Buffer.from(`dev:${key}`).toString('base64')}`;
  async function request(url, { headers = {}, method = 'GET', rawHeaders } = {}) {
    const req = new EventEmitter();
    Object.assign(req, { url, originalUrl: url, method, headers: { host: HOST, ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    req.rawHeaders = rawHeaders ?? Object.entries(req.headers).flatMap(([name, value]) => [name, String(value)]);
    const res = new EventEmitter();
    const responseHeaders = new Map();
    res.statusCode = 200; res.headersSent = false; res.writableEnded = false;
    res.setHeader = (name, value) => responseHeaders.set(name.toLowerCase(), String(value));
    res.getHeader = name => responseHeaders.get(name.toLowerCase());
    res.removeHeader = name => responseHeaders.delete(name.toLowerCase());
    res.writeHead = (status, values) => { res.statusCode = status; for (const [name, value] of Object.entries(values ?? {})) res.setHeader(name, value); return res; };
    let resolveResult;
    const result = new Promise(resolve => { resolveResult = resolve; });
    res.end = (body = '') => { res.writableEnded = true; res.headersSent = true; resolveResult({ status: res.statusCode, body: String(body), headers: responseHeaders, next: false }); res.emit('finish'); };
    let index = 0;
    const next = error => {
      if (error) errors.push(error);
      const middleware = middlewares[index++];
      if (middleware && !error) Promise.resolve(middleware(req, res, next)).catch(error => { errors.push(error); resolveResult({ status: 599, body: '', headers: responseHeaders, next: true }); });
      else resolveResult({ status: 0, body: '', headers: responseHeaders, next: true });
    };
    next();
    let timer;
    try { return await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('unit middleware timeout')), 3000); })]); }
    finally { clearTimeout(timer); }
  }
  const page = () => request('/', { headers: { authorization } });
  const module = route => request(route, { headers: { authorization, ...META } });
  return { root, key, authorization, request, page, module, plugin, server, transforms, logs, errors,
    reads: () => reads, issues: () => issues, cspIssues: () => cspIssues };
}
function headersSafe(response, page = false) {
  const expected = { 'cache-control': 'private, no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    vary: 'Host, Authorization, Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest' };
  for (const [name, value] of Object.entries(expected)) assert.equal(response.headers.get(name), value, name);
  for (const name of ['access-control-allow-origin', 'access-control-allow-credentials', 'etag', 'last-modified', 'location']) assert.equal(response.headers.has(name), false, name);
  if (page) { assert.equal(response.headers.get('x-frame-options'), 'DENY'); assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/); }
  assert.notEqual(response.status, 304);
}

test('opt-out never reads or injects', async t => {
  for (const value of [undefined, '', '0', 'false', 'true']) {
    const h = await harness(t, { env: value === undefined ? {} : { RESONANTOS_DEV_BRIDGE_CONFIG: value } });
    assert.equal((await h.page()).next, true);
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) for (const suffix of ['', '?nonce=x', '?raw', '/other']) {
      const response = await h.request(ROUTE + suffix, { method, headers: { host: 'attacker.test', origin: 'null' } });
      assert.equal(response.status, 404); assert.equal(response.body, 'Not found.\n');
      assert.equal(response.headers.has('www-authenticate'), false); assert.equal(response.next, false);
    }
    assert.equal(h.reads(), 0); assert.equal(h.issues(), 0); assert.equal(h.cspIssues(), 0); assert.equal(h.transforms.length, 0);
  }
});
test('opt-in requires a private page key', async t => {
  const messages = [];
  for (const key of [undefined, '', 'short', `${nonce()}!`, ' '.repeat(43), nonce().slice(1)]) {
    let error;
    try { await harness(t, { env: { RESONANTOS_DEV_BRIDGE_CONFIG: '1', ...(key === undefined ? {} : { RESONANTOS_DEV_BRIDGE_PAGE_KEY: key }) } }); } catch (caught) { error = caught; }
    assert.equal(error instanceof Error, true, 'startup must fail');
    messages.push(error.message); if (key) safe(error.message, [key]);
  }
  assert.equal(new Set(messages).size, 1, 'fixed startup error');
});
test('parser accepts writer contract and projects three fields', () => {
  for (const bridgeUrl of ['http://127.0.0.1:49153', 'https://127.0.0.1:49153', 'http://127.0.0.1:80']) {
    const value = { ...config(), bridgeUrl, httpsBridgeUrl: 'https://attacker.test', extra: token() };
    const parsed = parseGeneratedBridgeConfig(` \n${writer(value)}\n`);
    assert.equal(parsed !== null, true); assert.deepEqual(Object.keys(parsed).sort(), ['bridgeToken', 'bridgeUrl', 'capabilityBootstrapToken']);
    assert.equal(parsed.bridgeUrl === new URL(bridgeUrl).origin, true, 'normalized origin');
    assert.equal(parsed.bridgeToken === value.bridgeToken && parsed.capabilityBootstrapToken === value.capabilityBootstrapToken, true, 'projected tokens');
  }
});
test('parser never evaluates script', () => {
  const value = config(), source = writer(value);
  globalThis.__devBridgeExecutionSentinel = false;
  try {
    for (const invalid of [source + 'globalThis.__devBridgeExecutionSentinel=true;', `globalThis.__devBridgeExecutionSentinel=true;${source}`,
      source.replace('Object.freeze(', 'Object.seal('), source.slice(0, -1), source.replace(JSON.stringify(value), '(globalThis.__devBridgeExecutionSentinel=true,{})'),
      source.replace(JSON.stringify(value), '{broken}')]) assert.equal(parseGeneratedBridgeConfig(invalid) === null, true);
    assert.equal(globalThis.__devBridgeExecutionSentinel, false);
  } finally { delete globalThis.__devBridgeExecutionSentinel; }
});
test('parser rejects unsafe shapes and destinations', async t => {
  const value = config();
  for (const invalid of [null, [], 1, 'text', true, ...['bridgeUrl', 'bridgeToken', 'capabilityBootstrapToken'].map(key => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)))]) {
    assert.equal(parseGeneratedBridgeConfig(writer(invalid)) === null, true);
  }
  for (const field of ['bridgeToken', 'capabilityBootstrapToken']) for (const invalid of ['', 'x'.repeat(513), 'a b', 'a\nb', 'a\0b', 'a\x7fb', 'é', 1]) {
    assert.equal(parseGeneratedBridgeConfig(writer({ ...value, [field]: invalid })) === null, true);
  }
  for (const bridgeUrl of ['ftp://127.0.0.1', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?x=1', 'http://127.0.0.1/#x']) {
    assert.equal(parseGeneratedBridgeConfig(writer({ ...value, bridgeUrl })) === null, true);
  }
  for (const bridgeUrl of ['http://localhost:49153', 'http://[::1]:49153', 'https://attacker.test']) {
    let calls = 0;
    assert.equal(parseGeneratedBridgeConfig(writer({ ...value, bridgeUrl }), () => calls++) === null, true);
    assert.equal(calls, 1);
  }
  const root = await tempRoot(t), remote = { ...value, bridgeUrl: 'https://attacker.test' };
  await writeFile(join(root, RELATIVE), writer(remote), { mode: 0o600 });
  let readerCalls = 0;
  assert.equal((await readGeneratedBridgeConfig(root, { onNonLoopback: () => readerCalls++ })) === null, true); assert.equal(readerCalls, 1);
  const captured = []; const originals = {};
  for (const name of ['warn', 'error', 'log', 'info']) { originals[name] = console[name]; console[name] = (...args) => captured.push(args.join(' ')); }
  try {
    const h = await harness(t, { root, readConfig: (path, onNonLoopback) => readGeneratedBridgeConfig(path, { onNonLoopback }) });
    for (let i = 0; i < 2; i++) { const response = await h.module(routeFrom((await h.page()).body)); assert.equal(response.status, 200); assert.match(response.body, /^delete globalThis/); safe(response.body, Object.values(remote)); }
    assert.equal(JSON.stringify(captured) === JSON.stringify(['Development bridge config unavailable: loopback URL required.']), true, 'exact value-free diagnostic once');
  } finally { for (const name of Object.keys(originals)) console[name] = originals[name]; }
});
test('authorized requests read fresh config', async t => {
  let value = config(); const first = value;
  const h = await harness(t, { readConfig: async () => value }); assert.equal(h.reads(), 0);
  const page1 = await h.page(); assert.equal(h.reads(), 0);
  const response1 = await h.module(routeFrom(page1.body)); assert.equal(response1.status, 200); assert.equal(response1.body.includes(first.bridgeToken), true);
  value = config(); const page2 = await h.page(); assert.equal(h.reads(), 1);
  const response2 = await h.module(routeFrom(page2.body)); assert.equal(response2.status, 200); assert.equal(response2.body.includes(value.bridgeToken), true);
  safe(response2.body, [first.bridgeToken, first.capabilityBootstrapToken]); assert.equal(h.reads(), 2);
});
test('unavailable config starts main without credentials', async t => {
  const root = await tempRoot(t), path = join(root, RELATIVE);
  const h = await harness(t, { root, readConfig: path => readGeneratedBridgeConfig(path) });
  for (const source of [null, '{malformed}', 'globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze(', writer(config())]) {
    if (source === null) await rm(path, { force: true }); else { await writeFile(path, source, { mode: 0o600 }); if (source.startsWith('globalThis') && source.endsWith(');')) await chmod(path, 0o644); }
    const route = routeFrom((await h.page()).body), response = await h.module(route);
    assert.equal(response.status, 200); assert.equal(response.body, renderBridgeModule(null));
    assert.match(response.body, /^delete globalThis\.__RESONANTOS_BRIDGE_CONFIG__;/);
    assert.equal((await h.module(route)).status, 403);
  }
});
test('reader rejects unsafe files and bounds reads', async t => {
  const root = await tempRoot(t), path = join(root, RELATIVE), source = writer(config());
  await writeFile(path, source, { mode: 0o600 });
  let opened = 0, closed = 0, dataReads = 0;
  const trackedOpen = async (file, flags) => {
    assert.equal(file === path, true, 'fixed input path');
    assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR), 0, 'read-only descriptor');
    for (const flag of [constants.O_NOFOLLOW, constants.O_NONBLOCK]) assert.equal((flags & flag) === flag, true, 'safe open flags');
    const handle = await open(file, flags); opened++;
    return new Proxy(handle, { get(target, prop) {
      if (prop === 'close') return async () => { closed++; await target.close(); };
      if (prop === 'readFile') return async (...args) => { dataReads++; return target.readFile(...args); };
      if (prop === 'read') return async (...args) => { dataReads++; const length = typeof args[2] === 'number' ? args[2] : args[0]?.length ?? args[0]?.buffer?.length; assert.equal(length <= 16 * 1024 + 1, true, 'bounded read'); return target.read(...args); };
      const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  assert.equal((await readGeneratedBridgeConfig(root, { openFile: trackedOpen })) !== null, true);
  const validReads = dataReads;
  assert.equal((await readGeneratedBridgeConfig(root, { openFile: trackedOpen, uid: () => process.getuid() + 1 })) === null, true);
  assert.equal((await readGeneratedBridgeConfig(root, { openFile: trackedOpen, uid: () => { throw Error('UID unavailable'); } })) === null, true);
  for (const mode of [0o640, 0o604, 0o644]) { await chmod(path, mode); assert.equal((await readGeneratedBridgeConfig(root, { openFile: trackedOpen })) === null, true); }
  await chmod(path, 0o600); await writeFile(path, 'x'.repeat(16 * 1024 + 1));
  assert.equal((await readGeneratedBridgeConfig(root, { openFile: trackedOpen })) === null, true);
  await rm(path); await mkdir(path); assert.equal((await readGeneratedBridgeConfig(root, { openFile: trackedOpen })) === null, true);
  await rm(path, { recursive: true }); const target = join(root, 'synthetic-source'); await writeFile(target, source, { mode: 0o600 }); await symlink(target, path);
  assert.equal((await readGeneratedBridgeConfig(root, { openFile: trackedOpen })) === null, true);
  assert.equal(opened, closed, 'all opened descriptors closed');
  assert.equal(dataReads, validReads, 'unsafe metadata rejected before reading bytes');
  await rm(path); await writeFile(path, source, { mode: 0o600 });
  let failureClosed = false;
  const failingOpen = async (...args) => { const handle = await open(...args); return { stat: async () => { throw Error(token()); }, close: async () => { failureClosed = true; await handle.close(); } }; };
  assert.equal((await readGeneratedBridgeConfig(root, { openFile: failingOpen })) === null, true); assert.equal(failureClosed, true);
  let readFailureClosed = false;
  const readFailureOpen = async (...args) => {
    const handle = await open(...args);
    return new Proxy(handle, { get(target, prop) {
      if (prop === 'read' || prop === 'readFile') return async () => { throw Error(token()); };
      if (prop === 'close') return async () => { readFailureClosed = true; await target.close(); };
      const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  assert.equal((await readGeneratedBridgeConfig(root, { openFile: readFailureOpen })) === null, true);
  assert.equal(readFailureClosed, true);
});
test('page challenge precedes nonce issuance', async t => {
  const h = await harness(t);
  for (const authorization of [undefined, `Basic ${Buffer.from(`dev:${nonce()}`).toString('base64')}`]) {
    const response = await h.request('/', { headers: authorization ? { authorization } : {} });
    assert.equal(response.status, 401); assert.equal(response.body, 'Authentication required.\n'); assert.equal(response.headers.get('www-authenticate'), CHALLENGE);
    assert.equal(h.issues(), 0); assert.equal(h.reads(), 0); safe(response.body, [h.key, h.authorization]);
  }
  assert.equal((await h.page()).status, 200); assert.equal(h.issues(), 1); assert.equal(h.reads(), 0);
  for (const method of ['HEAD', 'POST']) { assert.equal((await h.request('/', { method, headers: { authorization: h.authorization } })).status, 405); assert.equal(h.issues(), 1); }
});
test('module needs independent auth and page nonce', async t => {
  const h = await harness(t), route = routeFrom((await h.page()).body);
  const absent = await h.request(route, { headers: META }); assert.equal(absent.status, 401); assert.equal(absent.body, 'Authentication required.\n'); assert.equal(absent.headers.get('www-authenticate'), CHALLENGE); assert.equal(h.reads(), 0);
  const wrong = await h.request(route, { headers: { ...META, authorization: `Basic ${Buffer.from(`dev:${nonce()}`).toString('base64')}` } });
  assert.equal(wrong.status, 403); assert.equal(wrong.body, 'Forbidden.\n'); assert.equal(wrong.headers.has('www-authenticate'), false); assert.equal(h.reads(), 0);
  assert.equal((await h.module(route)).status, 200); assert.equal(h.reads(), 1); assert.equal((await h.module(route)).status, 403); assert.equal(h.reads(), 1);
  assert.equal((await h.module(ROUTE)).status, 403);
  assert.equal((await h.request(ROUTE, { headers: META })).status, 401);
  assert.equal(h.reads(), 1);
});
test('nonces expire and are single-use per server', async t => {
  let now = 0; const store = createPageNonces(() => now), other = createPageNonces(() => now);
  const first = store.issue(); assert.match(first, /^[A-Za-z0-9_-]{43}$/); assert.equal(other.consume(first), false);
  now = 59999; assert.equal(store.consume(first), true); assert.equal(store.consume(first), false);
  const expired = store.issue(); now += 60000; assert.equal(store.consume(expired), false);
  const race = store.issue(); const outcomes = await Promise.all(Array.from({ length: 12 }, () => Promise.resolve().then(() => store.consume(race))));
  assert.equal(outcomes.filter(Boolean).length, 1);
  let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { readConfig: async () => { entered(); await pending; return config(); } });
  const route = routeFrom((await h.page()).body);
  const winner = h.module(route); await reading;
  try { const loser = await h.module(route); assert.equal(loser.status, 403); assert.equal(h.reads(), 1); }
  finally { release(); }
  assert.equal((await winner).status, 200);
});
test('reserved endpoint rejects method and URL aliases', async t => {
  const h = await harness(t), route = routeFrom((await h.page()).body);
  const aliases = [route + '&nonce=x', route + '&extra=x', ROUTE + '?raw', ROUTE + '?url', ROUTE + '.map',
    ROUTE + '?nonce=%ZZ', '/__resonantos_dev_bridge__/%63onfig.mjs', '/__resonantos_dev_bridge__/./config.mjs',
    '/__resonantos_dev_bridge__/x/../config.mjs', '/__resonantos_dev_bridge__//config.mjs',
    '/__resonantos_dev_bridge__\\config.mjs', '/%5f%5fresonantos_dev_bridge__/config.mjs', `http://${HOST}${route}`];
  for (const url of aliases) { const response = await h.module(url); assert.equal(response.status, 403, 'URL alias denied'); assert.equal(response.next, false); }
  for (const method of ['HEAD', 'POST', 'OPTIONS']) assert.equal((await h.request(route, { method, headers: { ...META, authorization: h.authorization } })).status, 403);
  assert.equal(h.reads(), 0); assert.equal((await h.module(route)).status, 200);
});
test('host origin and fetch metadata cannot bypass auth', async t => {
  const h = await harness(t), route = routeFrom((await h.page()).body);
  const variants = [{ host: 'attacker.test' }, { host: `127.0.0.2:${PORT}` }, { host: 'attacker.test', 'x-forwarded-host': HOST, forwarded: `host=${HOST}` },
    { origin: 'null' }, { origin: 'http://attacker.test' }, { 'sec-fetch-site': undefined }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-mode': undefined }, { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-dest': undefined }, { 'sec-fetch-dest': 'worker' }, { 'sec-fetch-dest': 'serviceworker' }];
  for (const patch of variants) assert.equal((await h.request(route, { headers: { ...META, authorization: h.authorization, ...patch } })).status, 403);
  assert.equal((await h.request(route, { headers: { ...META, authorization: h.authorization }, rawHeaders: ['Host', HOST, 'Host', HOST, 'Authorization', h.authorization, ...Object.entries(META).flat()] })).status, 403);
  for (const patch of [{ host: 'attacker.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-dest': 'iframe' }]) assert.equal((await h.request('/', { headers: { authorization: h.authorization, ...patch } })).status, 403);
  assert.equal(h.reads(), 0); assert.equal((await h.request(route, { headers: { ...META, authorization: h.authorization, origin: `http://${HOST}`, 'x-forwarded-host': 'attacker.test', forwarded: 'host=attacker.test' } })).status, 200);
});
test('page responses have independent late-inserted gates', async t => {
  const moduleNonces = [nonce(), nonce()], cspNonces = [nonce(), nonce()], value = config(); let m = 0, c = 0;
  const h = await harness(t, { value, random: () => moduleNonces[m++], createCspNonce: () => cspNonces[c++] });
  const pages = await Promise.all([h.page(), h.page()]);
  assert.equal(new Set(pages.map(page => routeFrom(page.body))).size, 2);
  for (let i = 0; i < pages.length; i++) {
    assert.equal(pages[i].body.includes(moduleNonces[i]), true); assert.equal(pages[i].body.includes(`nonce="${cspNonces[i]}"`), true);
    safe(pages[i].body, [...Object.values(value), h.key, h.authorization]);
  }
  for (const args of h.transforms) { assert.equal(args[0], '/index.html'); assert.equal(args[2], '/'); safe(JSON.stringify(args), [...moduleNonces, ...cspNonces, ...Object.values(value), h.key, PREFIX]); }
  assert.equal(h.transforms.length, 2); assert.equal(h.issues(), 2); assert.equal(h.cspIssues(), 2); assert.equal(h.reads(), 0);
});
test('delivery responses forbid caching embedding and cross-origin reads', async t => {
  const h = await harness(t), page = await h.page(), route = routeFrom(page.body);
  headersSafe(page, true); assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  const module = await h.module(route); headersSafe(module); assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8');
  for (const response of [await h.request('/'), await h.module(route), await h.request('/', { method: 'POST' }),
    await h.request(route, { headers: { ...META, authorization: h.authorization, 'if-none-match': '*', 'if-modified-since': new Date().toUTCString() } })]) headersSafe(response);
  const off = await harness(t, { env: {} }); headersSafe(await off.request(ROUTE));
  const broken = await harness(t, { transform: () => { throw Error(token()); } }); const failed = await broken.page(); assert.equal(failed.status, 500); headersSafe(failed, true);
  const full = await harness(t); for (let i = 0; i < 1024; i++) assert.equal((await full.page()).status, 200);
  const exhausted = await full.page(); assert.equal(exhausted.status, 503); headersSafe(exhausted, true);
});
test('CSP authorizes React preamble and the external entry', async t => {
  const csp = nonce(), moduleNonce = nonce();
  const transformed = HTML.replace('<head>', '<head><script type="module">/* synthetic React refresh preamble */</script><script type="module" src="/@vite/client"></script>');
  const h = await harness(t, { transform: () => transformed, random: () => moduleNonce, createCspNonce: () => csp });
  const response = await h.page(); assert.equal(response.status, 200);
  const all = nodes(response.body), meta = all.find(n => n.tagName === 'meta' && attr(n, 'http-equiv')?.toLowerCase() === 'content-security-policy');
  const scripts = all.filter(n => n.tagName === 'script'), content = attr(meta, 'content');
  assert.equal(all.indexOf(meta) < Math.min(...scripts.map(n => all.indexOf(n))), true, 'CSP before scripts');
  const scriptPolicy = content.split(';').find(x => x.trim().startsWith('script-src '));
  assert.equal(scriptPolicy.includes("'self'") && scriptPolicy.includes(`'nonce-${csp}'`), true);
  assert.equal(/unsafe-inline|unsafe-eval/.test(scriptPolicy), false);
  assert.equal(scripts.length, 3); assert.equal(scripts.every(n => attr(n, 'nonce') === csp), true);
  assert.equal(content.includes("style-src 'self' 'unsafe-inline'") && content.includes("connect-src 'self' http://127.0.0.1:*"), true, 'other CSP directives retained');
  assert.equal(content.includes(`nonce-${moduleNonce}`), false); assert.equal(h.cspIssues(), 1);
  const fresh = Array.from({ length: 16 }, () => createCspNonce()); assert.equal(new Set(fresh).size, 16); assert.equal(fresh.every(x => /^[A-Za-z0-9_-]{43}$/.test(x)), true);
});
test('module config executes before main', () => {
  const value = { ...config(), bridgeToken: `${token()}<script>`, capabilityBootstrapToken: `${token()}\u2028\u2029` };
  for (const input of [value, null]) {
    const body = renderBridgeModule(input);
    assert.match(body, input ? /^globalThis\.__RESONANTOS_BRIDGE_CONFIG__ = Object\.freeze\(/ : /^delete globalThis\.__RESONANTOS_BRIDGE_CONFIG__;/);
    assert.match(body.trimEnd(), /await import\('\/src\/main\.tsx'\);$/);
    assert.equal(/(^|\n)\s*import\s/.test(body), false);
    assert.equal(/[<\u2028\u2029]/.test(body), false);
    assert.equal(/sourceMappingURL|import\.meta\.hot|localStorage|sessionStorage/.test(body), false);
    if (input) { const json = body.match(/Object\.freeze\((.*)\);/)?.[1]; assert.equal(JSON.stringify(JSON.parse(json)) === JSON.stringify(value), true, 'escaped payload round trips'); }
  }
});
test('errors and logging contain no sensitive values', async t => {
  const key = nonce(), moduleNonce = nonce(), value = config(), authorization = `Basic ${Buffer.from(`dev:${key}`).toString('base64')}`;
  const material = [key, moduleNonce, authorization, ...Object.values(value)], captured = [], originals = {};
  for (const name of ['error', 'warn', 'log', 'info']) { originals[name] = console[name]; console[name] = (...args) => captured.push(args); }
  try {
    const broken = await harness(t, { key, random: () => moduleNonce, transform: () => { throw Error(material.join(' ')); } });
    const response = await broken.page(); assert.equal(response.status, 500); assert.equal(response.body, 'Development page unavailable.\n');
    assert.equal((await broken.module(`${ROUTE}?nonce=${moduleNonce}`)).status, 403);
    const reader = await harness(t, { key, readConfig: async () => { throw Error(material.join(' ')); } });
    const failed = await reader.module(routeFrom((await reader.page()).body)); safe(failed.body, material);
    assert.equal([200, 500].includes(failed.status), true);
    assert.equal(reader.errors.length + broken.errors.length, 0); assert.equal(reader.logs.length + broken.logs.length, 0); assert.equal(captured.length, 0);
  } finally { for (const name of Object.keys(originals)) console[name] = originals[name]; }
});
test('build and preview do not activate delivery', () => {
  let envCalls = 0, reads = 0; const key = nonce(), value = config();
  const plugin = devBridgeConfigPlugin({ env: () => { envCalls++; return { RESONANTOS_DEV_BRIDGE_CONFIG: '1', RESONANTOS_DEV_BRIDGE_PAGE_KEY: key }; }, readConfig: async () => { reads++; return value; } });
  assert.equal(plugin.name, 'resonantos-dev-bridge-config'); assert.equal(plugin.enforce, 'pre'); assert.equal(typeof plugin.apply, 'function');
  for (const env of [{ command: 'build', mode: 'production' }, { command: 'serve', mode: 'production', isPreview: true }]) assert.equal(plugin.apply({}, env), false);
  assert.equal(plugin.apply({}, { command: 'serve', mode: 'development', isPreview: false }), true);
  assert.equal(envCalls, 0); assert.equal(reads, 0); safe(JSON.stringify(plugin), [key, ...Object.values(value)]);
  const missing = devBridgeConfigPlugin({ env: () => ({ RESONANTOS_DEV_BRIDGE_CONFIG: '1' }) }); assert.equal(missing.apply({}, { command: 'build' }), false);
});
test('unexpected HTML structure fails closed', async t => {
  const meta = HTML.match(/<meta[^>]+>/)[0], main = '<script type="module" src="/src/main.tsx"></script>';
  for (const html of [HTML.replace(meta, ''), HTML.replace(meta, meta + meta), HTML.replace(main, ''), HTML.replace(main, main + main),
    HTML.replace("script-src 'self';", ''), HTML.replace("script-src 'self';", "script-src 'none';"),
    HTML.replace("script-src 'self';", "script-src 'self'; script-src 'self';"), HTML.replace("script-src 'self';", 'script-src;')]) {
    const h = await harness(t, { transform: () => html }); const response = await h.page();
    assert.equal(response.status, 500); assert.equal(response.body, 'Development page unavailable.\n'); assert.equal(h.reads(), 0); assert.equal(response.body.includes(PREFIX), false);
    assert.throws(() => renderAuthenticatedPage(html, nonce(), nonce()));
  }
});
test('nonce state is bounded and cleared', async t => {
  let now = 0; const store = createPageNonces(() => now), issued = [];
  for (let i = 0; i < 1024; i++) issued.push(store.issue());
  assert.equal(new Set(issued).size, 1024); assert.equal(issued.includes(null), false); assert.equal(store.issue(), null);
  now = 60000; assert.equal(typeof store.issue(), 'string'); assert.equal(store.consume(issued[0]), false);
  const latest = store.issue(); store.clear(); assert.equal(store.consume(latest), false);
  const h = await harness(t), route = routeFrom((await h.page()).body); h.server.httpServer.emit('close'); assert.equal((await h.module(route)).status, 403); assert.equal(h.reads(), 0);
});
test('Basic parser rejects ambiguous credentials', async t => {
  const h = await harness(t), route = routeFrom((await h.page()).body);
  const encoded = Buffer.from(`dev:${h.key}`).toString('base64');
  const bad = [`Basic ${encoded}\n`, `Basic ${encoded.replace(/=+$/, '')}!`, `Basic ${encoded.slice(0, 8)} ${encoded.slice(8)}`,
    `Basic ${Buffer.from(`other:${h.key}`).toString('base64')}`, `Basic ${Buffer.from(`dev:${h.key.slice(1)}`).toString('base64')}`,
    `Basic ${Buffer.from(`dev:${h.key}x`).toString('base64')}`, `Basic ${encoded}${' '.repeat(257)}`, `Bearer ${h.key}`];
  // Change ignored pad bits: permissive Buffer decoding yields the same bytes.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const pad = encoded.indexOf('='); if (pad > 0) bad.push(`Basic ${encoded.slice(0, pad - 1)}${alphabet[alphabet.indexOf(encoded[pad - 1]) + 1]}${encoded.slice(pad)}`);
  for (const authorization of bad) {
    assert.equal((await h.request('/', { headers: { authorization } })).status, 401);
    const response = await h.request(route, { headers: { ...META, authorization } }); assert.equal(response.status, 403); assert.equal(response.headers.has('www-authenticate'), false);
  }
  const rawHeaders = ['Host', HOST, 'Authorization', h.authorization, 'authorization', h.authorization, ...Object.entries(META).flat()];
  assert.equal((await h.request('/', { headers: { authorization: h.authorization }, rawHeaders })).status, 401);
  assert.equal((await h.request(route, { headers: { ...META, authorization: h.authorization }, rawHeaders })).status, 403);
  assert.equal(h.reads(), 0); assert.equal(h.issues(), 1); assert.equal((await h.module(route)).status, 200); assert.equal(h.reads(), 1);
});

test('plugin does not apply under vitest (Vite mode test) — the policy assertion must never break the unit runner', () => {
  const plugin = devBridgeConfigPlugin();
  assert.equal(plugin.apply({}, { command: 'serve', mode: 'test', isPreview: false }), false);
  assert.equal(plugin.apply({}, { command: 'serve', mode: 'development', isPreview: false }), true);
  assert.equal(plugin.apply({}, { command: 'build', mode: 'production', isPreview: false }), false);
  assert.equal(plugin.apply({}, { command: 'serve', mode: 'development', isPreview: true }), false);
});
