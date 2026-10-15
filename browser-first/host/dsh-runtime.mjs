import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { publicHarnessError } from './harness-adapter-contract.mjs';
const configurationError = 'Invalid native DSH configuration. Check the native binding and DSH settings, then restart the bridge.';
const runtimeError = (code = 'runtime-unavailable', reason = 'startup') => Object.assign(new Error(publicHarnessError({ code }).message), { code, reason });
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
const own = stat => [0, process.getuid()].includes(stat.uid);
const safeNode = stat => own(stat) && !(stat.mode & 0o022) && (stat.isDirectory() || stat.isFile());
export function snapshotDshConfig({ bindings = [], env = process.env, userRoot, platform = process.platform, home = homedir(), repository = resolve(import.meta.dirname, '../..') } = {}) {
  const native = bindings.filter(b => b?.authScheme === 'dsh-native-cookie');
  const refuse = () => { throw new Error(configurationError); };
  if (bindings.some(b => b?.authScheme !== 'dsh-native-cookie' && b?.source && Object.hasOwn(b.source, 'managedDsh'))) refuse();
  if (!native.length) return null;
  if (native.length !== 1 || !['darwin', 'linux'].includes(platform)) refuse();
  const binding = structuredClone(native[0]);
  if (!['name', 'addonId', 'adapterId', 'authScheme', 'endpoint'].every(k => typeof binding[k] === 'string' && binding[k]) || binding.adapterId !== 'dsh-typert-v1' || !binding.source || Object.keys(binding.source).length !== 1 || binding.source.managedDsh !== true) refuse();
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(binding.endpoint);
  if (!match || +match[1] < 1024 || +match[1] > 65535) refuse();
  const prefix = env.RESONANTOS_DSH_PACKAGE_ROOT ?? '';
  const configuredHome = env.RESONANTOS_DSH_HOME ?? '';
  if ([prefix, configuredHome].some(p => typeof p !== 'string' || (p && !isAbsolute(p))) || !isAbsolute(userRoot)) refuse();
  const inherited = {};
  for (const k of ['LANG', 'LC_ALL', 'TZ', 'DEEPSEEK_API_KEY']) if (typeof env[k] === 'string') inherited[k] = env[k];
  return Object.freeze({ binding, prefix, dshHome: configuredHome || join(userRoot, 'BrowserFirst/Harnesses/dsh-native'), userRoot, home, repository, inherited: Object.freeze(inherited), port: +match[1] });
}
export async function validateDshPrefix(prefix, { fs = filesystem, deadline, now = Date.now } = {}) {
  const check = () => { if (now() >= deadline) throw runtimeError('deadline-exceeded', 'deadline'); };
  try {
    check(); if (!prefix || !isAbsolute(prefix)) throw runtimeError('runtime-unavailable', 'package');
    const root = await fs.realpath(prefix); check();
    for (let p = root; ; p = dirname(p)) {
      const stat = await fs.lstat(p); check();
      if (!stat.isDirectory() || !safeNode(stat)) throw runtimeError('runtime-unavailable', 'package');
      if (p === '/') break;
    }
    let count = 0, depth = 0;
    const counted = new Set(), visited = new Set();
    function bound(path) {
      if (!inside(root, path)) throw runtimeError('runtime-unavailable', 'package');
      const d = relative(root, path).split(sep).filter(Boolean).length;
      depth = Math.max(depth, d); if (d > 64) throw runtimeError('runtime-unavailable', 'limit');
    }
    async function target(path, seen = new Set()) {
      bound(path); check();
      if (seen.has(path)) throw runtimeError('runtime-unavailable', 'package');
      seen.add(path);
      const components = relative(root, path).split(sep).filter(Boolean);
      let current = root;
      for (let i = 0; i < components.length; i++) {
        current = join(current, components[i]); bound(current);
        const stat = await fs.lstat(current); check();
        if (stat.isSymbolicLink()) {
          if (!own(stat)) throw runtimeError('runtime-unavailable', 'package');
          const link = resolve(dirname(current), await fs.readlink(current)); check(); bound(link);
          const resolved = await target(link, new Set(seen));
          return target(join(resolved, ...components.slice(i + 1)), new Set(seen));
        }
        if (!safeNode(stat) || (i < components.length - 1 && !stat.isDirectory())) throw runtimeError('runtime-unavailable', 'package');
      }
      return current;
    }
    async function walk(path, ancestry = new Set()) {
      check(); bound(path);
      if (counted.has(path)) return;
      counted.add(path); if (++count > 50000) throw runtimeError('runtime-unavailable', 'limit');
      const stat = await fs.lstat(path); check();
      if (stat.isSymbolicLink()) {
        if (!own(stat)) throw runtimeError('runtime-unavailable', 'package');
        const end = await target(path); if (ancestry.has(end)) throw runtimeError('runtime-unavailable', 'package'); await walk(end, ancestry); return;
      }
      if (!safeNode(stat)) throw runtimeError('runtime-unavailable', 'package');
      if (stat.isDirectory() && !visited.has(path)) {
        visited.add(path);
        for (const name of await fs.readdir(path)) await walk(join(path, name), new Set([...ancestry, path]));
      }
    }
    await walk(root);
    const metadataPath = await target(join(root, 'node_modules/@deepseek-ai/dsh/package.json'));
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); check();
    const semver = /^(0)\.(1|2)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
    if (metadata.name !== '@deepseek-ai/dsh' || typeof metadata.version !== 'string' || !semver.test(metadata.version)) throw runtimeError('runtime-unavailable', 'package');
    // Recorded conductor outcome: native eligibility is exact, not the semver candidate range.
    if (metadata.version !== '0.2.0-rc.2') throw runtimeError('runtime-unavailable', 'package');
    const entry = await target(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
    if (!(await fs.lstat(entry)).isFile()) throw runtimeError('runtime-unavailable', 'package');
    check(); return { entry, version: metadata.version, count, depth };
  } catch (error) {
    if (error?.reason) throw error;
    throw runtimeError('runtime-unavailable', 'package');
  }
}
export async function prepareDshHome(config, { fs = filesystem } = {}) {
  try {
    const requested = resolve(config.dshHome);
    async function normalized(path) {
      try { return await fs.realpath(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return join(await normalized(dirname(path)), basename(path)); }
    }
    const path = await normalized(requested), userRoot = await normalized(resolve(config.userRoot));
    const realHome = await normalized(config.home), repository = await normalized(config.repository);
    if (path === realHome || inside(repository, path) || inside(await normalized(join(realHome, '.dsh')), path) || inside(await normalized(join(realHome, 'Library/Application Support/Augmentor/data/augmentor/managed-dsh/home')), path)) throw runtimeError();
    // Inspect every managed path component. Never chmod existing state into compliance.
    let current = '/';
    for (const part of requested.split('/').filter(Boolean)) {
      current = join(current, part);
      try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw runtimeError(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(current, { mode: 0o700 }); }
    }
    const stat = await fs.lstat(path);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw runtimeError();
    const reserved = join(path, '.resonantos'), marker = join(reserved, 'owner.json');
    const expected = JSON.stringify({ version: 1, binding: config.binding.name, userRoot });
    const names = await fs.readdir(path);
    if (names.length) {
      const r = await fs.lstat(reserved), m = await fs.lstat(marker);
      if (!r.isDirectory() || r.isSymbolicLink() || r.uid !== process.getuid() || (r.mode & 0o077) || !m.isFile() || m.isSymbolicLink() || m.uid !== process.getuid() || (m.mode & 0o077) || await fs.readFile(marker, 'utf8') !== expected) throw runtimeError();
    } else {
      await fs.mkdir(reserved, { mode: 0o700 });
      const file = await fs.open(marker, 'wx', 0o600);
      try { await file.writeFile(expected); } finally { await file.close(); }
    }
    const lockPath = join(reserved, 'lock'), nonce = randomUUID();
    const lockText = JSON.stringify({ pid: process.pid, nonce });
    const lock = await fs.open(lockPath, 'wx', 0o600);
    try { await lock.writeFile(lockText); } finally { await lock.close(); }
    let released = false;
    async function release(exited) {
      if (released || !exited) return;
      if (await fs.readFile(lockPath, 'utf8') !== lockText) throw runtimeError();
      await fs.unlink(lockPath); released = true;
    }
    try {
      for (const part of ['home', 'home/config', 'home/data', 'home/state', 'home/cache', 'tmp', 'cwd']) {
        const dir = join(reserved, part);
        try { await fs.mkdir(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const s = await fs.lstat(dir);
        if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw runtimeError();
      }
      if ((await fs.readdir(join(reserved, 'cwd'))).length) throw runtimeError();
      return { cwd: join(reserved, 'cwd'), release, env: {
        ...config.inherited, HOME: join(reserved, 'home'), DSH_HOME: path, TMPDIR: join(reserved, 'tmp'),
        XDG_CONFIG_HOME: join(reserved, 'home/config'), XDG_DATA_HOME: join(reserved, 'home/data'),
        XDG_STATE_HOME: join(reserved, 'home/state'), XDG_CACHE_HOME: join(reserved, 'home/cache'),
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, DSH_TELEMETRY_MODE: 'DISABLED',
      } };
    } catch (error) { await release(true); throw error; }
  } catch { throw runtimeError('runtime-unavailable', 'home'); }
}
export function createDshAnnouncement({ endpoint, onToken, onFailure }) {
  const decoder = new StringDecoder('utf8'); let pending = '', total = 0, token, done = false, failed = false;
  function reject(reason = 'startup') { if (!failed && !done) { failed = true; pending = ''; onFailure(runtimeError('runtime-unavailable', reason)); } }
  return {
    write(chunk) {
      if (done || failed) return;
      total += Buffer.byteLength(chunk); if (total > 1048576) { reject(); return; }
      pending += decoder.write(chunk);
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n'), raw = pending.slice(0, end); pending = pending.slice(end + 1);
        if (Buffer.byteLength(raw) > 16384) { reject(); return; }
        const line = raw.replace(/\r$/, ''); if (!line.startsWith('dsh web: ')) continue;
        try {
          const rawUrl = line.slice(9), url = new URL(rawUrl);
          if (url.origin !== endpoint) { reject('port'); return; }
          if (!rawUrl.startsWith(endpoint + '/?token=') || url.pathname !== '/' || url.username || url.password || url.hash || [...url.searchParams.keys()].join(',') !== 'token' || rawUrl !== rawUrl.trim()) throw runtimeError();
          const value = url.searchParams.get('token');
          if (!/^[A-Za-z0-9._~-]{1,8192}$/.test(value)) throw runtimeError();
          if (token !== undefined && value !== token) throw runtimeError();
          if (token === undefined) { token = value; onToken(value); }
        } catch { reject(); return; }
      }
      if (Buffer.byteLength(pending) > 16384) reject();
    },
    end() {
      if (done || failed) return;
      pending += decoder.end();
      if (token === undefined || pending.startsWith('dsh web: ')) reject();
      pending = ''; // EOF after a valid line is allowed; readiness is still separate.
    },
    ready() { done = true; pending = ''; token = undefined; },
  };
}
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
async function reserveDshPort(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch { try { server.close(); } catch {} throw runtimeError('runtime-unavailable', 'port'); }
}
const operatorMessages = Object.freeze({
  package: 'Native DSH install prefix is unavailable or unsupported. Select a dedicated prefix with a supported local package and restart the bridge.',
  limit: 'Native DSH install prefix exceeds the validation limit of 50000 entries or depth 64. Use a smaller dedicated prefix and restart the bridge. No child was started.',
  home: 'Native DSH home is unavailable. Use a dedicated home and inspect any existing owner before retrying.',
  port: 'Native DSH could not use its approved port. Choose another port in both binding and manifest, then restart and reinstall the manifest.',
  deadline: 'Native DSH did not become ready within 30 seconds. Check the package and retry with a new session.',
  startup: 'Native DSH startup or authentication failed. Check the installed version and retry with a new session.',
  exit: 'Native DSH stopped. Send a new chat request or create a new session. The previous turn was not retried.',
  unconfirmed: 'Native DSH exit could not be confirmed. Inspect the owned process before reusing its home or port.',
});
export function createDshRuntime({ config, spawnImpl = spawn, validatePrefix = validateDshPrefix, prepareHome = prepareDshHome, reservePort = reserveDshPort, now = Date.now, onFailure = () => {}, beforeStop = async () => {}, log = value => console.error(JSON.stringify(value)) } = {}) {
  let current = null, closing = false, blocked = false;
  const stops = new Set();
  const wait = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  function transition(record, state, reason = 'startup') {
    record.state = state;
    try { log({ event: 'harness.dsh_native', binding: config.binding.name, state, reason,
      ...(Number.isInteger(record.exitCode) ? { exitCode: record.exitCode } : {}),
      ...(['SIGINT', 'SIGTERM', 'SIGKILL'].includes(record.exitSignal) ? { signal: record.exitSignal } : {}),
      message: operatorMessages[reason] ?? operatorMessages.startup }); } catch {}
  }
  function fence(record, code, reason) {
    if (record.fenced) return;
    record.fenced = true;
    clearTimeout(record.timer);
    record.token = '';
    record.reject?.(runtimeError(code, reason));
    record.controller.abort(runtimeError(code, reason));
    try { onFailure({ epoch: record.epoch, code }); } catch {}
  }
  function stop(record, code = 'runtime-unavailable', reason = 'startup') {
    if (record.stop) return record.stop;
    // Publish the stop promise before fencing: abort and failure callbacks may
    // synchronously reenter stop for this same epoch.
    let finish;
    record.stop = new Promise(resolve => { finish = resolve; });
    stops.add(record.stop);
    void record.stop.finally(() => stops.delete(record.stop));
    const start = now(); fence(record, code, reason); transition(record, 'Stopping', reason);
    const cleanup = new AbortController();
    const job = (async () => {
      await Promise.race([Promise.resolve().then(() => beforeStop(record.epoch, cleanup.signal)).catch(() => {}), wait(start + 1000 - now())]);
      cleanup.abort();
      if (record.child && !record.exited) {
        try { record.child.kill('SIGTERM'); } catch {}
        await Promise.race([record.exit, wait(start + 2000 - now())]);
      }
      if (record.child && !record.exited) {
        try { record.child.kill('SIGKILL'); } catch {}
        await Promise.race([record.exit, wait(start + 3000 - now())]);
      }
      if (record.child && !record.exited) { blocked = true; transition(record, 'Failed', 'unconfirmed'); return; }
      // Startup validation may settle after cancellation. Its continuation checks
      // fenced before spawn and releases a subsequently acquired lock itself.
      await record.home?.release(true);
      if (current === record) current = null;
      transition(record, reason === 'exit' ? 'Failed' : 'Stopped', reason);
    })().catch(() => { blocked = true; transition(record, 'Failed', 'unconfirmed'); });
    void job.then(finish); return record.stop;
  }
  function active(record) {
    if (current !== record || record.fenced || closing || ![...record.clients].some(client => !client.signal.aborted)) throw record.controller.signal.reason ?? runtimeError();
  }
  function begin() {
    const record = { epoch: randomUUID(), controller: new AbortController(), clients: new Set(), deadline: now() + 30000, child: null, exited: false, token: '', fenced: false };
    current = record;
    record.timer = setTimeout(() => { record.reject?.(runtimeError('deadline-exceeded', 'deadline')); void stop(record, 'deadline-exceeded', 'deadline'); }, 30000);
    // Start on a microtask so acquire registers its first authorized waiter first.
    record.started = Promise.resolve().then(async () => {
      transition(record, 'Starting');
      const install = await validatePrefix(config.prefix, { deadline: record.deadline, now }); active(record);
      record.version = install.version;
      const home = await prepareHome(config); record.home = home;
      try { active(record); } catch (error) { await home.release(true); throw error; }
      await reservePort(config.port); active(record);
      if (now() >= record.deadline) throw runtimeError('deadline-exceeded', 'deadline');
      const announced = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
      record.child = spawnImpl(process.execPath, [install.entry, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(config.port)], { shell: false, cwd: home.cwd, env: home.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const child = record.child;
      record.exit = new Promise(resolve => {
        child.once('exit', (code, signal) => {
          record.exited = true; record.exitCode = code; record.exitSignal = signal; resolve();
          if (current !== record) return;
          // This callback may act on the active epoch only after identity matches.
          // stop is already idempotent for a fenced current epoch.
          record.reject(runtimeError()); void stop(current, 'runtime-unavailable', 'exit');
        });
      });
      child.once('error', () => { record.reject(runtimeError()); void stop(record); });
      if (!child.stdout || !child.stderr) throw runtimeError();
      const parser = createDshAnnouncement({ endpoint: config.binding.endpoint,
        onToken(token) { if (!record.fenced && current === record) { record.token = token; record.resolve(); } },
        onFailure(error) { record.reject(error); void stop(record, error.code, error.reason); },
      });
      record.parser = parser;
      child.stdout.on('data', chunk => parser.write(chunk)); child.stdout.on('end', () => parser.end()); child.stderr.resume();
      await announced; active(record); transition(record, 'Announced'); return record;
    }).catch(async error => { await stop(record, error.code ?? 'runtime-unavailable', error.reason ?? 'startup'); throw runtimeError(error.code, error.reason); });
    record.started.catch(() => {}); return record;
  }
  return Object.freeze({
    async acquire({ signal } = {}) {
      if (!signal || signal.aborted || closing || blocked || !config) throw runtimeError();
      if (current?.stop) await current.stop;
      if (signal.aborted || closing || blocked) throw runtimeError();
      const record = current ?? begin(), client = { signal, released: false };
      record.clients.add(client);
      const release = () => {
        if (client.released) return record.stop ?? Promise.resolve();
        client.released = true; signal.removeEventListener('abort', abort); record.controller.signal.removeEventListener('abort', fenced); record.clients.delete(client);
        return record.clients.size ? Promise.resolve() : stop(record);
      };
      let rejectAbort;
      const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
      const abort = () => { rejectAbort(runtimeError()); void release(); };
      const fenced = () => rejectAbort(record.controller.signal.reason ?? runtimeError());
      signal.addEventListener('abort', abort, { once: true });
      record.controller.signal.addEventListener('abort', fenced, { once: true });
      try {
        await Promise.race([record.started, cancelled]);
        if (signal.aborted || client.released) throw runtimeError(); active(record);
        return Object.freeze({
          epoch: record.epoch, signal: record.controller.signal, deadline: record.deadline, version: record.version,
          async use(callback) { if (client.released || signal.aborted) throw runtimeError(); active(record); return callback({ endpoint: config.binding.endpoint, loginToken: record.token, providerKey: config.inherited.DEEPSEEK_API_KEY }); },
          ready() { active(record); clearTimeout(record.timer); record.parser.ready(); if (record.state !== 'Ready') transition(record, 'Ready'); },
          fail(code = 'runtime-unavailable') { return stop(record, code, code === 'deadline-exceeded' ? 'deadline' : 'startup'); },
          release,
        });
      } catch (error) { void release(); throw error; }
    },
    async close() { closing = true; if (current) stop(current); await Promise.allSettled([...stops]); },
  });
}
