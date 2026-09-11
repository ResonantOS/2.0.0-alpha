import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, mkdir, chmod, writeFile, readFile, readdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer, loadConfigFromFile, preview } from 'vite';
import { devBridgeConfigPlugin, readGeneratedBridgeConfig, assertDevServerPolicy } from './vite-dev-bridge-config.mjs';

const REPO = resolve(import.meta.dirname, '..');
const PREFIX = '/__resonantos_dev_bridge__/';
const ROUTE = `${PREFIX}config.mjs`;
const RELATIVE = 'browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js';
const META = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'script' };
const CHALLENGE = 'Basic realm="ResonantOS development", charset="UTF-8"';
const canary = () => `synthetic-${randomBytes(24).toString('hex')}`;
const key = () => randomBytes(32).toString('base64url');
const fakeConfig = () => ({ bridgeUrl: 'http://127.0.0.1:49153', bridgeToken: canary(), capabilityBootstrapToken: canary() });
const writer = value => `globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze(${JSON.stringify(value)});\n`;
const noMaterial = (body, values) => assert.equal(values.some(value => value && body.includes(value)), false, 'credential material absent');
const routeFrom = body => { const route = body.match(/src="(\/__resonantos_dev_bridge__\/config\.mjs\?nonce=[A-Za-z0-9_-]{43})"/)?.[1]; assert.equal(typeof route, 'string', 'gated route present'); return route; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function reservePort() {
  const reservation = createNetServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  // No production-port probes, even if the kernel were to allocate it.
  if (port === 1430) return reservePort();
  return port;
}
function cleanEnv(root) {
  const env = { HOME: root, TMPDIR: tmpdir(), npm_config_cache: join(root, '.npm-cache'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
async function isolated(t) {
  const root = await mkdtemp(join(tmpdir(), 'resonantos-dev-integration-')); await chmod(root, 0o700);
  const resources = [];
  t.after(async () => {
    try { for (const close of resources.reverse()) await close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  for (const path of ['src', 'packages', 'public', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json',
    'scripts/vite-dev-bridge-config.mjs', 'scripts/vite-dev-bridge-config.d.mts']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    try { await cp(join(REPO, path), join(root, path), { recursive: true }); } catch (error) { if (path !== 'public' || error.code !== 'ENOENT') throw error; }
  }
  // Keep the dependency directory itself writable for Vite's temporary config
  // bundles, while linking installed packages instead of installing anything.
  await mkdir(join(root, 'node_modules'));
  const installed = await realpath(join(REPO, 'node_modules'));
  for (const entry of await readdir(installed)) if (!entry.startsWith('.vite') && entry !== '.cache') await symlink(join(installed, entry), join(root, 'node_modules', entry));
  await mkdir(dirname(join(root, RELATIVE)), { recursive: true });
  const value = fakeConfig(); await writeFile(join(root, RELATIVE), writer(value), { mode: 0o600 });
  await mkdir(join(root, 'ResonantOS_User'), { mode: 0o700 }); await writeFile(join(root, 'ResonantOS_User/probe'), 'harmless synthetic filesystem-denial probe\n', { mode: 0o600 });
  return { root, value, key: key(), resources };
}
async function sanitizedEnvironment(fn, injected = {}) {
  const names = [...new Set([...Object.keys(process.env).filter(name => /^(?:RESONANTOS_DEV_BRIDGE_|__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS$|VITE_)/.test(name)), ...Object.keys(injected)])];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  try { for (const name of names) delete process.env[name]; Object.assign(process.env, injected); return await fn(); }
  finally { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}
const logger = output => ({ hasWarned: false, info: (...args) => output.push(args), warn: (...args) => output.push(args), warnOnce: (...args) => output.push(args), error: (...args) => output.push(args), clearScreen() {}, hasErrorLogged: () => false });
async function start(t, fixture, { enabled = true, patch = {}, late, readConfig, observe, lifecycle } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await reservePort(), output = [];
    let server, reads = 0;
    try {
      server = await sanitizedEnvironment(async () => {
        const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development', isPreview: false }, join(fixture.root, 'vite.config.ts'), fixture.root, 'silent', logger(output), 'runner');
        assert.equal(loaded !== null, true);
        const flatten = async values => (await Promise.all(values.map(async value => { value = await value; return Array.isArray(value) ? flatten(value) : value ? [value] : []; }))).flat();
        const plugins = await flatten(loaded.config.plugins ?? []);
        assert.equal(plugins.filter(plugin => plugin.name === 'resonantos-dev-bridge-config').length, 1, 'copied config must wire plugin');
        const replacement = devBridgeConfigPlugin({ expectedPort: port,
          env: () => enabled ? { RESONANTOS_DEV_BRIDGE_CONFIG: '1', RESONANTOS_DEV_BRIDGE_PAGE_KEY: fixture.key } : {},
          readConfig: async (root, onNonLoopback) => { reads++; return readConfig ? readConfig(root, onNonLoopback) : readGeneratedBridgeConfig(root, { onNonLoopback }); },
        });
        if (lifecycle) {
          const hook = replacement.configureServer;
          replacement.configureServer = function (server) {
            lifecycle.configured++;
            server.httpServer?.once('listening', () => lifecycle.listening++);
            return (typeof hook === 'function' ? hook : hook.handler).call(this, server);
          };
        }
        const configured = plugins.map(plugin => plugin.name === replacement.name ? replacement : plugin);
        if (observe) configured.push(observe);
        if (late) configured.push({ name: 'synthetic-late-policy-weakening', configureServer: late });
        return createServer({ ...loaded.config, configFile: false, root: fixture.root, cacheDir: join(fixture.root, '.vite-cache'),
          customLogger: logger(output), logLevel: 'silent', plugins: configured,
          server: { ...loaded.config.server, port, strictPort: true, ...patch } });
      });
      await server.listen();
      fixture.resources.push(() => server.close());
      const authorization = `Basic ${Buffer.from(`dev:${fixture.key}`).toString('base64')}`;
      const origin = `http://127.0.0.1:${port}`;
      const request = (path, options) => requestAt(port, path, options);
      const page = () => request('/', { headers: { Authorization: authorization } });
      const module = path => request(path, { headers: { ...META, Authorization: authorization } });
      return { server, port, origin, authorization, request, page, module, output, reads: () => reads };
    } catch (error) {
      if (server) await server.close();
      if (error.code === 'EADDRINUSE' && attempt < 4) continue;
      throw error;
    }
  }
}
function requestAt(port, path, { headers = {}, method = 'GET' } = {}) {
  assert.notEqual(port, 1430, 'integration never contacts production port');
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 8 * 1024 * 1024) req.destroy(Error('bounded response exceeded')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(10000, () => req.destroy(Error('HTTP timeout'))); req.on('error', reject); req.end();
  });
}
function runChild(program, args, { root, env, input, signal, timeout = 180000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env, shell: false, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16 * 1024 * 1024) child.kill('SIGKILL'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {}); child.stdin.end(input ?? '');
  });
}
async function filesBelow(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name); if (entry.isDirectory()) files.push(...await filesBelow(path)); else if (entry.isFile()) files.push(path);
  }
  return files;
}
// Cases are serial. Failures reveal case IDs only, never captured subprocess,
// Vite, transform, HTTP, or credential-bearing assertion values.
function integration(id, name, fn) {
  test(name, { concurrency: false, timeout: id === 'I6' ? 600000 : 90000 }, async t => {
    const captured = [], original = {};
    for (const name of ['error', 'warn', 'log', 'info']) { original[name] = console[name]; console[name] = (...args) => captured.push(args); }
    try { await fn(t); assert.equal(captured.length, 0, 'no raw console/error channel'); }
    catch { throw new Error(id); }
    finally { for (const name of Object.keys(original)) console[name] = original[name]; }
  });
}
integration('I1', 'real default server preserves part-one denials', async t => {
  const fixture = await isolated(t), h = await start(t, fixture, { enabled: false });
  for (const headers of [{}, { Host: `localhost:${h.port}` }]) { const page = await h.request('/', { headers }); assert.equal(page.status, 200); assert.equal(page.body.includes(PREFIX), false); noMaterial(page.body, Object.values(fixture.value)); }
  const missing = await h.request(ROUTE); assert.equal(missing.status, 404); assert.equal(missing.body, 'Not found.\n');
  assert.equal((await h.request('/src/main.tsx')).status, 200);
  for (const path of [`/${RELATIVE}`, `/@fs/${join(fixture.root, RELATIVE)}`, '/ResonantOS_User/probe', `/@fs/${join(fixture.root, 'ResonantOS_User/probe')}`]) {
    const response = await h.request(path); assert.equal(response.status, 403); noMaterial(response.body, Object.values(fixture.value));
  }
  assert.equal(h.reads(), 0);
});
integration('I2', 'real startup refuses unsafe resolved policy', async t => {
  const fixture = await isolated(t);
  for (const enabled of [false, true]) for (const variant of [
    { patch: { host: '0.0.0.0' } }, { patch: { allowedHosts: true } }, { patch: { strictPort: false } }, { patch: { cors: true } },
    { late: server => { server.config.server.allowedHosts = true; } },
  ]) {
    let reads = 0, accepted, failure, expectedMessage;
    const lifecycle = { configured: 0, listening: 0 };
    try { assertDevServerPolicy({ server: {} }, 49152); } catch (error) { expectedMessage = error.message; }
    try { accepted = await start(t, fixture, { enabled, ...variant, lifecycle, readConfig: async () => { reads++; return fixture.value; } }); } catch (error) { failure = error; }
    assert.equal(lifecycle.configured, 1, 'real delivery configure hook reached');
    assert.equal(lifecycle.listening, 0, 'unsafe server never listened');
    assert.equal(failure instanceof Error && failure.message === expectedMessage, true, 'policy refusal, not setup/import failure');
    if (accepted) await accepted.server.close();
    assert.equal(accepted === undefined, true, 'unsafe startup rejected before listening'); assert.equal(reads, 0);
  }
});
integration('I3', 'authenticated module bypasses transforms and graph', async t => {
  const fixture = await isolated(t), transforms = [], htmlInputs = [];
  const observe = { name: 'synthetic-transform-observer', enforce: 'pre', transform(code, id) { transforms.push([id, code]); }, transformIndexHtml: { order: 'pre', handler(html) { htmlInputs.push(html); return html; } } };
  const h = await start(t, fixture, { observe }), page = await h.page(); assert.equal(page.status, 200);
  const route = routeFrom(page.body), response = await h.module(route); assert.equal(response.status, 200); assert.equal(response.body.includes(fixture.value.bridgeToken), true);
  const material = [PREFIX, route.split('=')[1], fixture.key, ...Object.values(fixture.value), h.authorization];
  noMaterial(JSON.stringify(transforms), material); noMaterial(JSON.stringify(htmlInputs), material);
  const graph = h.server.environments.client.moduleGraph;
  noMaterial(JSON.stringify([...graph.urlToModuleMap.keys(), ...graph.idToModuleMap.keys()]), material);
  for (const path of [ROUTE + '?raw', ROUTE + '?url', '/index.html?html-proxy&index=0.js', '/@id/' + ROUTE, '/@id/__x00__' + ROUTE,
    `/@fs/${join(fixture.root, RELATIVE)}?raw`, ROUTE + '.map']) {
    const alias = await h.request(path, { headers: { ...META, Authorization: h.authorization } }); noMaterial(alias.body, [fixture.key, fixture.value.bridgeToken, fixture.value.capabilityBootstrapToken]);
  }
});
integration('I4', 'second process cannot bootstrap itself', async t => {
  const fixture = await isolated(t), h = await start(t, fixture);
  const script = `import http from 'node:http';
const origin=process.argv[1], port=Number(new URL(origin).port);
const request=(path,headers={})=>new Promise((resolve,reject)=>{const q=http.get({hostname:'127.0.0.1',port,path,headers,agent:false},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,body}));});q.on('error',reject);});
const metadata={'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'script',Origin:origin,Referer:origin+'/'};
const results=[await request('/'),await request('${ROUTE}',metadata),await request('${ROUTE}',{...metadata,Authorization:'Basic invalid'})];
process.stdout.write(JSON.stringify(results));`;
  const result = await runChild(process.execPath, ['--input-type=module', '-e', script, h.origin], { root: fixture.root, env: cleanEnv(fixture.root), signal: t.signal });
  assert.equal(result.code, 0); assert.equal(result.timedOut, false); noMaterial(result.stdout + result.stderr, [fixture.key, h.authorization, ...Object.values(fixture.value)]);
  assert.deepEqual(JSON.parse(result.stdout).map(result => result.status), [401, 401, 403]); assert.equal(h.reads(), 0);
  // Same UID network-only proof; this does not claim filesystem isolation.
});
integration('I5', 'real request-time rotation and missing source are safe', async t => {
  const fixture = await isolated(t), h = await start(t, fixture);
  const first = await h.module(routeFrom((await h.page()).body)); assert.equal(first.body.includes(fixture.value.bridgeToken), true);
  const next = fakeConfig(); await writeFile(join(fixture.root, RELATIVE), writer(next), { mode: 0o600 });
  const second = await h.module(routeFrom((await h.page()).body)); assert.equal(second.status, 200); assert.equal(second.body.includes(next.bridgeToken), true);
  noMaterial(second.body, [fixture.value.bridgeToken, fixture.value.capabilityBootstrapToken]);
  await rm(join(fixture.root, RELATIVE)); const route = routeFrom((await h.page()).body), missing = await h.module(route);
  assert.equal(missing.status, 200); assert.match(missing.body, /^delete globalThis\.__RESONANTOS_BRIDGE_CONFIG__;/); assert.match(missing.body, /await import\('\/src\/main\.tsx'\)/);
  noMaterial(missing.body, [...Object.values(fixture.value), ...Object.values(next)]); assert.equal((await h.module(route)).status, 403); assert.equal(h.reads(), 3);
});
integration('I6', 'opted-in vite build and preview contain no delivered secrets', async t => {
  const fixture = await isolated(t), authorization = `Basic ${Buffer.from(`dev:${fixture.key}`).toString('base64')}`;
  const material = [fixture.value.bridgeToken, fixture.value.capabilityBootstrapToken, fixture.key, authorization, PREFIX,
    'globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze('];
  for (const mode of ['on', 'off', 'missing-key']) {
    const env = cleanEnv(fixture.root);
    if (mode !== 'off') env.RESONANTOS_DEV_BRIDGE_CONFIG = '1';
    if (mode === 'on') env.RESONANTOS_DEV_BRIDGE_PAGE_KEY = fixture.key;
    const result = await runChild('npm', ['run', 'build'], { root: fixture.root, env, signal: t.signal });
    assert.equal(result.code, 0, 'actual build succeeds'); assert.equal(result.timedOut, false);
    noMaterial(result.stdout + result.stderr, material);
    const files = await filesBelow(join(fixture.root, 'dist')); assert.equal(files.length > 0, true);
    for (const file of files) noMaterial((await readFile(file)).toString('utf8'), material);
    const port = await reservePort(); let server;
    try {
      const previewEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('RESONANTOS_DEV_BRIDGE_')));
      server = await sanitizedEnvironment(() => preview({ root: fixture.root, configFile: join(fixture.root, 'vite.config.ts'), configLoader: 'runner', logLevel: 'silent', preview: { host: '127.0.0.1', port, strictPort: true } }), previewEnv);
      for (const path of ['/', ROUTE, `/${RELATIVE}`]) { const response = await requestAt(port, path); noMaterial(response.body, material); assert.equal(response.headers['www-authenticate'], undefined); }
    } finally { if (server) await new Promise(resolve => server.httpServer.close(resolve)); }
    await rm(join(fixture.root, 'dist'), { recursive: true, force: true });
  }
});
integration('I7', 'HMR and error channels never carry credential material', async t => {
  const fixture = await isolated(t), h = await start(t, fixture), messages = [];
  const originalSend = h.server.ws.send;
  h.server.ws.send = function (...args) { messages.push(args); return originalSend.apply(this, args); };
  t.after(() => { h.server.ws.send = originalSend; });
  const page = await h.page(), route = routeFrom(page.body); assert.equal((await h.module(route)).status, 200);
  await h.request('/src/main.tsx');
  const barrier = join(fixture.root, 'src/dev-bridge-hmr-probe.ts');
  const added = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { h.server.watcher.off('add', onAdd); reject(Error('watcher registration timeout')); }, 10000);
    function onAdd(path) { if (path === barrier) { clearTimeout(timer); h.server.watcher.off('add', onAdd); resolve(); } }
    h.server.watcher.on('add', onAdd);
  });
  await writeFile(barrier, 'export const marker = 1;\n'); await added;
  await h.request('/src/dev-bridge-hmr-probe.ts');
  const events = []; h.server.watcher.on('all', (event, path) => events.push([event, path]));
  const next = fakeConfig();
  await writeFile(join(fixture.root, RELATIVE), writer(next), { mode: 0o600 });
  await writeFile(join(fixture.root, 'ResonantOS_User/probe'), 'rotated harmless user-state probe\n');
  const barrierSeen = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { h.server.watcher.off('change', onChange); reject(Error('watcher barrier timeout')); }, 10000);
    function onChange(path) { if (path === barrier) { clearTimeout(timer); h.server.watcher.off('change', onChange); resolve(); } }
    h.server.watcher.on('change', onChange);
  });
  await writeFile(barrier, 'export const marker = 2;\n'); await barrierSeen; await delay(150);
  assert.equal(events.some(([, path]) => path.endsWith('bridge-config.generated.js') || path.includes('ResonantOS_User')), false);
  const material = [PREFIX, route.split('=')[1], fixture.key, h.authorization, fixture.value.bridgeToken, fixture.value.capabilityBootstrapToken, next.bridgeToken, next.capabilityBootstrapToken];
  noMaterial(JSON.stringify(messages), [...material, 'bridgeToken', 'capabilityBootstrapToken']); noMaterial(JSON.stringify(h.output), material);
  const cached = [...h.server.environments.client.moduleGraph.idToModuleMap.values()].map(module => [module.id, module.transformResult?.code]); noMaterial(JSON.stringify(cached), material);
  const originalTransform = h.server.transformIndexHtml;
  try { h.server.transformIndexHtml = async () => { throw Error(material.join(' ')); }; const failed = await h.page(); assert.equal(failed.status, 500); assert.equal(failed.body, 'Development page unavailable.\n'); }
  finally { h.server.transformIndexHtml = originalTransform; }
  noMaterial(JSON.stringify(h.output), material); noMaterial(JSON.stringify(messages), material);
});
integration('I8', 'actual HTTP guard rejects cross-origin and malformed traffic', async t => {
  const fixture = await isolated(t), h = await start(t, fixture), route = routeFrom((await h.page()).body);
  for (const path of ['/', route]) for (const patch of [{ Host: `127.0.0.2:${h.port}` }, { Host: 'attacker.test' }, { Origin: 'null' }, { Origin: 'http://attacker.test' }]) {
    const response = await h.request(path, { headers: { ...META, Authorization: h.authorization, ...patch } });
    assert.equal(response.status, 403); assert.equal(response.body, 'Forbidden.\n'); assert.equal(response.headers['access-control-allow-origin'], undefined); noMaterial(response.body, Object.values(fixture.value));
  }
  for (const path of [ROUTE + '?raw', ROUTE + '?url', ROUTE + '?nonce=%ZZ', route + '&nonce=x', PREFIX + '%63onfig.mjs', PREFIX + './config.mjs', PREFIX + '\\config.mjs']) {
    const response = await h.module(path); assert.equal(response.status, 403); assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const method of ['HEAD', 'POST', 'OPTIONS']) assert.equal((await h.request(route, { method, headers: { ...META, Authorization: h.authorization } })).status, 403);
  for (const patch of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Dest': 'worker' }]) assert.equal((await h.request(route, { headers: { ...META, Authorization: h.authorization, ...patch } })).status, 403);
  assert.equal((await h.request('/src/main.tsx')).status, 200); assert.equal((await h.module(route)).status, 200);
});
integration('I9', 'module challenges missing authorization without spending nonce', async t => {
  const fixture = await isolated(t), h = await start(t, fixture), route = routeFrom((await h.page()).body);
  const denied = await h.request(route, { headers: META }); assert.equal(denied.status, 401); assert.equal(denied.body, 'Authentication required.\n'); assert.equal(denied.headers['www-authenticate'], CHALLENGE); assert.equal(h.reads(), 0);
  const accepted = await h.module(route); assert.equal(accepted.status, 200); assert.equal(accepted.body.includes(fixture.value.bridgeToken), true); assert.equal(h.reads(), 1);
  const replay = await h.module(route); assert.equal(replay.status, 403); assert.equal(replay.body, 'Forbidden.\n'); assert.equal(h.reads(), 1);
});
integration('I10', 'module rejects present wrong authorization without spending nonce', async t => {
  const fixture = await isolated(t), h = await start(t, fixture), route = routeFrom((await h.page()).body);
  const wrong = `Basic ${Buffer.from(`dev:${key()}`).toString('base64')}`;
  for (const Authorization of [wrong, 'Basic invalid', [h.authorization, h.authorization]]) {
    const denied = await h.request(route, { headers: { ...META, Authorization } }); assert.equal(denied.status, 403); assert.equal(denied.body, 'Forbidden.\n'); assert.equal(denied.headers['www-authenticate'], undefined); assert.equal(h.reads(), 0); noMaterial(denied.body, Object.values(fixture.value));
  }
  assert.equal((await h.module(route)).status, 200); assert.equal(h.reads(), 1);
});
