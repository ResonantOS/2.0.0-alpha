import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, access, chmod, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createPrivateKey, createPublicKey, verify } from 'node:crypto';
const fixtureSigningKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x46)]) });
import { canonicalReceipt, createHarnessHostService } from '../host/harness-host-service.mjs';
import { createDshRuntime } from '../host/dsh-runtime.mjs';
import { evaluateBridgeRequestForSelfTest } from '../host/bridge-server.mjs';
const waitFor = async predicate => { const end = Date.now() + 5000; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); assert.ok(predicate(), 'expected observation within five seconds'); };
async function selectSafeFixtureBase({ tempDir, homeDir, fs, uid }) {
  for (const candidate of [tempDir, homeDir]) {
    try {
      const base = await fs.realpath(candidate);
      if (!isAbsolute(base)) continue;
      let safe = true;
      for (let path = base; ; path = dirname(path)) {
        const stat = await fs.lstat(path);
        if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022)) { safe = false; break; }
        if (path === dirname(path)) break;
      }
      if (!safe) continue;
      await fs.access(base, constants.W_OK);
      return base;
    } catch { /* Try the next independently safe writable candidate. */ }
  }
  throw new Error('No safe writable native integration fixture base.');
}
test('fixture base falls back from an unsafe temporary ancestor to a safe writable home', async () => {
  const nodes = new Map([
    ['/', { uid: 0, mode: 0o755 }],
    ['/shared', { uid: 0, mode: 0o755 }],
    ['/shared/tmp', { uid: 0, mode: 0o1777 }],
    ['/shared/tmp/private', { uid: 501, mode: 0o700 }],
    ['/home', { uid: 0, mode: 0o755 }],
    ['/home/operator', { uid: 501, mode: 0o700 }],
  ]);
  const fs = { realpath: async path => path,
    lstat: async path => ({ ...nodes.get(path), isDirectory: () => true }),
    access: async path => { if (path !== '/home/operator') throw new Error('unwritable'); } };
  assert.equal(await selectSafeFixtureBase({ tempDir: '/shared/tmp/private', homeDir: '/home/operator', fs, uid: 501 }), '/home/operator');
});
async function setup(t, { occupied = false } = {}) {
  const root = await mkdtemp(join(await selectSafeFixtureBase({ tempDir: tmpdir(), homeDir: homedir(), fs: { realpath, lstat, access }, uid: process.getuid() }), '.resonantos-dsh-test-'));
  const prefix = join(root, 'prefix'), dshHome = join(root, 'state');
  const packageDir = join(prefix, 'node_modules/@deepseek-ai/dsh');
  // Only chmod directories this fixture owns; never repair existing ancestors.
  await chmod(root, 0o700);
  for (const path of [prefix, join(prefix, 'node_modules'), join(prefix, 'node_modules/@deepseek-ai'), packageDir, join(packageDir, 'lib')]) {
    await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700);
  }
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', type: 'module' }), { mode: 0o600 });
  await copyFile(new URL('./dsh-native-fake-child.mjs', import.meta.url), join(packageDir, 'lib/bin.js'));
  await chmod(join(packageDir, 'package.json'), 0o600);
  await chmod(join(packageDir, 'lib/bin.js'), 0o600);
  await mkdir(join(root, 'user'), { mode: 0o700 });
  await chmod(join(root, 'user'), 0o700);
  let sentinelRequests = 0;
  const sentinel = createServer((request, response) => { sentinelRequests++; response.end('foreign'); });
  sentinel.listen(0, '127.0.0.1'); await once(sentinel, 'listening');
  const port = sentinel.address().port; assert.ok(port >= 1024 && port !== 19387);
  if (!occupied) await new Promise(r => sentinel.close(r));
  const manifest = JSON.parse(await readFile(new URL('../host/harness-examples/deepseek-harness-native.json', import.meta.url)));
  manifest.agentRuntime.endpoint = `http://127.0.0.1:${port}`;
  const binding = { name: 'dsh.native', addonId: manifest.id, adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: manifest.agentRuntime.endpoint, source: { managedDsh: true } };
  let promptCount = 0;
  const children = [], spawnOptions = [], receipts = [], privateTokens = [];
  const composition = { userRoot: join(root, 'user'), stateRoot: join(root, 'governance-state'), bindings: [binding], fixtureSigningKey,
    env: { RESONANTOS_DSH_PACKAGE_ROOT: prefix, RESONANTOS_DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY', NODE_OPTIONS: '--inspect', HTTP_PROXY: 'http://127.0.0.1:9', OPENAI_API_KEY: randomUUID() },
    onReceipt: value => receipts.push(value),
    nativeRuntimeFactory: options => createDshRuntime({ ...options, log() {}, spawnImpl(file, argv, options) {
      spawnOptions.push(options); const child = spawn(file, argv, options); children.push(child);
      let pending = ''; child.stdout.on('data', chunk => { pending += chunk.toString(); while (pending.includes('\n')) { const at = pending.indexOf('\n'), line = pending.slice(0, at); pending = pending.slice(at + 1); if (line === 'fixture-prompt') promptCount++; else if (line.startsWith('dsh web: ')) privateTokens.push(new URL(line.slice(9)).searchParams.get('token')); } });
      return child;
    } }),
  };
  let host = await createHarnessHostService(composition);
  t.after(async () => { await host.close(); if (sentinel.listening) await new Promise(r => sentinel.close(r)); await rm(root, { recursive: true, force: true }); });
  const bridgeToken = randomUUID(), capabilities = { 'addon-runtime-read': randomUUID(), 'addon-runtime-control': randomUUID() };
  const call = (url, body = {}, overrides = {}) => {
    const route = host.harnessRoutes.find(row => row.path === url.split('?')[0]);
    return evaluateBridgeRequestForSelfTest({ method: url.startsWith('/addons/registry') ? 'GET' : 'POST', url, body,
      routes: host.harnessRoutes, bridgeToken, bridgeCapabilityTokens: capabilities, listenerPort: 47773,
      headers: { host: '127.0.0.1:47773', 'x-resonantos-bridge-token': bridgeToken, 'x-resonantos-bridge-capability-token': capabilities[route?.requiredCapability] }, rawHeaders: ['Host', '127.0.0.1:47773'], ...overrides });
  };
  async function install() {
    const result = await call('/addons/install', { manifest, enabled: true, expectedRevision: 0 });
    assert.equal(result.status, 200, JSON.stringify(result));
  }
  async function grant(value, only) {
    assert.equal((await call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: only ? (g.capability === only ? value : true) : value })), consent: true, expectedRevision: host.registry.snapshot().revision })).status, 200);
  }
  async function select() {
    assert.equal((await call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: host.registry.snapshot().slots['primary-agent']?.generation ?? 0 })).status, 200);
  }
  return { root, dshHome, manifest, get host() { return host; }, children, spawnOptions, receipts, privateTokens,
    configure: async value => {
      const path = join(packageDir, 'lib/control.json');
      await writeFile(path, JSON.stringify(value), { mode: 0o600 }); await chmod(path, 0o600);
    },
    promptCount: () => promptCount, restart: async () => { await host.close(); host = await createHarnessHostService(composition); }, sentinel, sentinelRequests: () => sentinelRequests, call, install, grant, select };
}
test('route authority and grants precede process acquisition; two sessions share one child', async t => {
  const f = await setup(t), payload = { addonId: f.manifest.id };
  for (const headers of [{}, { 'x-resonantos-bridge-token': 'wrong' }]) assert.equal((await f.call('/agent/session', payload, { headers })).status, 401);
  await f.install(); assert.notEqual((await f.call('/agent/session', payload)).status, 200);
  assert.equal(f.children.length, 0);
  await f.grant(true); await f.select();
  const [a, b] = await Promise.all([f.call('/agent/session', payload), f.call('/agent/session', payload)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(f.children.length, 1);
  assert.notEqual(a.payload.session.sessionId, b.payload.session.sessionId);
  const childEnv = f.spawnOptions[0].env;
  assert.equal(childEnv.DSH_TELEMETRY_MODE, 'DISABLED');
  for (const key of ['NODE_OPTIONS', 'HTTP_PROXY', 'OPENAI_API_KEY']) assert.equal(childEnv[key], undefined);
  assert.ok(childEnv.HOME.startsWith(f.dshHome)); assert.equal(childEnv.DSH_HOME, f.dshHome);
  const input = { messages: [{ role: 'user', content: 'synthetic' }] };
  const readers = [a, b].map(r => f.host.boundary.events(r.payload.session));
  const turns = [a, b].map(r => f.host.boundary.invoke(r.payload.session, input));
  for (const reader of readers) {
    let final;
    for (let n = 0; n < 5; n++) { const { value } = await reader.next(); if (value.type === 'final') { final = value; break; } }
    assert.equal(final.data.text, 'synthetic answer'); await reader.return();
  }
  await Promise.all(turns.map(turn => turn.completion));
  assert.equal((await f.call('/agent/history', { session: a.payload.session })).status, 200);
  assert.equal((await f.call('/agent/select-model', { session: a.payload.session, model: { provider: 'synthetic', model: 'synthetic' } })).status, 200);
  await f.call('/agent/dispose', { session: a.payload.session });
  assert.equal((await f.call('/agent/history', { session: b.payload.session })).status, 200, 'remaining session must keep the child usable');
  assert.equal(f.children[0].exitCode, null);
  await f.grant(false); await waitFor(() => f.children[0].exitCode !== null || f.children[0].signalCode !== null);
  assert.notEqual((await f.call('/agent/session', payload)).status, 200); assert.equal(f.children.length, 1);
  await assert.rejects(access(join(f.dshHome, '.resonantos/lock')));
});
test('valid announcement plus stdout EOF can reach protocol Ready', async t => {
  const f = await setup(t); await f.configure({ closeStdoutAfterAnnouncement: true, catalogDelay: 100 });
  await f.install(); await f.grant(true); await f.select();
  const result = await f.call('/agent/session', { addonId: f.manifest.id });
  assert.equal(result.status, 200); assert.equal(f.children.length, 1);
  assert.equal(f.children[0].stdout.readableEnded, true); assert.equal(f.children[0].exitCode, null);
});
test('conflicting announcement during protocol probe prevents Ready', async t => {
  const f = await setup(t); await f.configure({ conflictingAnnouncement: true, catalogDelay: 100 });
  await f.install(); await f.grant(true); await f.select();
  const result = await f.call('/agent/session', { addonId: f.manifest.id });
  assert.notEqual(result.status, 200); assert.equal(f.children.length, 1);
  await waitFor(() => f.children[0].exitCode !== null || f.children[0].signalCode !== null);
});
test('foreign listener is never contacted or killed', async t => {
  const f = await setup(t, { occupied: true }); await f.install(); await f.grant(true); await f.select();
  const result = await f.call('/agent/session', { addonId: f.manifest.id });
  assert.notEqual(result.status, 200); assert.equal(f.children.length, 0);
  assert.equal(f.sentinelRequests(), 0); assert.equal(f.sentinel.listening, true);
});
test('idle compatibility crash starts a new epoch only for new explicit chat', async t => {
  const f = await setup(t); await f.install(); await f.grant(true); await f.select();
  const input = { messages: [{ role: 'user', content: 'synthetic' }] };
  const a = await f.host.executeBridgeChat(input), projection = f.host.registry.snapshot();
  const exit = once(f.children[0], 'exit'); f.children[0].kill('SIGTERM'); await exit;
  await new Promise(r => setTimeout(r, 30)); assert.equal(f.children.length, 1);
  const b = await f.host.executeBridgeChat(input);
  assert.equal(f.children.length, 2); assert.notEqual(a.harness.sessionId, b.harness.sessionId);
  assert.deepEqual(f.host.registry.snapshot(), projection);
  assert.ok(!JSON.stringify(f.receipts).includes('dsh-auth-'));
});
for (const capability of ['agent-runtime', 'network', 'filesystem', 'shell']) {
  test(`real pending and active sessions stop on ${capability} revocation`, async t => {
    const f = await setup(t); await f.configure({ startupDelay: 250, promptDelay: 250 });
    await f.install(); await f.grant(true); await f.select();
    const pending = f.call('/agent/session', { addonId: f.manifest.id });
    await waitFor(() => f.children.length === 1); await f.grant(false, capability);
    assert.notEqual((await pending).status, 200); assert.equal(f.promptCount(), 0);
    await waitFor(() => f.children[0].exitCode !== null || f.children[0].signalCode !== null);
    await f.grant(true);
    const created = await f.call('/agent/session', { addonId: f.manifest.id }); assert.equal(created.status, 200);
    const session = created.payload.session, reader = f.host.boundary.events(session);
    const turn = f.host.boundary.invoke(session, { messages: [{ role: 'user', content: 'slow synthetic' }] });
    await waitFor(() => f.promptCount() === 1); await f.grant(false, capability);
    const terminal = (await reader.next()).value; assert.equal(terminal.type, 'error');
    assert.equal((await reader.next()).done, true); await turn.completion;
    assert.equal(f.promptCount(), 1); assert.equal(f.host.boundary.isLive(session), false);
    await waitFor(() => f.children[1].exitCode !== null || f.children[1].signalCode !== null);
  });
}
test('clean restart persists governed consent but cannot reuse old sessions', async t => {
  const f = await setup(t); await f.install(); await f.grant(true); await f.select();
  const a = await f.call('/agent/session', { addonId: f.manifest.id }); assert.equal(a.status, 200);
  const before = f.host.registry.snapshot(); await f.restart(); const after = f.host.registry.snapshot();
  assert.notEqual(before.bootEpoch, after.bootEpoch); assert.deepEqual(before.slots, after.slots); assert.deepEqual(before.installations, after.installations);
  assert.notEqual((await f.call('/agent/turn', { session: a.payload.session, input: { messages: [{ role: 'user', content: 'stale' }] } })).status, 200);
  const b = await f.call('/agent/session', { addonId: f.manifest.id }); assert.equal(b.status, 200); assert.equal(f.children.length, 2);
  assert.notEqual(a.payload.session.bootEpoch, b.payload.session.bootEpoch);
  assert.ok(f.receipts.every(receipt => receipt.mode === 'fixture'));
});
test('crash during active chat fails once and never replays its prompt into replacement', async t => {
  const f = await setup(t); await f.configure({ promptDelay: 1000 }); await f.install(); await f.grant(true); await f.select();
  const input = { messages: [{ role: 'user', content: 'synthetic active crash' }] };
  const first = f.host.executeBridgeChat(input), failed = assert.rejects(first);
  await waitFor(() => f.promptCount() === 1);
  const exit = once(f.children[0], 'exit'); f.children[0].kill('SIGTERM'); await exit; await failed;
  assert.equal(f.children.length, 1); assert.equal(f.promptCount(), 1);
  await f.configure({}); await f.host.executeBridgeChat(input);
  assert.equal(f.children.length, 2); assert.equal(f.promptCount(), 2);
});

test('split token is sanitized after assembly in final history and valid signed receipts', async t => {
  const f = await setup(t); await f.configure({ splitSecret: true }); await f.install(); await f.grant(true); await f.select();
  const reply = await f.host.executeBridgeChat({ messages: [{ role: 'user', content: 'synthetic redaction' }] });
  const { turnId, ...session } = reply.harness;
  const history = await f.call('/agent/history', { session }); assert.equal(history.status, 200);
  assert.ok(f.privateTokens.length === 1);
  for (const token of f.privateTokens) {
    for (const value of [reply, history, f.receipts]) assert.equal(JSON.stringify(value).includes(token), false);
  }
  assert.ok(JSON.stringify(history).includes('[redacted]'));
  for (const receipt of f.receipts) {
    const { signature, ...body } = receipt;
    assert.equal(verify(null, Buffer.from(canonicalReceipt(body)), createPublicKey(fixtureSigningKey), Buffer.from(signature, 'base64')), true);
  }
});
