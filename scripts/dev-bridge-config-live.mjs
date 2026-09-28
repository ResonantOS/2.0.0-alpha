#!/usr/bin/env node
// Private, in-memory operator proof. Never start/restart a server or mutate the
// generated source here. Run only after the operator's fresh foreground startup.
// L14 is a same-UID network client, NOT proof of OS/filesystem isolation.
// L9 needs RESONANTOS_DEV_BRIDGE_HARMLESS_PROBE to designate an EXISTING harmless
// regular file under this checkout's ResonantOS_User/. Missing designation means
// unproved (FAIL L9, exit 1), never a pass inferred from an absent path.
import { chromium } from 'playwright';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'parse5';

const ORIGIN = 'http://127.0.0.1:1430';
const ROOT = resolve(import.meta.dirname, '..');
const PREFIX = '/__resonantos_dev_bridge__/';
const ROUTE = `${PREFIX}config.mjs`;
const GENERATED = 'browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js';
const META = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'script' };
const CHALLENGE = 'Basic realm="ResonantOS development", charset="UTF-8"';
const requireProof = condition => { if (!condition) throw Error('proof unavailable'); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function noMaterial(text, values) { requireProof(values.every(value => !value || !text.includes(value))); }
function request(path, { headers = {}, method = 'GET', hostname = '127.0.0.1', port = 1430 } = {}) {
  // Caller-selected network destinations are prohibited; bridge health below
  // uses the validated generated loopback URL through fetch instead.
  requireProof(hostname === '127.0.0.1');
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method, headers, agent: false }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 8 * 1024 * 1024) req.destroy(Error('response bound')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(15000, () => req.destroy(Error('request timeout'))); req.on('error', reject); req.end();
  });
}
function moduleRoute(html) {
  const matches = [...html.matchAll(/src="(\/__resonantos_dev_bridge__\/config\.mjs\?nonce=[A-Za-z0-9_-]{43})"/g)];
  requireProof(matches.length === 1); return matches[0][1];
}
function pageShape(html) {
  const all = [];
  const visit = node => { all.push(node); for (const child of node.childNodes ?? []) visit(child); }; visit(parse(html));
  const attr = (node, name) => node.attrs?.find(attribute => attribute.name === name)?.value;
  const metas = all.filter(node => node.tagName === 'meta' && attr(node, 'http-equiv')?.toLowerCase() === 'content-security-policy');
  requireProof(metas.length === 1);
  const scripts = all.filter(node => node.tagName === 'script');
  const policy = attr(metas[0], 'content').split(';').filter(part => part.trim().startsWith('script-src '));
  requireProof(policy.length === 1 && policy[0].includes("'self'") && !/unsafe-inline|unsafe-eval/.test(policy[0]));
  const cspNonce = policy[0].match(/'nonce-([A-Za-z0-9_-]{43})'/)?.[1];
  requireProof(Boolean(cspNonce) && scripts.length > 0 && scripts.every(script => attr(script, 'nonce') === cspNonce));
  requireProof(scripts.every(script => all.indexOf(metas[0]) < all.indexOf(script)));
  requireProof(!scripts.some(script => attr(script, 'src')?.startsWith('/src/main.tsx')));
  const route = moduleRoute(html); requireProof(!route.endsWith(cspNonce)); return route;
}
function protectedHeaders(response, page = false) {
  for (const [name, value] of Object.entries({ 'cache-control': 'private, no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    vary: 'Host, Authorization, Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest' })) requireProof(response.headers[name] === value);
  for (const name of ['access-control-allow-origin', 'access-control-allow-credentials', 'etag', 'last-modified', 'location']) requireProof(response.headers[name] === undefined);
  if (page) requireProof(response.headers['x-frame-options'] === 'DENY' && response.headers['content-security-policy']?.includes("frame-ancestors 'none'"));
}
function cleanChildEnv() {
  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
async function privateConfig() {
  // Dynamic import keeps entrypoint failures sanitized when A is not integrated.
  const { readGeneratedBridgeConfig } = await import('./vite-dev-bridge-config.mjs');
  const config = await readGeneratedBridgeConfig(ROOT);
  requireProof(config !== null); return config;
}
async function secondClient(paths) {
  // Input contains public attack paths (including one stolen nonce), never a
  // private file reader, key, Authorization, config, or authorized module body.
  const source = `import http from 'node:http';
let input='';for await(const part of process.stdin)input+=part;
const paths=JSON.parse(input),headers={'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'script',Origin:'${ORIGIN}',Referer:'${ORIGIN}/','X-Forwarded-Host':'127.0.0.1:1430'};
const out=[];for(const path of paths){out.push(await new Promise((resolve,reject)=>{const q=http.get({hostname:'127.0.0.1',port:1430,path,headers,agent:false},r=>{let body='';r.on('data',c=>{body+=c;if(body.length>8*1024*1024)q.destroy(Error('bound'));});r.on('end',()=>resolve({status:r.statusCode,body}));});q.setTimeout(10000,()=>q.destroy(Error('timeout')));q.on('error',reject);}));}
process.stdout.write(JSON.stringify(out));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, env: cleanChildEnv(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill('SIGKILL'); });
    child.once('error', () => { clearTimeout(timer); reject(Error('client unavailable')); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0 || stderr) reject(Error('client unavailable')); else { try { resolve(JSON.parse(stdout)); } catch { reject(Error('client unavailable')); } } });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(paths));
  });
}
async function browserSession(key) {
  const browser = await chromium.launch({ headless: true, env: cleanChildEnv() });
  try {
    const context = await browser.newContext({ httpCredentials: { username: 'dev', password: key, origin: ORIGIN } });
    // Prevent external fonts/services from expanding this loopback-only proof.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    const page = await context.newPage(), violations = [], errors = [], records = new Map();
    await page.exposeFunction('__recordDevCspViolation', directive => violations.push(directive));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
      if (/^(script-src|connect-src)/.test(event.effectiveDirective)) void globalThis.__recordDevCspViolation(event.effectiveDirective);
    }));
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', event => {
      const previous = records.get(event.requestId) ?? {};
      records.set(event.requestId, { ...previous, url: event.request.url, method: event.request.method, requestHeaders: { ...previous.requestHeaders, ...event.request.headers } });
    });
    cdp.on('Network.requestWillBeSentExtraInfo', event => {
      const previous = records.get(event.requestId) ?? {};
      records.set(event.requestId, { ...previous, wireSent: true, requestHeaders: { ...previous.requestHeaders, ...event.headers } });
    });
    cdp.on('Network.responseReceived', event => {
      const previous = records.get(event.requestId) ?? {};
      records.set(event.requestId, { ...previous, status: event.response.status, responseHeaders: { ...previous.responseHeaders, ...event.response.headers } });
    });
    cdp.on('Network.responseReceivedExtraInfo', event => {
      const previous = records.get(event.requestId) ?? {};
      records.set(event.requestId, { ...previous, status: event.statusCode, responseHeaders: { ...previous.responseHeaders, ...event.headers } });
    });
    cdp.on('Network.loadingFailed', event => {
      const previous = records.get(event.requestId) ?? {};
      records.set(event.requestId, { ...previous, corsFailure: Boolean(event.corsErrorStatus), failed: true });
    });
    return { browser, context, page, violations, errors, records };
  } catch { await browser.close(); throw Error('browser unavailable'); }
}
const header = (headers, name) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
async function navigate(session) {
  const response = await session.page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 }); requireProof(response?.status() === 200);
  await session.page.waitForFunction(() => Boolean(globalThis.__RESONANTOS_BRIDGE_CONFIG__) && Object.isFrozen(globalThis.__RESONANTOS_BRIDGE_CONFIG__) && (document.querySelector('#root')?.childElementCount ?? 0) > 0, undefined, { timeout: 30000 });
}
async function diagnostics(session) {
  return session.page.evaluate(async () => {
    try { const transport = await import('/src/core/web-transport.ts'); const result = await transport.webInvoke('provider_diagnostics'); return { ok: result?.ok === true, rejected: false }; }
    catch (error) { return { ok: false, rejected: true, networkError: error instanceof TypeError && /fetch|network/i.test(error.message) }; }
  });
}
async function observeHmr(session, material) {
  const client = await request('/@vite/client'); requireProof(client.status === 200); noMaterial(client.body, material);
  const token = client.body.match(/const wsToken = ("[^"\n]+"|'[^'\n]+');/)?.[1];
  requireProof(Boolean(token));
  const wsToken = token[0] === '"' ? JSON.parse(token) : token.slice(1, -1);
  const protocol = client.body.match(/const socketProtocol = ("[^"\n]*"|null) \|\|/)?.[1];
  const hostname = client.body.match(/const socketHost = `\$\{("[^"\n]*"|null) \|\| importMetaUrl.hostname\}/)?.[1];
  const portMatch = client.body.match(/const hmrPort = (\d+|null|"\d+");/);
  const baseMatch = client.body.match(/\$\{hmrPort \|\| importMetaUrl.port\}\$\{("[^"\n]*")\}`/);
  requireProof(Boolean(portMatch) && Boolean(baseMatch));
  const port = JSON.parse(portMatch[1]) || 1430;
  const host = hostname ? JSON.parse(hostname) || '127.0.0.1' : '127.0.0.1';
  const scheme = protocol ? JSON.parse(protocol) || 'ws' : 'ws';
  requireProof(host === '127.0.0.1' && Number(port) === 1430 && scheme === 'ws');
  const url = `ws://${host}:${port}${JSON.parse(baseMatch[1])}?token=${encodeURIComponent(wsToken)}`;
  requireProof(client.body.includes('"vite-hmr"') || client.body.includes("'vite-hmr'"));
  const messages = []; let socket;
  try {
    // Node's WebSocket does not inherit browser Basic credentials or send Origin.
    socket = new WebSocket(url, 'vite-hmr');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('HMR connection unavailable')), 10000);
      socket.addEventListener('message', event => { const text = String(event.data); messages.push(text); try { if (JSON.parse(text).type === 'connected') { clearTimeout(timer); resolve(); } } catch { /* checked for disclosure below */ } });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('HMR connection unavailable')); }, { once: true });
    });
    await delay(3000); requireProof(socket.readyState === WebSocket.OPEN); requireProof(messages.length > 0);
    for (const message of messages) noMaterial(message, material);
    requireProof(!session.page.isClosed());
  } finally { socket?.close(); }
}

export async function main() {
  const args = process.argv.slice(2); let current = 'L1';
  let session;
  const run = async (id, proof) => { current = id; await proof(); console.log(`PASS ${id}`); };
  try {
    requireProof(args.length === 1 && /^--expect=(on|off|cors-denied)$/.test(args[0]));
    const mode = args[0].slice('--expect='.length);
    if (mode === 'off') {
      // L1/L3/L7/L8/L10 are the disable counterparts of the same live surfaces.
      await run('L1', async () => {
        for (const Host of ['127.0.0.1:1430', 'localhost:1430']) { const response = await request('/', { headers: { Host } }); requireProof(response.status === 200 && !response.body.includes(PREFIX) && !response.body.includes('__RESONANTOS_BRIDGE_CONFIG__')); }
      });
      await run('L3', async () => { const response = await request(ROUTE); requireProof(response.status === 404 && response.body === 'Not found.\n' && !response.headers['www-authenticate']); });
      await run('L7', async () => requireProof((await request(`/${GENERATED}`)).status === 403));
      await run('L8', async () => { for (const suffix of ['', '?raw', '?url']) requireProof((await request(`/@fs/${join(ROOT, GENERATED)}${suffix}`)).status === 403); });
      await run('L10', async () => {
        const browser = await chromium.launch({ headless: true, env: cleanChildEnv() });
        try {
          const context = await browser.newContext();
          await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
          const page = await context.newPage(); await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
          const result = await page.evaluate(async () => {
            let calls = 0; const original = globalThis.fetch;
            globalThis.fetch = (...args) => { calls++; return original(...args); };
            try {
              const transport = await import('/src/core/web-transport.ts'); transport.__resetWebTransportForTests();
              let message = ''; try { await transport.webInvoke('provider_diagnostics'); } catch (error) { message = error.message; }
              return { absent: globalThis.__RESONANTOS_BRIDGE_CONFIG__ === undefined, calls, expectedError: message === 'Browser-first bridge is not configured. Start it with `npm run browser-first:bridge`.' };
            } finally { globalThis.fetch = original; }
          });
          requireProof(result.absent && result.calls === 0 && result.expectedError);
        } finally { await browser.close(); }
      });
      return;
    }
    if (mode === 'cors-denied') current = 'L15';
    const key = process.env.RESONANTOS_DEV_BRIDGE_PAGE_KEY;
    requireProof(/^[A-Za-z0-9_-]{43}$/.test(key ?? ''));
    const authorization = `Basic ${Buffer.from(`dev:${key}`).toString('base64')}`;
    let value = await privateConfig();
    const material = () => [value.bridgeToken, value.capabilityBootstrapToken, key, authorization, JSON.stringify(value)];
    if (mode === 'cors-denied') {
      await run('L15', async () => {
        const bridge = new URL(value.bridgeUrl); requireProof(bridge.hostname === '127.0.0.1');
        // The bridge has no /health route. Privately exercise its real authenticated
        // diagnostics route so an unavailable bridge/auth failure cannot pass as CORS.
        const bootstrap = await fetch(new URL('/api/capability-tokens', bridge), {
          method: 'POST', headers: { 'Content-Type': 'application/json',
            'X-ResonantOS-Bridge-Token': value.bridgeToken,
            'X-ResonantOS-Capability-Bootstrap-Token': value.capabilityBootstrapToken },
          body: JSON.stringify({ capabilities: ['bridge-diagnostics-read'] }),
          signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        requireProof(bootstrap.ok); const bootstrapBody = await bootstrap.json();
        const scoped = bootstrapBody.capabilityTokens?.['bridge-diagnostics-read'];
        requireProof(bootstrapBody.ok === true && typeof scoped === 'string' && scoped.length > 0);
        const health = await fetch(new URL('/status', bridge), { headers: {
          'X-ResonantOS-Bridge-Token': value.bridgeToken,
          'X-ResonantOS-Bridge-Capability-Token': scoped }, signal: AbortSignal.timeout(10000), redirect: 'error' });
        requireProof(health.ok); const healthBody = await health.json(); requireProof(healthBody.ok === true);
        session = await browserSession(key); await navigate(session);
        const result = await diagnostics(session); await delay(500);
        const entries = [...session.records.values()];
        // Playwright does not surface CORS preflight OPTIONS requests to page listeners, so the
        // server-side evidence is taken directly: the bridge's preflight answer for the page origin
        // must not grant it (ACAO absent or not equal to the page origin), and the browser-side
        // fetch below must have been rejected as a CORS failure (CORS is a read gate; see the note before the final assertion).
        const preflight = await fetch(new URL('/api/capability-tokens', bridge), { method: 'OPTIONS', headers: {
          Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-resonantos-bridge-token,x-resonantos-capability-bootstrap-token' },
          signal: AbortSignal.timeout(10000), redirect: 'error' });
        const preflightAcao = preflight.headers.get('access-control-allow-origin') ?? '';
        requireProof(preflight.status < 500 && preflightAcao !== ORIGIN && preflightAcao !== '*');
        requireProof(result.rejected && result.networkError && entries.some(entry => entry.corsFailure));
        // CORS is a browser-side READ gate, not a send gate: observed in Chromium, the bridge still
        // answers the token-bearing POST (loadingFailed reports AllowOriginMismatch on the actual
        // response, not a preflight mismatch). What L15 proves is therefore: the bridge's preflight
        // does not grant the page origin (checked server-side above), and the page cannot read any
        // bridge response (CORS failure recorded on every bridge request the page made). The tokens
        // themselves are protected by L1–L14, not by CORS.
        const bridgeCalls = entries.filter(entry => entry.method !== 'OPTIONS' && entry.url?.startsWith(value.bridgeUrl));
        requireProof(bridgeCalls.length > 0 && bridgeCalls.every(entry => entry.corsFailure === true));
        requireProof(session.violations.length === 0 && !session.errors.some(message => /preamble/i.test(message)));
      });
      return;
    }
    let route;
    await run('L1', async () => { const response = await request('/'); requireProof(response.status === 401 && response.body === 'Authentication required.\n' && response.headers['www-authenticate'] === CHALLENGE); noMaterial(response.body, [...material(), PREFIX]); });
    await run('L2', async () => { const response = await request('/', { headers: { Authorization: authorization } }); requireProof(response.status === 200); route = pageShape(response.body); protectedHeaders(response, true); noMaterial(response.body, material()); });
    await run('L3', async () => {
      const absent = await request(ROUTE, { headers: META }); requireProof(absent.status === 401 && absent.body === 'Authentication required.\n' && absent.headers['www-authenticate'] === CHALLENGE);
      const authenticated = await request(ROUTE, { headers: { ...META, Authorization: authorization } }); requireProof(authenticated.status === 403 && authenticated.body === 'Forbidden.\n'); noMaterial(absent.body + authenticated.body, material());
    });
    await run('L4', async () => { const denied = await request(route, { headers: META }); requireProof(denied.status === 401 && denied.body === 'Authentication required.\n' && denied.headers['www-authenticate'] === CHALLENGE); noMaterial(denied.body, material()); });
    await run('L5', async () => {
      value = await privateConfig();
      const response = await request(route, { headers: { ...META, Authorization: authorization } });
      requireProof(response.status === 200 && response.headers['content-type'] === 'text/javascript; charset=utf-8'); protectedHeaders(response);
      const match = response.body.match(/^globalThis\.__RESONANTOS_BRIDGE_CONFIG__ = Object\.freeze\((.*)\);\s*await import\('\/src\/main\.tsx'\);\s*$/);
      requireProof(Boolean(match)); const delivered = JSON.parse(match[1]);
      requireProof(Object.keys(delivered).sort().join(',') === 'bridgeToken,bridgeUrl,capabilityBootstrapToken');
      requireProof(Object.keys(value).every(name => delivered[name] === value[name])); noMaterial(response.body, [key, authorization]);
    });
    await run('L6', async () => { const response = await request(route, { headers: { ...META, Authorization: authorization, 'If-None-Match': '*', 'If-Modified-Since': new Date().toUTCString() } }); requireProof(response.status === 403 && response.body === 'Forbidden.\n'); protectedHeaders(response); });
    await run('L7', async () => { for (const headers of [{}, { Authorization: authorization }]) { const response = await request(`/${GENERATED}`, { headers }); requireProof(response.status === 403 && /(?:Restricted|denied|outside|403)/i.test(response.body)); noMaterial(response.body, material()); } });
    await run('L8', async () => { for (const suffix of ['', '?raw', '?url']) { const response = await request(`/@fs/${join(ROOT, GENERATED)}${suffix}`); requireProof(response.status === 403); noMaterial(response.body, material()); } });
    await run('L9', async () => {
      const designated = process.env.RESONANTOS_DEV_BRIDGE_HARMLESS_PROBE; requireProof(Boolean(designated));
      const path = resolve(ROOT, designated), stateRoot = join(ROOT, 'ResonantOS_User');
      const rel = relative(stateRoot, path); requireProof(rel && !rel.startsWith('..') && !isAbsolute(rel));
      const stat = await lstat(path); requireProof(stat.isFile() && !stat.isSymbolicLink());
      const canonicalRoot = await realpath(stateRoot), canonicalFile = await realpath(path);
      requireProof(canonicalFile.startsWith(canonicalRoot + '/'));
      const response = await request(`/@fs/${path}`); requireProof(response.status === 403); noMaterial(response.body, material());
    });
    await run('L10', async () => { const response = await request('/src/main.tsx'); requireProof(response.status === 200 && response.body.includes('import')); noMaterial(response.body, material()); });
    await run('L11', async () => { for (const path of ['/', route]) for (const Host of ['127.0.0.2:1430', 'attacker.test']) { const response = await request(path, { headers: { ...META, Host, Authorization: authorization } }); requireProof(response.status === 403 && response.body === 'Forbidden.\n' && !response.headers['www-authenticate']); noMaterial(response.body, material()); } });
    await run('L12', async () => { for (const path of ['/', route]) for (const patch of [{ Origin: 'null' }, { Origin: 'http://attacker.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) { const response = await request(path, { headers: { ...META, Authorization: authorization, ...patch } }); requireProof(response.status === 403 && response.body === 'Forbidden.\n' && !response.headers['access-control-allow-origin']); noMaterial(response.body, material()); } });
    await run('L13', async () => {
      session = await browserSession(key); await navigate(session);
      const result = await diagnostics(session); requireProof(result.ok && !result.rejected); await delay(200);
      const entries = [...session.records.values()];
      const bootstrap = entries.find(entry => entry.method === 'POST' && entry.url === `${value.bridgeUrl}/api/capability-tokens` && entry.status === 200);
      const diagnosticsRequest = entries.find(entry => entry.method === 'GET' && entry.url === `${value.bridgeUrl}/providers/status` && entry.status === 200);
      requireProof(Boolean(bootstrap) && Boolean(diagnosticsRequest) && entries.indexOf(bootstrap) < entries.indexOf(diagnosticsRequest));
      requireProof(Boolean(header(bootstrap.requestHeaders, 'X-ResonantOS-Bridge-Token')) && Boolean(header(bootstrap.requestHeaders, 'X-ResonantOS-Capability-Bootstrap-Token')));
      requireProof(Boolean(header(diagnosticsRequest.requestHeaders, 'X-ResonantOS-Bridge-Token')) && Boolean(header(diagnosticsRequest.requestHeaders, 'X-ResonantOS-Bridge-Capability-Token')));
      requireProof(header(bootstrap.responseHeaders, 'access-control-allow-origin') === ORIGIN && header(diagnosticsRequest.responseHeaders, 'access-control-allow-origin') === ORIGIN);
      requireProof(session.violations.length === 0 && !session.errors.some(message => /preamble/i.test(message)));
    });
    await run('L14', async () => {
      const fresh = await request('/', { headers: { Authorization: authorization } }); requireProof(fresh.status === 200);
      const stolen = moduleRoute(fresh.body);
      const paths = ['/', ROUTE, stolen, `/${GENERATED}`, `/@fs/${join(ROOT, GENERATED)}`, ROUTE + '?raw', ROUTE + '?url', ROUTE + '.map', '/@id/' + ROUTE, '/@vite/client', '/src/main.tsx'];
      const responses = await secondClient(paths); requireProof(responses.length === paths.length);
      requireProof(responses[0].status === 401 && responses[1].status === 401 && responses[2].status === 401 && responses[3].status === 403 && responses[4].status === 403);
      for (const response of responses) { noMaterial(response.body, material()); requireProof(!/^globalThis\.__RESONANTOS_BRIDGE_CONFIG__ = Object\.freeze\(/.test(response.body)); }
    });
    await run('L16', async () => {
      requireProof(Boolean(session));
      const gatedUrls = [...session.records.values()].filter(record => record.url?.includes(PREFIX)).map(record => new URL(record.url).searchParams.get('nonce')).filter(Boolean);
      await observeHmr(session, [...material(), PREFIX, route.split('=')[1], ...gatedUrls]);
    });
  } catch {
    console.error(`FAIL ${current}`); process.exitCode = 1;
  } finally {
    if (session) { try { await session.browser.close(); } catch { console.error(`FAIL ${current}`); process.exitCode = 1; } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('FAIL L1'); process.exitCode = 1; });
}
