import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { snapshotDshConfig, validateDshPrefix, createDshAnnouncement } from '../host/dsh-runtime.mjs';
const binding = { name: 'dsh.native', addonId: 'addon.deepseek-harness-native', adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081', source: { managedDsh: true } };
test('configuration is native-only, absolute and singular', () => {
  const badEnv = new Proxy({}, { get() { throw new Error('native settings read without binding'); } });
  assert.equal(snapshotDshConfig({ bindings: [], env: badEnv }), null);
  const config = snapshotDshConfig({ bindings: [binding], env: {}, userRoot: '/safe/user', home: '/safe/os', repository: '/repo', platform: 'linux' });
  assert.equal(config.prefix, '');
  assert.equal(config.dshHome, '/safe/user/BrowserFirst/Harnesses/dsh-native');
  for (const change of [
    { bindings: [binding, { ...binding, name: 'another' }] },
    { bindings: [{ ...binding, source: { managedDsh: true, env: 'KEY' } }] },
    { bindings: [{ ...binding, authScheme: 'bearer' }] },
    { bindings: [{ ...binding, adapterId: 'openai-compatible-v1' }] },
    { bindings: [{ ...binding, endpoint: 'http://127.0.0.1:3081/' }] },
    { platform: 'win32' }, { env: { RESONANTOS_DSH_PACKAGE_ROOT: 'relative' } },
    { env: { RESONANTOS_DSH_HOME: 'relative' } },
  ]) assert.throws(() => snapshotDshConfig({ bindings: [binding], env: {}, userRoot: '/safe/user', platform: 'linux', ...change }), /Invalid native DSH configuration/);
});
function tree() {
  const nodes = new Map();
  const dir = path => nodes.set(path, { kind: 'dir', mode: 0o755, uid: 0 });
  for (const path of ['/', '/safe', '/safe/p', '/safe/p/node_modules', '/safe/p/node_modules/@deepseek-ai', '/safe/p/node_modules/@deepseek-ai/dsh', '/safe/p/node_modules/@deepseek-ai/dsh/lib', '/safe/p/node_modules/.bin', '/safe/p/node_modules/js-yaml', '/safe/p/node_modules/js-yaml/bin']) dir(path);
  const file = (path, text = '') => nodes.set(path, { kind: 'file', mode: 0o644, uid: 0, text });
  file('/safe/p/node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }));
  file('/safe/p/node_modules/@deepseek-ai/dsh/lib/bin.js');
  file('/safe/p/node_modules/js-yaml/bin/js-yaml.js');
  nodes.set('/safe/p/node_modules/.bin/js-yaml', { kind: 'link', mode: 0o777, uid: 0, target: '../js-yaml/bin/js-yaml.js' });
  const get = path => { if (!nodes.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return nodes.get(path); };
  const fs = {
    realpath: async path => { get(path); return path; },
    lstat: async path => { const row = get(path); return { ...row, isDirectory: () => row.kind === 'dir', isFile: () => row.kind === 'file', isSymbolicLink: () => row.kind === 'link' }; },
    readlink: async path => get(path).target,
    readFile: async path => get(path).text,
    readdir: async path => [...nodes.keys()].filter(key => key !== path && key.slice(0, key.lastIndexOf('/')) === (path === '/' ? '' : path)).map(key => key.slice(key.lastIndexOf('/') + 1)),
  };
  return { nodes, fs, dir, file };
}
test('walk includes hoisted dependencies, contained npm links and every ancestor', async () => {
  const t = tree(); const result = await validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity });
  assert.equal(result.version, '0.2.0-rc.2'); assert.equal(result.count, t.nodes.size - 2);
  for (const path of ['/', '/safe', '/safe/p', '/safe/p/node_modules/js-yaml/bin/js-yaml.js']) {
    for (const bits of [0o020, 0o002]) {
      const old = t.nodes.get(path).mode; t.nodes.get(path).mode |= bits;
      await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { code: 'runtime-unavailable' });
      t.nodes.get(path).mode = old;
    }
  }
  await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: 0, now: () => 1 }), { code: 'deadline-exceeded' });
});
test('prefix escape fixtures exist and fail containment, not ENOENT', async () => {
  const link = '/safe/p/node_modules/.bin/js-yaml';
  for (const target of ['/outside/ok.js', '../../../outside/ok.js', '/safe/p-neighbor/ok.js', '../../../outside/back']) {
    const t = tree(); t.dir('/outside'); t.file('/outside/ok.js');
    t.dir('/safe/outside'); t.file('/safe/outside/ok.js');
    t.dir('/safe/p-neighbor'); t.file('/safe/p-neighbor/ok.js');
    // The final target is inside, but the intermediate hop escapes the prefix.
    t.nodes.set('/safe/outside/back', { kind: 'link', mode: 0o777, uid: 0, target: '/safe/p/node_modules/js-yaml/bin/js-yaml.js' });
    t.nodes.get(link).target = target;
    let missing = 0;
    const lstat = t.fs.lstat;
    t.fs.lstat = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') missing++; throw error; } };
    await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { code: 'runtime-unavailable', reason: 'package' });
    assert.equal(missing, 0, 'all escape hops must exist and have safe ownership/modes');
  }
});
test('prefix rejects dangling links separately from containment', async () => {
  const t = tree(); t.nodes.get('/safe/p/node_modules/.bin/js-yaml').target = '../missing';
  await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { code: 'runtime-unavailable' });
});
test('prefix rejects link cycles promptly and directory ancestry cycles', async () => {
  const t = tree(), a = '/safe/p/node_modules/.bin/js-yaml', b = '/safe/p/node_modules/.bin/back';
  t.nodes.get(a).target = 'back';
  t.nodes.set(b, { kind: 'link', mode: 0o777, uid: 0, target: 'js-yaml' });
  let reads = 0; const readlink = t.fs.readlink;
  t.fs.readlink = async path => { if (++reads > 4) throw new Error('test cycle watchdog'); return readlink(path); };
  await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { code: 'runtime-unavailable', reason: 'package' });
  assert.equal(reads, 2, 'seen-path guard must reject before the watchdog; a caught watchdog is not cycle proof');
  const d = tree(); d.nodes.get(a).target = '..';
  await assert.rejects(validateDshPrefix('/safe/p', { fs: d.fs, deadline: Infinity }), { code: 'runtime-unavailable', reason: 'package' });
});
test('fixed inclusive count and depth limits refuse partial validation', async () => {
  const t = tree();
  while (t.nodes.size - 2 < 50000) t.file(`/safe/p/f${t.nodes.size}`);
  assert.equal((await validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity })).count, 50000);
  t.file('/safe/p/overflow');
  await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { reason: 'limit' });
  const d = tree(); let path = '/safe/p';
  for (let i = 0; i < 64; i++) { path += '/d'; d.dir(path); }
  assert.equal((await validateDshPrefix('/safe/p', { fs: d.fs, deadline: Infinity })).depth, 64);
  d.file(path + '/overflow');
  await assert.rejects(validateDshPrefix('/safe/p', { fs: d.fs, deadline: Infinity }), { reason: 'limit' });
});
test('announcement is incremental, bounded, exact and silent', () => {
  const token = randomBytes(32).toString('base64url'), tokens = [], errors = [];
  const p = createDshAnnouncement({ endpoint: binding.endpoint, onToken: value => tokens.push(value), onFailure: value => errors.push(value) });
  const line = Buffer.from(`banner é\ndsh web: ${binding.endpoint}/?token=${token}\r\n`);
  for (const byte of line) p.write(Buffer.from([byte]));
  p.write(Buffer.from(`warning\ndsh web: ${binding.endpoint}/?token=${token}\n`));
  assert.deepEqual(tokens, [token]); assert.equal(errors.length, 0);
  p.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=other\n`));
  assert.equal(errors.length, 1); assert.ok(!JSON.stringify(errors).includes(token));
  for (const line of ['dsh web: http://evil.test:3081/?token=x\n', 'dsh web: http://127.0.0.1:3082/?token=x\n', `dsh web: ${binding.endpoint}/?token=x&token=x\n`, `dsh web: ${binding.endpoint}/?token=%00\n`, 'x'.repeat(16385)]) {
    let failed = false;
    const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failed = true; } });
    parser.write(Buffer.from(line)); assert.equal(failed, true);
  }
  let eof = false;
  createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { eof = true; } }).end();
  assert.equal(eof, true);
});
import { prepareDshHome } from '../host/dsh-runtime.mjs';
function homeTree() {
  const t = tree();
  t.fs.mkdir = async path => {
    if (t.nodes.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    t.nodes.set(path, { kind: 'dir', mode: 0o700, uid: process.getuid() });
  };
  t.fs.open = async (path, flags, mode) => {
    assert.equal(flags, 'wx');
    if (t.nodes.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    const row = { kind: 'file', uid: process.getuid(), mode, text: '' }; t.nodes.set(path, row);
    return { writeFile: async text => { row.text = text; }, close: async () => {} };
  };
  t.fs.unlink = async path => { t.nodes.delete(path); };
  const config = snapshotDshConfig({ bindings: [binding], env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', DEEPSEEK_API_KEY: 'synthetic-provider', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'http://bad.invalid', OPENAI_API_KEY: 'not-forwarded', DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY' }, userRoot: '/safe/os/ResonantOS_User', home: '/safe/os', repository: '/safe/repo', platform: 'linux' });
  return { ...t, config };
}
test('managed home protects exact OS home and both DSH subtrees, permits dedicated sibling/default', async () => {
  const blocked = ['/safe/os', '/safe/os/.dsh', '/safe/os/.dsh/empty', '/safe/os/Library/Application Support/Augmentor/data/augmentor/managed-dsh/home', '/safe/os/Library/Application Support/Augmentor/data/augmentor/managed-dsh/home/empty', '/safe/repo/empty'];
  for (const dshHome of blocked) { const t = homeTree(); await assert.rejects(prepareDshHome({ ...t.config, dshHome }, { fs: t.fs }), { reason: 'home' }); }
  for (const custom of [undefined, '/safe/os/.dsh-neighbor']) {
    const t = homeTree(), config = { ...t.config, ...(custom ? { dshHome: custom } : {}) };
    const home = await prepareDshHome(config, { fs: t.fs });
    assert.equal(home.env.DSH_HOME, config.dshHome); assert.equal(home.env.DSH_TELEMETRY_MODE, 'DISABLED');
    assert.deepEqual(Object.keys(home.env).sort(), ['LANG', 'LC_ALL', 'TZ', 'DEEPSEEK_API_KEY', 'HOME', 'DSH_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'PATH', 'DSH_TELEMETRY_MODE'].sort());
    const marker = t.nodes.get(config.dshHome + '/.resonantos/owner.json');
    assert.equal(marker.mode, 0o600); assert.deepEqual(Object.keys(JSON.parse(marker.text)).sort(), ['binding', 'userRoot', 'version']);
    await assert.rejects(prepareDshHome(config, { fs: t.fs }), { reason: 'home' });
    await home.release(false); assert.ok(t.nodes.has(config.dshHome + '/.resonantos/lock'));
    await home.release(true); assert.ok(!t.nodes.has(config.dshHome + '/.resonantos/lock'));
    const reopened = await prepareDshHome(config, { fs: t.fs }); await reopened.release(true);
  }
});
test('managed state rejects adoption, symlinks, loose permissions, wrong identity and dirty cwd', async () => {
  const mutate = [
    (t, root) => t.nodes.set(root + '/.resonantos/home', { kind: 'link', mode: 0o777, uid: process.getuid(), target: '/safe/os' }),
    (t, root) => { t.nodes.get(root).mode = 0o755; },
    (t, root) => { t.nodes.get(root).uid = process.getuid() + 1; },
    (t, root) => { t.nodes.get(root + '/.resonantos/owner.json').mode = 0o644; },
    (t, root) => { t.nodes.get(root + '/.resonantos/owner.json').text = JSON.stringify({ version: 1, binding: 'other', userRoot: '/safe/os/ResonantOS_User' }); },
    (t, root) => t.file(root + '/.resonantos/cwd/unrelated'),
    (t, root) => t.nodes.delete(root + '/.resonantos/owner.json'),
  ];
  for (const change of mutate) {
    const t = homeTree(), root = t.config.dshHome; const home = await prepareDshHome(t.config, { fs: t.fs }); await home.release(true);
    change(t, root); await assert.rejects(prepareDshHome(t.config, { fs: t.fs }), { reason: 'home' });
  }
  const foreign = homeTree(); await foreign.fs.mkdir('/safe/foreign'); foreign.file('/safe/foreign/state');
  await assert.rejects(prepareDshHome({ ...foreign.config, dshHome: '/safe/foreign' }, { fs: foreign.fs }));
});
test('prefix ownership, special files, package identity and strict semver are checked', async () => {
  for (const change of [
    t => { t.nodes.get('/safe').uid = process.getuid() + 1; },
    t => { t.nodes.get('/safe/p/node_modules/.bin/js-yaml').uid = process.getuid() + 1; },
    t => { t.nodes.get('/safe/p/node_modules/js-yaml/bin/js-yaml.js').kind = 'fifo'; },
    t => { t.nodes.get('/safe/p/node_modules/@deepseek-ai/dsh/package.json').text = '{'; },
    t => { t.nodes.get('/safe/p/node_modules/@deepseek-ai/dsh/package.json').text = JSON.stringify({ name: 'wrong', version: '0.2.0' }); },
  ]) { const t = tree(); change(t); await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity })); }
  for (const version of ['0.0.9', '0.3.0', '1.0.0', '0.2', '0.2.0-01', '0.2.0;rm']) {
    const t = tree(); t.nodes.get('/safe/p/node_modules/@deepseek-ai/dsh/package.json').text = JSON.stringify({ name: '@deepseek-ai/dsh', version });
    await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }));
  }
});
test('native version policy admits only the reviewed exact package', async () => {
  for (const version of ['0.1.5-rc.1', '0.1.7-rc.2', '0.1.9', '0.2.0', '0.2.1', '0.2.0-rc.2+unreviewed']) {
    const t = tree(); t.nodes.get('/safe/p/node_modules/@deepseek-ai/dsh/package.json').text = JSON.stringify({ name: '@deepseek-ai/dsh', version });
    await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }),
      { code: 'runtime-unavailable', reason: 'package', message: 'Runtime unavailable.' }, version);
  }
  const t = tree(); assert.equal((await validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity })).version, '0.2.0-rc.2');
});
test('semver grammar rejects a leading-zero prerelease', async () => {
  const t = tree();
  t.nodes.get('/safe/p/node_modules/@deepseek-ai/dsh/package.json').text = JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-01' });
  await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { code: 'runtime-unavailable', reason: 'package' });
});
for (const together of [true, false]) test(`announcement ${together ? 'same-write' : 'later-write'} conflict blocks readiness`, () => {
  const first = `dsh web: ${binding.endpoint}/?token=synthetic\n`;
  const conflict = `dsh web: ${binding.endpoint}/?token=other\n`;
  const tokens = [], errors = [];
  const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken: value => tokens.push(value), onFailure: error => errors.push(error) });
  if (together) parser.write(Buffer.from(first + conflict));
  else { parser.write(Buffer.from(first)); parser.write(Buffer.from(conflict)); }
  assert.deepEqual(tokens, ['synthetic']);
  assert.equal(errors.length, 1, together ? 'same-write conflict blocks readiness' : 'later-write conflict blocks readiness');
  parser.ready(); // No later write/end may be needed to discover the conflict.
});
test('announcement wrong origin retains the fixed port failure reason', () => {
  const errors = [];
  const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure: error => errors.push(error) });
  parser.write(Buffer.from('dsh web: http://127.0.0.1:3082/?token=synthetic\n'));
  assert.equal(errors[0]?.reason, 'port');
});
test('announcement EOF after a valid line permits later protocol Ready', () => {
  for (const tail of ['', 'ordinary trailing warning']) {
    const tokens = [], errors = [];
    const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken: t => tokens.push(t), onFailure: e => errors.push(e) });
    parser.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=synthetic\n${tail}`)); parser.end();
    assert.deepEqual(tokens, ['synthetic']); assert.deepEqual(errors, []);
    parser.ready(); assert.deepEqual(errors, []);
  }
  for (const tail of [`dsh web: ${binding.endpoint}/?token=other`, `dsh web: ${binding.endpoint}/?token=other\n`]) {
    let failures = 0;
    const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failures++; } });
    parser.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=synthetic\n`));
    parser.write(Buffer.from(tail)); parser.end(); assert.equal(failures, 1);
  }
});
test('announcement post-token byte budget remains active', () => {
  let failures = 0;
  const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failures++; } });
  parser.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=synthetic\n`));
  for (let i = 0; i < 1024; i++) parser.write(Buffer.from('x'.repeat(1023) + '\n'));
  assert.equal(failures, 1, 'the total limit still applies after token capture');
});
for (const terminated of [false, true]) test(`announcement line limit applies to ${terminated ? 'complete' : 'partial'} banners`, () => {
  const errors = [];
  const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure: error => errors.push(error) });
  parser.write(Buffer.from('x'.repeat(16385) + (terminated ? '\n' : '')));
  assert.equal(errors.length, 1, 'oversized ordinary line is rejected before token parsing');
});
test('announcement total budget, truncated EOF, equivalent authority and post-Ready discard', () => {
  for (const raw of [`dsh web: http://127.0.0.1:03081/?token=x\n`, `dsh web: ${binding.endpoint}/./?token=x\n`, `dsh web: ${binding.endpoint}/?token=${'x'.repeat(8193)}\n`]) {
    let failed = 0; const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failed++; } }); parser.write(Buffer.from(raw)); assert.equal(failed, 1);
  }
  let failed = 0; const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failed++; } });
  for (let i = 0; i < 1025; i++) parser.write(Buffer.from('x'.repeat(1023) + '\n'));
  assert.equal(failed, 1);
  let truncated = 0; const partial = createDshAnnouncement({ endpoint: binding.endpoint, onToken() { assert.fail('unterminated URL accepted'); }, onFailure() { truncated++; } });
  partial.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=x`)); partial.end(); assert.equal(truncated, 1);
  const ready = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { assert.fail('post-ready output parsed'); } });
  ready.ready(); ready.write(Buffer.alloc(1048577, 120)); ready.end();
});
test('announcement rejects a truncated conflicting URL after token capture', () => {
  const errors = [];
  const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure: error => errors.push(error) });
  parser.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=synthetic\n`));
  parser.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=other`));
  parser.end();
  assert.equal(errors.length, 1);
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDshRuntime } from '../host/dsh-runtime.mjs';
function lifecycle(overrides = {}) {
  const children = [], calls = [], releases = [], failures = [];
  const config = snapshotDshConfig({ bindings: [binding], env: { DEEPSEEK_API_KEY: 'generated-test-provider', NODE_OPTIONS: '--inspect', DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY' }, userRoot: '/safe/user', platform: 'linux' });
  const runtime = createDshRuntime({ config,
    validatePrefix: async () => ({ entry: '/safe/p/node_modules/@deepseek-ai/dsh/lib/bin.js', version: '0.2.0-rc.2' }),
    prepareHome: async () => ({ cwd: '/safe/cwd', env: { HOME: '/safe/home', DSH_HOME: '/safe/dsh', DSH_TELEMETRY_MODE: 'DISABLED' }, release: async exited => releases.push(exited) }),
    reservePort: async () => {}, onFailure: event => failures.push(event),
    spawnImpl(file, argv, options) {
      calls.push({ file, argv, options });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
      child.signals = []; child.kill = signal => { child.signals.push(signal); queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); }); return true; };
      children.push(child);
      queueMicrotask(() => child.stdout.write(`dsh web: ${binding.endpoint}/?token=${randomBytes(32).toString('base64url')}\n`));
      return child;
    },
    log() {}, ...overrides,
  });
  return { runtime, children, calls, releases, failures };
}
test('two authorized leases share one child and only final release stops it', async () => {
  const f = lifecycle(), a = new AbortController(), b = new AbortController();
  assert.equal(f.calls.length, 0);
  const [one, two] = await Promise.all([f.runtime.acquire({ signal: a.signal }), f.runtime.acquire({ signal: b.signal })]);
  assert.equal(one.epoch, two.epoch); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, process.execPath);
  assert.deepEqual(f.calls[0].argv.slice(1), ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '3081']);
  assert.equal(f.calls[0].options.shell, false);
  assert.deepEqual(f.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  const oldExitHandler = f.children[0].listeners('exit')[0];
  assert.equal(typeof oldExitHandler, 'function');
  one.ready(); await one.release(); assert.equal(f.children[0].signals.length, 0);
  await two.release(); assert.deepEqual(f.children[0].signals, ['SIGTERM']); assert.deepEqual(f.releases, [true]);
  await assert.rejects(one.use(() => true));
  const three = await f.runtime.acquire({ signal: new AbortController().signal });
  assert.notEqual(three.epoch, one.epoch); three.ready();
  const replacement = f.children[1], replacementToken = await three.use(value => value.loginToken);
  assert.equal(f.children[0].listenerCount('exit'), 0, 'once listener was consumed during stop');
  oldExitHandler(0, null); // Invoke the captured callback itself after replacement.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(three.signal.aborted, false);
  assert.equal(await three.use(value => value.loginToken), replacementToken);
  assert.equal(f.children[1], replacement); assert.deepEqual(replacement.signals, []);
  assert.equal(f.calls.length, 2);
  await f.runtime.close();
});
test('revoked waiter cannot spawn or publish a late lease', async () => {
  const f = lifecycle(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.runtime.acquire({ signal: controller.signal }));
  assert.equal(f.calls.length, 0); await f.runtime.close();
});
test('child exit fences both leases and next explicit acquisition starts a new epoch', async () => {
  const f = lifecycle(); const a = await f.runtime.acquire({ signal: new AbortController().signal }); a.ready();
  f.children[0].exitCode = 1; f.children[0].emit('exit', 1, null);
  assert.equal(a.signal.aborted, true); assert.equal(f.failures.length, 1);
  await assert.rejects(a.use(() => true)); await a.release();
  const b = await f.runtime.acquire({ signal: new AbortController().signal }); b.ready();
  assert.notEqual(a.epoch, b.epoch); await b.release();
});
test('pending authorization is rechecked after validation; one remaining waiter survives', async () => {
  let finish;
  const install = new Promise(resolve => { finish = resolve; });
  const f = lifecycle({ validatePrefix: () => install });
  const a = new AbortController(), b = new AbortController();
  const first = f.runtime.acquire({ signal: a.signal }), rejected = assert.rejects(first);
  const second = f.runtime.acquire({ signal: b.signal });
  await new Promise(resolve => setImmediate(resolve)); a.abort();
  finish({ entry: '/safe/p/bin.js', version: '0.2.0-rc.2' });
  await rejected; const lease = await second; lease.ready(); assert.equal(f.calls.length, 1); await lease.release();
  let finishDenied;
  const denied = lifecycle({ validatePrefix: () => new Promise(resolve => { finishDenied = resolve; }) });
  const controller = new AbortController(), waiting = denied.runtime.acquire({ signal: controller.signal }), refused = assert.rejects(waiting);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  finishDenied({ entry: '/safe/p/bin.js', version: '0.2.0-rc.2' });
  await refused; await new Promise(resolve => setImmediate(resolve));
  assert.equal(denied.calls.length, 0); await denied.runtime.close();
});
test('one stop clock escalates by 1s/2s/3s and retains lock on unconfirmed exit', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = lifecycle({ beforeStop: () => new Promise(() => {}) });
  const lease = await f.runtime.acquire({ signal: new AbortController().signal }); lease.ready();
  const child = f.children[0], signals = [];
  child.kill = signal => { signals.push({ signal, at: Date.now() }); return true; };
  const stop = lease.release(); assert.equal(lease.signal.aborted, true);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush(); t.mock.timers.tick(1000); await flush();
  assert.deepEqual(signals, [{ signal: 'SIGTERM', at: 2000 }]);
  t.mock.timers.tick(1000); await flush(); assert.equal(signals[1].signal, 'SIGKILL'); assert.equal(signals[1].at, 3000);
  let settled = false; void stop.then(() => { settled = true; });
  t.mock.timers.tick(999); await flush(); assert.equal(settled, false, 'unconfirmed exit keeps the one stop clock until 3s');
  t.mock.timers.tick(1); await flush(); await stop;
  assert.equal(f.releases.length, 0);
  await assert.rejects(f.runtime.acquire({ signal: new AbortController().signal })); assert.equal(f.calls.length, 1);
  await f.runtime.close();
});
test('startup deadline includes prefix validation and never spawns after expiry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let finish;
  const f = lifecycle({ validatePrefix: () => new Promise(resolve => { finish = resolve; }) });
  const waiting = f.runtime.acquire({ signal: new AbortController().signal });
  const refused = assert.rejects(waiting, { code: 'deadline-exceeded' });
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(30000);
  finish({ entry: '/safe/p/bin.js', version: '0.2.0-rc.2' });
  await refused; assert.equal(f.calls.length, 0); await f.runtime.close();
});
test('startup deadline rejects an acquisition even when prefix validation never settles', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const f = lifecycle({ validatePrefix: () => new Promise(() => {}) });
  let settled = false;
  const refused = assert.rejects(f.runtime.acquire({ signal: new AbortController().signal }),
    { code: 'deadline-exceeded' }).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, 'the waiter is rejected without validation settling');
  await refused; assert.equal(f.calls.length, 0); await f.runtime.close();
});
test('startup deadline rejects at 30s while an unconfirmed child drains through 33s', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let child;
  const f = lifecycle({ beforeStop: () => new Promise(() => {}), spawnImpl() {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.signals = [];
    child.kill = signal => { child.signals.push({ signal, at: Date.now() }); return true; };
    return child; // No announcement or exit: the child is synthetic and unconfirmed.
  } });
  let settled = false;
  const refused = assert.rejects(f.runtime.acquire({ signal: new AbortController().signal }),
    { code: 'deadline-exceeded' }).then(() => { settled = true; });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush(); assert.ok(child);
  t.mock.timers.tick(30000); await flush();
  assert.equal(settled, true, 'the caller receives the deadline before cleanup finishes');
  assert.deepEqual(child.signals, []);
  await refused;
  t.mock.timers.tick(1000); await flush(); assert.deepEqual(child.signals, [{ signal: 'SIGTERM', at: 31000 }]);
  t.mock.timers.tick(1000); await flush(); assert.deepEqual(child.signals[1], { signal: 'SIGKILL', at: 32000 });
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.releases.length, 0, 'unconfirmed exit retains the home lock');
  await assert.rejects(f.runtime.acquire({ signal: new AbortController().signal }));
  await f.runtime.close();
});
test('reentrant failure stop keeps the old home locked until its one release settles', async () => {
  let lease, nestedStop, unlock;
  const held = new Promise(resolve => { unlock = resolve; });
  let homeCalls = 0, releaseCalls = 0;
  const f = lifecycle({
    onFailure() { if (lease) nestedStop = lease.fail(); },
    prepareHome: async () => {
      homeCalls++;
      return { cwd: '/safe/cwd', env: { HOME: '/safe/home', DSH_HOME: '/safe/dsh', DSH_TELEMETRY_MODE: 'DISABLED' },
        async release(exited) { assert.equal(exited, true); if (++releaseCalls === 1) await held; } };
    },
  });
  lease = await f.runtime.acquire({ signal: new AbortController().signal }); lease.ready();
  f.children[0].exitCode = 1; f.children[0].emit('exit', 1, null);
  const fresh = f.runtime.acquire({ signal: new AbortController().signal });
  await new Promise(resolve => setImmediate(resolve));
  const observedReleases = releaseCalls, observedHomes = homeCalls;
  unlock(); await nestedStop;
  const next = await fresh; next.ready(); await next.release(); await f.runtime.close();
  assert.equal(observedReleases, 1, 'one stop owns home cleanup despite synchronous reentry');
  assert.equal(observedHomes, 1, 'fresh acquisition waits for old home release');
});
