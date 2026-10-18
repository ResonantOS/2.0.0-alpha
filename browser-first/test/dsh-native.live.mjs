#!/usr/bin/env node
/*
 * Conductor-only Task 12 driver. NOT a node:test file; the deterministic runner
 * discovers only *.test.mjs. Authoring/checking this file is not certification.
 *
 * Required environment (absolute paths; no install/home fallback):
 *   DSH_LIVE_PREFIX      exact scratch npm prefix for @deepseek-ai/dsh@0.2.0-rc.2
 *   DSH_LIVE_FINAL_GATE  the final-gate.json consumed by Task 12's assertion
 *   DEEPSEEK_API_KEY     supplied privately; passed to the bridge and telemetry control
 * Optional: DSH_LIVE_MODEL (default deepseek-flash on deepseek-official).
 *
 * Scratch state is newly created BESIDE the supplied prefix, outside this
 * worktree. The prefix is never installed into or modified. No desktop socket
 * is contacted. Child output and all secret comparisons remain in memory.
 * Existing deterministic evidence is deliberately not inherited: this driver
 * writes deterministic:false. The conductor must separately complete Task 12's
 * deterministic checks and browser/plugin observations. Exit 1 means blocked.
 *
 * Internal modes run the actual production launcher, or preload count-only
 * telemetry observation into the exact DSH package. They are not fixture hosts.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { writeSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '../..');
const VERSION = '0.2.0-rc.2';
const KEYS = ['reply', 'overlap', 'history', 'modelSelection', 'cancel', 'revoke',
  'crashRecovery', 'bridgeRestart', 'telemetry', 'noSecretPersistence',
  'desktopUnaffected', 'browserVisible', 'pluginCoexistence'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (root, value) => {
  const rel = path.relative(root, value);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};
async function within(promise, ms = 30000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('observation-timeout')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function until(predicate, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await delay(25);
  }
  throw new Error('observation-timeout');
}
const live = child => child.exitCode === null && child.signalCode === null;
async function stop(child, beforeForce = async () => {}) {
  if (!child || !live(child)) return true;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let clean = true;
  try { await within(exited, 15000); }
  catch { clean = false; await beforeForce(); child.kill('SIGKILL'); await within(exited, 5000); }
  return clean && child.exitCode === 0;
}
async function unusedPort(excluded = []) {
  for (;;) {
    const server = net.createServer();
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    if (port >= 1024 && port !== 19387 && !excluded.includes(port)) return port;
  }
}
function safeEnv(home) {
  return { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
    TMPDIR: path.join(home, 'tmp'), LANG: 'en_US.UTF-8' };
}
async function privateDirectory(dir) { await mkdir(dir, { recursive: true, mode: 0o700 }); }

// The only desktop observation: lsof's passive listener inventory. An absent
// lsof or failed inventory is unproven, not equivalent to "no listener".
function desktopListener() {
  const result = childProcess.spawnSync('lsof',
    ['-nP', '-a', '-iTCP@127.0.0.1:19387', '-sTCP:LISTEN', '-Fp'],
    { shell: false, encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin:/usr/sbin' } });
  if (result.error || ![0, 1].includes(result.status) || result.stderr.trim()) throw new Error('desktop-unobservable');
  const pids = result.stdout.split('\n').filter(line => /^p\d+$/.test(line)).sort();
  if (result.status === 0 && !pids.length) throw new Error('desktop-unobservable');
  return pids;
}

// IPC is private memory transport, never a log or an evidence artifact.
function send(value) { if (process.connected) process.send(value, () => {}); }

function observeLogin(child, endpoint, accept) {
  let pending = '', bytes = 0;
  const observe = chunk => {
    bytes += chunk.length;
    if (bytes > 1048576) { child.stdout.off('data', observe); pending = ''; return; }
    pending += chunk.toString();
    while (pending.includes('\n')) {
      const at = pending.indexOf('\n'), line = pending.slice(0, at).trimEnd();
      pending = pending.slice(at + 1);
      if (!line.startsWith('dsh web: ')) continue;
      try {
        const url = new URL(line.slice(9)), token = url.searchParams.get('token');
        if (url.origin === endpoint && token) accept(token);
      } catch { /* No exception text leaves this process. */ }
    }
  };
  child.stdout.on('data', observe);
}

async function bridgeProcess() {
  assert(process.connected);
  const binding = JSON.parse(process.env.RESONANTOS_HARNESS_BINDINGS)[0];
  const endpoint = binding.endpoint;
  const expectedEntry = await realpath(path.join(process.env.RESONANTOS_DSH_PACKAGE_ROOT,
    'node_modules/@deepseek-ai/dsh/lib/bin.js'));
  const children = new Set();
  const spawn = childProcess.spawn;
  childProcess.spawn = function (file, argv, options) {
    // Record only the exact child launched by the production native manager.
    const owned = file === process.execPath && argv?.[0] === expectedEntry;
    let args = argv, opts = options;
    if (owned && process.env.DSH_LIVE_OBSERVE === '1') {
      const observer = new URL(pathToFileURL(SELF)); observer.search = '?telemetry-observer';
      args = ['--import', observer.href, ...argv];
      opts = { ...options, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] };
    }
    const child = spawn(file, args, opts);
    if (owned) {
      children.add(child);
      send({ kind: 'child-start', disabled: options.env.DSH_TELEMETRY_MODE === 'DISABLED',
        home: options.env.HOME, dshHome: options.env.DSH_HOME });
      child.once('exit', () => { children.delete(child); send({ kind: 'child-exit' }); });
      // Additional bounded stdout observer; never consumes or changes the
      // production manager's own announcement parser or authentication flow.
      observeLogin(child, endpoint, value => send({ kind: 'login-secret', value }));
      if (opts.stdio.length === 4) consumeCounts(child.stdio[3], kind => send({ kind: 'telemetry-count', name: kind }));
    }
    return child;
  };
  syncBuiltinESMExports();
  // Undici's passive diagnostic channel observes the production connector.
  // No alternate auth exchange, cookie injection, or direct DSH probe occurs.
  channel('undici:request:create').subscribe(({ request }) => {
    if (String(request.origin) !== endpoint) return;
    const headers = Array.isArray(request.headers)
      ? request.headers.flatMap((value, i, values) => i % 2 === 0 ? [`${value}: ${values[i + 1]}`] : []).join('\r\n')
      : String(request.headers);
    const cookie = /(?:^|\r?\n)cookie:\s*([^\r\n]+)/i.exec(headers)?.[1];
    if (cookie) send({ kind: 'used-cookie', value: cookie });
    if (/\b(?:origin|x-augmentor-token):/i.test(headers) || request.path.includes('augmentor')) send({ kind: 'protocol-violation' });
  });
  channel('undici:request:headers').subscribe(({ request, response }) => {
    if (String(request.origin) !== endpoint) return;
    if (request.path.startsWith('/?token=')) {
      const headers = response.headers;
      for (let i = 0; i < headers.length; i += 2) {
        if (String(headers[i]).toLowerCase() !== 'set-cookie') continue;
        const pair = String(headers[i + 1]).split(';')[0];
        if (/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/.test(pair)) send({ kind: 'cookie-secret', value: pair });
      }
    }
  });
  process.on('message', async message => {
    if (message?.kind === 'force-owned-cleanup') {
      for (const child of children) if (live(child)) child.kill('SIGKILL');
      return;
    }
    if (message?.kind !== 'crash-owned-child') return;
    const owned = [...children].filter(live);
    if (owned.length !== 1) { send({ kind: 'crash-refused' }); return; }
    const exited = once(owned[0], 'exit');
    owned[0].kill('SIGKILL');
    await exited; send({ kind: 'crashed' });
  });
  // If the conductor disappears, request the production launcher's clean
  // shutdown. The only forced fallback targets ChildProcess objects we own.
  process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
  await import('../host/run-bridge-minimal.mjs');
}

const COUNT_NAMES = new Set(['config', 'disabled', 'exporter', 'export-attempt',
  'feedback-disabled', 'feedback-exercised', 'anchor-missing', 'product-module',
  'network-blocked', 'sink-attempt', 'observer-ready']);
function consumeCounts(pipe, accept) {
  let pending = '';
  pipe.on('data', chunk => {
    pending += chunk.toString();
    if (pending.length > 65536) { pending = ''; accept('anchor-missing'); return; }
    while (pending.includes('\n')) {
      const at = pending.indexOf('\n'), line = pending.slice(0, at); pending = pending.slice(at + 1);
      if (COUNT_NAMES.has(line)) accept(line); else accept('anchor-missing');
    }
  });
}

// Same local-sink/loaded-source technique as Task 0. No installed file changes.
// Exact anchors failing to match make telemetry false. Synthetic feedback uses
// the real session store and canonical feedback event consumer, not a mock OTel
// exporter. This auxiliary lane does not count as provider or browser evidence.
function telemetryObserver() {
  const emit = kind => { try { writeSync(3, `${kind}\n`); } catch { /* Closed observer. */ } };
  globalThis.__dshLiveCount = emit;
  // Only the managed DISABLED lane uses injection; the control uses HTTP.
  // Rate a real reply so the agent loop owns the complete v4 log grammar.
  globalThis.__dshLiveFeedback = owner => {
    if (process.env.DSH_TELEMETRY_MODE !== 'DISABLED') return;
    owner.inject(['messageFeedback', 'sessions'], ctx => {
      void (async () => {
        try {
          const target = await until(() => {
            for (const session of ctx.sessions.list().reverse()) {
              const message = session.snapshotEvents().filter(event =>
                event.type === 'assistant/message' && event.surfaceOp === 'append' &&
                typeof event.data?.message?.id === 'string').at(-1);
              if (message) return { sessionId: session.id, messageId: message.data.message.id };
            }
          }, 180000);
          const rating = await ctx.messageFeedback.put({ ...target,
            rating: 'positive', note: 'Synthetic rating', ifVersion: null });
          assert.equal(rating.ok, true);
          assert.equal(typeof rating.value.version, 'string');
          const comment = await ctx.messageFeedback.put({ ...target,
            rating: 'positive', note: 'Synthetic comment', ifVersion: rating.value.version });
          assert.equal(comment.ok, true);
          emit('feedback-exercised');
        } catch { emit('anchor-missing'); }
      })();
    });
  };
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.includes('/node_modules/@deepseek-ai/')) return result;
    if (result.source == null) return result;
    let source = String(result.source);
    const replace = (needle, replacement) => {
      if (source.split(needle).length !== 2) { emit('anchor-missing'); return; }
      source = source.replace(needle, replacement);
    };
    if (url.endsWith('/dsh-session-telemetry-otel/lib/index.js')) {
      replace('constructor(ctx, config) {', 'constructor(ctx, config) { globalThis.__dshLiveCount("config"); globalThis.__dshLiveFeedback(ctx);');
      replace('if (mode === SessionTelemetryMode.DISABLED) {', 'if (mode === SessionTelemetryMode.DISABLED) { globalThis.__dshLiveCount("disabled");');
      replace('const reporter = ctx.otel.createSessionLogReporter(', 'globalThis.__dshLiveCount("exporter"); const reporter = ctx.otel.createSessionLogReporter(');
      replace('reporter.reportSessionLog(', 'globalThis.__dshLiveCount("export-attempt"); reporter.reportSessionLog(');
      replace('if (isFeedback(session, event)) ctx.logger.warn(DISABLED_FEEDBACK_WARNING);',
        'if (isFeedback(session, event)) { globalThis.__dshLiveCount("feedback-disabled"); ctx.logger.warn(DISABLED_FEEDBACK_WARNING); }');
    }
    if (url.includes('/dsh-client-product-analytics/') || url.includes('/dsh-host-product-telemetry-otel/')) emit('product-module');
    return { ...result, source };
  } });
  const sink = process.env.DSH_TELEMETRY_OTLP_URL ? new URL(process.env.DSH_TELEMETRY_OTLP_URL) : null;
  if (sink) assert(sink.hostname === '127.0.0.1' && +sink.port !== 19387);
  const allow = (host, port) => {
    // Keyed controls may reach only the provider and local sink. Managed
    // DISABLED children may reach only the provider. Unknown traffic is blocked
    // and counted, so it cannot silently make the telemetry check green.
    const local = host === '127.0.0.1' && sink && Number(port) === Number(sink.port);
    const provider = host === 'api.deepseek.com' && Number(port || 443) === 443;
    if (local) emit('sink-attempt');
    if (!local && !provider) { emit('network-blocked'); throw new Error('certification-network-refused'); }
  };
  for (const owner of [http, https]) {
    const original = owner.request;
    owner.request = function (...args) {
      const first = args[0];
      const options = typeof first === 'string' || first instanceof URL ? new URL(first) : first;
      allow(options.hostname ?? options.host, options.port ?? (owner === https ? 443 : 80));
      return original.apply(this, args);
    };
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === 'object' ? first : { port: first, host: args[1] };
    allow(options.host ?? 'localhost', options.port);
    return connect.apply(this, args);
  };
  syncBuiltinESMExports(); emit('observer-ready');
}

async function scanSecrets(roots, secrets) {
  assert(secrets.size > 0);
  const needles = [...secrets].flatMap(value => [...new Set([value, encodeURIComponent(value), Buffer.from(value).toString('base64')])]).map(value => Buffer.from(value));
  let count = 0;
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      assert(++count <= 50000);
      const file = path.join(dir, name), stat = await lstat(file);
      // A skipped link or unreadable/special file is NOT proof of absence.
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) await walk(file);
      else {
        assert(stat.isFile() && stat.size <= 64 * 1024 * 1024);
        const bytes = await readFile(file);
        assert(!needles.some(needle => bytes.includes(needle)));
      }
    }
  }
  for (const root of new Set(roots)) await walk(root);
  return true;
}

async function main() {
  process.umask(0o077);
  const flags = Object.fromEntries(KEYS.map(key => [key, false]));
  const reasons = { browserVisible: 'requires-conductor-browser', pluginCoexistence: 'requires-conductor-browser' };
  const secrets = new Set(), loginSecrets = new Set(), cookieSecrets = new Set();
  const homes = new Set(), started = new Set(), streams = new Set(), bridgeStates = [], dispatchers = new Set();
  let controlSecretObserved = true;
  let scratch, gatePath, bridge, before, prefixWalk, cleanupOK = true, interrupted = false;
  const interrupt = () => { interrupted = true; for (const stream of streams) stream.close(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const step = async (key, action) => {
    try { assert(!interrupted); flags[key] = (await action()) === true; }
    catch { flags[key] = false; }
  };
  async function closeStreams() { await Promise.all([...streams].map(stream => stream.close())); streams.clear(); }
  async function stopBridge() {
    await closeStreams();
    if (!bridge) return true;
    const state = bridge;
    const clean = await stop(state.child, async () => {
      if (state.child.connected) {
        state.child.send({ kind: 'force-owned-cleanup' });
        try { await until(() => state.starts === state.exits, 5000); } catch { /* Escalate only our dedicated group. */ }
      }
      if (live(state.child)) process.kill(-state.child.pid, 'SIGKILL');
    });
    // A clean launcher exit is insufficient if its owned child survived.
    const childrenGone = bridge.starts === bridge.exits;
    bridge = null; return clean && childrenGone;
  }
  try {
    assert(path.isAbsolute(process.env.DSH_LIVE_FINAL_GATE ?? ''));
    const requestedGate = path.resolve(process.env.DSH_LIVE_FINAL_GATE);
    assert(path.basename(requestedGate) === 'final-gate.json');
    const parent = await realpath(path.dirname(requestedGate));
    assert(!inside(ROOT, parent));
    gatePath = path.join(parent, 'final-gate.json');
    // Refuse symlinks and non-regular prior results, rather than following them.
    try { const stat = await lstat(gatePath); assert(stat.isFile() && !stat.isSymbolicLink()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(path.isAbsolute(process.env.DSH_LIVE_PREFIX ?? ''));
    const prefix = await realpath(process.env.DSH_LIVE_PREFIX);
    assert(!inside(ROOT, prefix));
    const { validateDshPrefix } = await import('../host/dsh-runtime.mjs');
    const startedAt = Date.now();
    const validated = await validateDshPrefix(prefix, { deadline: Date.now() + 30000 });
    assert.equal(validated.version, VERSION);
    prefixWalk = { count: validated.count, depth: validated.depth, durationMs: Date.now() - startedAt };
    assert(process.env.DEEPSEEK_API_KEY?.trim());
    secrets.add(process.env.DEEPSEEK_API_KEY);
    scratch = await mkdtemp(path.join(path.dirname(prefix), 'dsh-native-live-'));
    await chmod(scratch, 0o700);
    const home = path.join(scratch, 'home'), dshHome = path.join(scratch, 'dsh');
    for (const dir of [home, path.join(home, 'tmp'), dshHome, path.join(scratch, 'user'), path.join(scratch, 'extension/src')]) await privateDirectory(dir);
    homes.add(home); homes.add(dshHome);
    await copyFile(path.join(ROOT, 'browser-first/resonantos-side-panel-extension/manifest.json'), path.join(scratch, 'extension/manifest.json'));
    const dshPort = await unusedPort(), bridgePort = await unusedPort([dshPort]);
    const manifest = JSON.parse(await readFile(new URL('../host/harness-examples/deepseek-harness-native.json', import.meta.url), 'utf8'));
    manifest.agentRuntime.endpoint = `http://127.0.0.1:${dshPort}`;
    const binding = { name: manifest.agentRuntime.credentialBinding, addonId: manifest.id,
      adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: manifest.agentRuntime.endpoint, source: { managedDsh: true } };
    try { before = desktopListener(); } catch { /* Remains unproven. */ }

    async function boot(observe = false) {
      const state = { starts: 0, exits: 0, disabled: true, counts: {}, cookies: new Set(),
        logins: new Set(), issuedCookies: new Set(), protocolOK: true, crashed: false };
      bridgeStates.push(state);
      const auth = { bridge: randomUUID(), read: randomUUID(), control: randomUUID() };
      const env = { ...safeEnv(home), RESONANTOS_BROWSER_FIRST_USER_ROOT: path.join(scratch, 'user'),
        RESONANTOS_EXTENSION_ROOT: path.join(scratch, 'extension'),
        RESONANTOS_BROWSER_FIRST_BRIDGE_PORT: String(bridgePort), RESONANTOS_BRIDGE_HOST: '127.0.0.1',
        RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN: auth.bridge,
        RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN: auth.read,
        RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN: auth.control,
        RESONANTOS_HARNESS_BINDINGS: JSON.stringify([binding]),
        RESONANTOS_DSH_PACKAGE_ROOT: prefix, RESONANTOS_DSH_HOME: dshHome,
        DSH_LIVE_OBSERVE: observe ? '1' : '0', DSH_TELEMETRY_MODE: 'DISABLED',
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
      const child = childProcess.spawn(process.execPath, [SELF, '--bridge-process'],
        { cwd: ROOT, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      delete env.DEEPSEEK_API_KEY;
      started.add(child); state.child = child; bridge = state;
      child.on('error', () => { state.failed = true; });
      child.stdout.resume(); child.stderr.resume();
      child.on('message', message => {
        if (message.kind === 'child-start') {
          state.starts++; state.disabled &&= message.disabled === true;
          if (inside(scratch, message.home) && inside(scratch, message.dshHome)) { homes.add(message.home); homes.add(message.dshHome); }
          else state.failed = true;
        } else if (message.kind === 'child-exit') state.exits++;
        else if (message.kind === 'login-secret') { state.logins.add(message.value); loginSecrets.add(message.value); secrets.add(message.value); }
        else if (message.kind === 'cookie-secret') {
          state.issuedCookies.add(message.value);
          cookieSecrets.add(message.value); secrets.add(message.value); secrets.add(message.value.slice(message.value.indexOf('=') + 1));
        } else if (message.kind === 'used-cookie') state.cookies.add(message.value);
        else if (message.kind === 'protocol-violation') state.protocolOK = false;
        else if (message.kind === 'crashed') state.crashed = true;
        else if (message.kind === 'telemetry-count' && COUNT_NAMES.has(message.name)) state.counts[message.name] = (state.counts[message.name] ?? 0) + 1;
      });
      const { Agent, fetch: directFetch } = await import('undici');
      const dispatcher = new Agent(); state.dispatcher = dispatcher; dispatchers.add(dispatcher);
      const readRoutes = new Set(['/addons/registry', '/agent/history', '/agent/status', '/agent/events']);
      state.request = async (route, payload = {}, reject = false) => {
        assert(!interrupted && live(child) && !state.failed);
        const get = ['/addons/registry', '/agent/events'].includes(route);
        const query = route === '/agent/events' ? `?${new URLSearchParams(payload)}` : '';
        const response = await directFetch(`http://127.0.0.1:${bridgePort}${route}${query}`, {
          dispatcher, redirect: 'manual', method: get ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', 'x-resonantos-bridge-token': auth.bridge,
            'x-resonantos-bridge-capability-token': readRoutes.has(route) ? auth.read : auth.control },
          ...(get ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(40000),
        });
        if (reject && response.status === 200) { await response.body?.cancel(); throw new Error('stale-reference-accepted'); }
        const value = await response.json();
        if (reject) { assert([400, 403, 404, 409, 410, 503].includes(response.status)); assert(typeof value.code === 'string'); return value; }
        assert.equal(response.status, 200); assert(!value.code); return value;
      };
      state.subscribe = async session => {
        const controller = new AbortController(), events = [];
        const response = await directFetch(`http://127.0.0.1:${bridgePort}/agent/events?${new URLSearchParams(session)}`, {
          dispatcher, redirect: 'manual', headers: { 'x-resonantos-bridge-token': auth.bridge, 'x-resonantos-bridge-capability-token': auth.read },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
        });
        assert.equal(response.status, 200);
        const stream = { events, closed: false, close: async () => { controller.abort(); await stream.done; streams.delete(stream); } };
        stream.done = (async () => {
          let pending = '', size = 0; const decoder = new TextDecoder();
          try {
            for await (const chunk of response.body) {
              size += chunk.length; assert(size <= 4 * 1024 * 1024);
              pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
              while (pending.includes('\n\n')) {
                const end = pending.indexOf('\n\n'), frame = pending.slice(0, end); pending = pending.slice(end + 2);
                const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (data) events.push(JSON.parse(data));
              }
            }
          } catch { stream.readError = true; }
          finally { stream.closed = true; }
        })();
        streams.add(stream); return stream;
      };
      // Read generated config as data, never import/eval it. Confirm the actual
      // listener and this boot's credential before sending any HTTP request;
      // a launcher fallback or stale config must not adopt a foreign listener.
      await until(async () => {
        assert(live(child) && !state.failed);
        try {
          const source = await readFile(path.join(scratch, 'extension/src/bridge-config.generated.js'), 'utf8');
          const match = /^globalThis\.__RESONANTOS_BRIDGE_CONFIG__ = Object\.freeze\((\{.*\})\);\s*$/.exec(source);
          if (!match) return false;
          const config = JSON.parse(match[1]);
          if (config.bridgeToken !== auth.bridge) return false;
          assert.equal(config.bridgeUrl, `http://127.0.0.1:${bridgePort}`);
          return true;
        } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
      });
      await state.request('/addons/registry');
      assert.equal(state.starts, 0); // Native startup must remain lazy.
      return state;
    }
    const request = (...args) => bridge.request(...args);
    const registry = () => request('/addons/registry');
    const grant = async (revoke = false) => request('/addons/grants', { addonId: manifest.id, consent: true,
      expectedRevision: (await registry()).revision,
      grants: manifest.requestedCapabilities.map(item => ({ ...item, granted: !(revoke && item.capability === 'network') })) });
    const session = async () => (await request('/agent/session', { addonId: manifest.id })).session;
    const prompt = (ref, long = false) => request('/agent/turn', { session: ref, input: { messages: [{ role: 'user',
      content: long ? 'Write a detailed 2000-word explanation of prime numbers. Do not use tools.' : 'Reply with one short sentence about prime numbers. Do not use tools.' }] } });
    const matches = (event, ref, turnId) => event.addonId === manifest.id && event.sessionId === ref.sessionId &&
      event.bootEpoch === ref.bootEpoch && event.generation === ref.generation && event.turnId === turnId;
    const terminal = (stream, ref, turnId) => stream.events.find(event => matches(event, ref, turnId) && ['final', 'error', 'cancelled'].includes(event.type));
    async function active(ref) {
      const stream = await bridge.subscribe(ref), { turnId } = await prompt(ref, true);
      await until(() => stream.events.some(event => matches(event, ref, turnId) && event.type === 'status' && event.data?.status === 'running'));
      assert(!terminal(stream, ref, turnId)); return { stream, turnId };
    }
    async function answer(ref) {
      const stream = await bridge.subscribe(ref), { turnId } = await prompt(ref);
      const event = await until(() => terminal(stream, ref, turnId), 125000);
      assert.equal(event.type, 'final'); assert(event.data?.text?.trim());
      assert(bridge.protocolOK && !stream.readError); await stream.close(); return event.data.text;
    }
    async function stale(ref) {
      for (const route of ['/agent/history', '/agent/status', '/agent/turn', '/agent/events']) {
        const payload = route === '/agent/events' ? ref : route === '/agent/turn'
          ? { session: ref, input: { messages: [{ role: 'user', content: 'Stale reference must not dispatch.' }] } } : { session: ref };
        const error = await request(route, payload, true);
        assert(['session-not-found', 'permission-denied', 'stale-generation', 'runtime-unavailable'].includes(error.code));
      }
    }

    await boot();
    await request('/addons/install', { manifest, enabled: true, expectedRevision: (await registry()).revision });
    await grant();
    await request('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: 0 });
    const first = await session(); let firstReply;
    await step('reply', async () => { firstReply = await answer(first); return true; });
    await step('history', async () => {
      assert(firstReply); const { history } = await request('/agent/history', { session: first });
      return history.messages.some(item => item.role === 'assistant' && item.content === firstReply) && history.messages.some(item => item.role === 'user');
    });
    await step('modelSelection', async () => {
      const model = { provider: 'deepseek-official', model: process.env.DSH_LIVE_MODEL || 'deepseek-flash' };
      const result = await request('/agent/select-model', { session: first, model });
      assert.equal(result.selection?.selected, true); await answer(first); return true;
    });
    await step('overlap', async () => {
      const second = await session(); assert.notEqual(second.sessionId, first.sessionId);
      const [a, b] = await Promise.all([active(first), active(second)]);
      assert(!terminal(a.stream, first, a.turnId) && !terminal(b.stream, second, b.turnId));
      const finals = await Promise.all([[a, first], [b, second]].map(async ([turn, ref]) => {
        const event = await until(() => terminal(turn.stream, ref, turn.turnId), 125000);
        assert.equal(event.type, 'final'); assert(event.data?.text?.trim()); await turn.stream.close(); return true;
      }));
      assert.equal(bridge.starts, 1); assert.equal(bridge.cookies.size, 1); assert(bridge.protocolOK);
      await request('/agent/dispose', { session: second }); return finals.every(Boolean);
    });
    await step('cancel', async () => {
      const ref = await session(), turn = await active(ref);
      await request('/agent/cancel', { session: ref, turnId: turn.turnId });
      const event = await until(() => terminal(turn.stream, ref, turn.turnId));
      assert.equal(event.type, 'cancelled'); await delay(250);
      assert(!turn.stream.events.some(event => matches(event, ref, turn.turnId) && event.type === 'final'));
      await turn.stream.close(); await request('/agent/dispose', { session: ref }); return true;
    });
    await step('revoke', async () => {
      const ref = await session(), turn = await active(ref);
      await grant(true);
      await until(() => turn.stream.closed);
      const event = terminal(turn.stream, ref, turn.turnId);
      assert(event && ['error', 'cancelled'].includes(event.type)); await stale(ref);
      await request('/agent/session', { addonId: manifest.id }, true);
      await until(() => bridge.starts === bridge.exits); return true;
    });
    await grant();
    await step('crashRecovery', async () => {
      const ref = await session(), turn = await active(ref), count = bridge.starts;
      bridge.child.send({ kind: 'crash-owned-child' });
      await until(() => bridge.crashed && bridge.exits === count);
      await until(() => turn.stream.closed || terminal(turn.stream, ref, turn.turnId));
      assert.notEqual(terminal(turn.stream, ref, turn.turnId)?.type, 'final');
      await stale(ref); await delay(500); assert.equal(bridge.starts, count);
      const fresh = await session(); assert.notEqual(fresh.sessionId, ref.sessionId);
      await answer(fresh); assert.equal(bridge.starts, count + 1); return true;
    });
    await step('bridgeRestart', async () => {
      const ref = await session(), prior = await registry(), old = bridge;
      assert(await stopBridge()); await old.dispatcher.close();
      await boot(); const next = await registry(); assert.notEqual(next.bootEpoch, prior.bootEpoch);
      await stale(ref); assert.equal(bridge.starts, 0);
      const fresh = await session(); assert.notEqual(fresh.bootEpoch, ref.bootEpoch);
      await answer(fresh); return true;
    });
    await step('telemetry', async () => {
      const modules = path.join(prefix, 'node_modules/@deepseek-ai');
      const config = await readFile(path.join(modules, 'dsh-base/cordis.patch.yml'), 'utf8');
      assert(config.includes('process.env.DSH_TELEMETRY_MODE') && config.includes('process.env.DSH_TELEMETRY_OTLP_URL'));
      const templates = await readFile(path.join(modules, 'dsh-app-boot/lib/index.js'), 'utf8');
      assert(templates.includes('web: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] }'));
      const profile = await readFile(path.join(modules, 'dsh-web-app/cordis.patch.yml'), 'utf8');
      for (const module of ['dsh-client-product-analytics', 'dsh-host-product-telemetry-otel']) {
        assert(profile.includes(`name: '@deepseek-ai/${module}'\n      disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`));
      }
      const old = bridge; assert(await stopBridge()); await old.dispatcher.close();
      // Real production native launch, with observational hooks added only in
      // this lane. Core evidence above came from uninstrumented package runs.
      await boot(true); await answer(await session());
      await until(() => bridge.counts['feedback-exercised'] > 0);
      const observed = bridge; assert(await stopBridge()); await observed.dispatcher.close();
      const counts = observed.counts;
      assert(observed.disabled && counts['observer-ready'] > 0 && counts.config > 0 && counts.disabled > 0 && counts['feedback-disabled'] >= 2);
      for (const key of ['exporter', 'export-attempt', 'anchor-missing', 'product-module', 'network-blocked', 'sink-attempt']) assert.equal(counts[key] ?? 0, 0);
      let sinkRequests = 0;
      const sink = http.createServer((req, res) => { sinkRequests++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
      const sinkPort = await unusedPort([dshPort, bridgePort]);
      sink.listen(sinkPort, '127.0.0.1'); await once(sink, 'listening');
      let control, controlAdapter;
      try {
        const controlHome = path.join(scratch, 'control-home'), controlDsh = path.join(scratch, 'control-dsh');
        for (const dir of [controlHome, path.join(controlHome, 'tmp'), controlDsh, path.join(scratch, 'control-cwd')]) await privateDirectory(dir);
        homes.add(controlHome); homes.add(controlDsh);
        const observer = new URL(pathToFileURL(SELF)); observer.search = '?telemetry-observer';
        const controlPort = await unusedPort([dshPort, bridgePort, sinkPort]), controlCounts = {};
        controlSecretObserved = false;
        let controlToken;
        const endpoint = `http://127.0.0.1:${controlPort}`;
        control = childProcess.spawn(process.execPath, ['--import', observer.href, validated.entry,
          '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(controlPort)], {
          cwd: path.join(scratch, 'control-cwd'), shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
          env: { ...safeEnv(controlHome), DSH_HOME: controlDsh, DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY',
            DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
            DSH_TELEMETRY_OTLP_URL: `http://127.0.0.1:${sinkPort}/v1/logs` },
        });
        started.add(control); control.on('error', () => {});
        observeLogin(control, endpoint, value => { controlToken = value; controlSecretObserved = true; secrets.add(value); loginSecrets.add(value); });
        control.stderr.resume();
        consumeCounts(control.stdio[3], key => { controlCounts[key] = (controlCounts[key] ?? 0) + 1; });
        await until(() => controlToken);
        const { Agent, fetch: directFetch, WebSocket } = await import('undici');
        const dispatcher = new Agent(); dispatchers.add(dispatcher);
        const response = await directFetch(`${endpoint}/?token=${encodeURIComponent(controlToken)}`, {
          dispatcher, redirect: 'manual', signal: AbortSignal.timeout(10000),
        });
        await response.body?.cancel();
        assert.equal(response.status, 303);
        const pairs = response.headers.getSetCookie().map(row => row.split(';')[0]).filter(row => /^dsh-auth-/.test(row));
        assert.equal(pairs.length, 1);
        const cookie = pairs[0];
        assert.match(cookie, /^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/);
        secrets.add(cookie); secrets.add(cookie.slice(cookie.indexOf('=') + 1));
        let sequence = 0, lastPage;
        const raw = async (method, args = {}) => {
          assert(!interrupted && live(control));
          const rpcId = `certification-${++sequence}`;
          const reply = await directFetch(`${endpoint}/api/${method}`, {
            dispatcher, redirect: 'manual', signal: AbortSignal.timeout(10000), method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
          });
          assert.equal(reply.status, 200);
          const body = await reply.json();
          assert.equal(body.type, 'server-response'); assert.equal(body.rpcId, rpcId);
          assert.equal(body.result?.ok, true);
          if (method === 'session/page') lastPage = body.result.value;
          return { status: reply.status, body };
        };
        const sockets = new Set();
        const transport = {
          async request(route, options) {
            const result = await raw(route.slice(5), options.body.payload.args);
            result.body.rpcId = options.body.rpcId;
            return result;
          },
          async openStream({ onMessage, onError, onClose } = {}) {
            const socket = new WebSocket(endpoint.replace('http:', 'ws:') + '/api/remote.mux', { dispatcher, headers: { cookie } });
            sockets.add(socket); streams.add(socket);
            socket.addEventListener('message', event => {
              try { onMessage?.(JSON.parse(event.data)); } catch { onError?.(new Error('invalid-message')); }
            });
            socket.addEventListener('close', () => { sockets.delete(socket); streams.delete(socket); onClose?.(); });
            await within(new Promise((resolve, reject) => {
              socket.addEventListener('open', resolve, { once: true });
              socket.addEventListener('error', () => reject(new Error('opening-failed')), { once: true });
            }), 10000);
            return { send: value => socket.send(JSON.stringify(value)), close: () => socket.close() };
          },
          dispose() { for (const socket of sockets) socket.close(); },
        };
        const { createDshTypertAdapter } = await import('../host/agent-adapters/dsh-typert.mjs');
        controlAdapter = createDshTypertAdapter({ transport });
        const ref = await controlAdapter.createSession();
        await controlAdapter.modelCatalog({ session: ref });
        const frames = await within(Array.fromAsync(controlAdapter.invoke({ session: ref,
          input: { messages: [{ role: 'user', content: 'Reply with the word synthetic. Do not use tools.' }] },
        })), 180000);
        assert.equal(frames.at(-1)?.type, 'final');
        await controlAdapter.history({ session: ref });
        const messageId = lastPage.records.filter(row => row.event?.type === 'assistant/message').at(-1)?.event?.data?.message?.id;
        assert.equal(typeof messageId, 'string');
        const { TYPERT_REMOTE } = await import(pathToFileURL(path.join(modules, 'dsh-message-feedback/lib/typert.remote-client.js')));
        const descriptor = TYPERT_REMOTE.descriptors.find(item => item.service === 'messageFeedback' && item.method === 'put');
        assert(descriptor && descriptor.invocation.kind === 'direct');
        assert.deepEqual(descriptor.parameters.map(item => [item.name, item.wire, item.source]), [['request', 'request', 'json']]);
        const put = async (note, ifVersion) => {
          const request = descriptor.parameters[0].codec.create().parse({
            sessionId: ref.sessionId, messageId, rating: 'positive', note, ifVersion,
          });
          const result = await raw('messageFeedback/put', { request });
          const committed = descriptor.result.create().parse(result.body.result.value);
          assert.equal(committed.ok, true);
          return committed;
        };
        const rating = await put('Synthetic rating', null);
        assert.equal(typeof rating.value.version, 'string');
        const comment = await put('Synthetic comment', rating.value.version);
        assert.equal(comment.ok, true);
        await until(() => controlCounts.exporter > 0 && controlCounts['export-attempt'] > 0 && sinkRequests > 0, 45000);
        await controlAdapter.dispose(); controlAdapter = null;
        await stop(control);
        assert(controlCounts['sink-attempt'] > 0);
        for (const key of ['anchor-missing', 'product-module', 'network-blocked', 'disabled']) assert.equal(controlCounts[key] ?? 0, 0);
      } finally {
        try { await controlAdapter?.dispose(); }
        finally { await stop(control); sink.closeAllConnections(); await new Promise(resolve => sink.close(resolve)); }
      }
      return true;
    });
  } catch { /* Evidence remains false; never serialize exception values. */ }
  finally {
    try { const previous = bridge; const clean = await stopBridge(); cleanupOK = cleanupOK && clean; await previous?.dispatcher?.close(); } catch { cleanupOK = false; }
    for (const child of started) { try { if (live(child)) { await stop(child); cleanupOK = false; } } catch { cleanupOK = false; } }
    for (const dispatcher of dispatchers) await dispatcher.destroy().catch(() => {});
    await step('noSecretPersistence', async () => {
      assert(cleanupOK && loginSecrets.size > 0 && cookieSecrets.size > 0 && homes.size > 0);
      assert(controlSecretObserved && bridgeStates.every(state => state.logins.size >= state.starts && state.issuedCookies.size >= state.starts));
      return scanSecrets([...homes], secrets);
    });
    await step('desktopUnaffected', async () => {
      assert(before); const after = desktopListener();
      // This is only listener continuity, never companion/home/browser proof.
      return JSON.stringify(before) === JSON.stringify(after);
    });
    if (!cleanupOK) { flags.bridgeRestart = false; reasons.bridgeRestart = 'owned-process-cleanup-unproven'; }
    const falseKeys = KEYS.filter(key => !flags[key]);
    for (const key of falseKeys) reasons[key] ??= 'observation-unproven';
    const gate = { deterministic: false, deterministicReason: 'requires-separate-task-12-checks',
      liveVersions: ['0.1.5-rc.1', '0.1.7-rc.2'].map(version => ({ version, status: 'blocked', blockedReasons: ['observer-anchor-missing'] })) };
    gate.liveVersions.push({ version: VERSION, status: falseKeys.length ? 'blocked' : 'certified',
      ...flags, blockedReasons: falseKeys, reasons, ...(prefixWalk ? { prefixWalk } : {}),
      desktopObservation: 'lsof-listener-continuity-only', telemetryObservation: 'canonical-synthetic-feedback-and-local-sink-control' });
    let written = false;
    if (gatePath) {
      const temporary = path.join(path.dirname(gatePath), `.final-gate-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify(gate, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, gatePath); written = true;
      } catch { /* No path, data or exception is printed. */ }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    }
    // Retain scratch state for private conductor inspection; no recursive
    // deletion of the installation or any pre-existing directory is performed.
    for (const key of KEYS) console.log(`${flags[key] ? 'PASS' : 'FAIL'} ${key}`);
    process.exitCode = written && !falseKeys.length && !interrupted ? 0 : 1;
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
}

if (new URL(import.meta.url).search === '?telemetry-observer') telemetryObserver();
else if (process.argv[2] === '--bridge-process') {
  try { await bridgeProcess(); } catch { process.exitCode = 1; process.disconnect?.(); }
} else {
  try { await main(); } catch { for (const key of KEYS) console.log(`FAIL ${key}`); process.exitCode = 1; }
}
