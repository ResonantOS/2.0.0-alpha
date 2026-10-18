import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHarnessHostService } from '../host/harness-host-service.mjs';
import { createDshRuntime } from '../host/dsh-runtime.mjs';
import { createHarnessTransport } from '../host/harness-transport.mjs';
const manifest = JSON.parse(await readFile(new URL('../host/harness-examples/deepseek-harness-native.json', import.meta.url)));
const binding = { name: 'dsh.native', addonId: manifest.id, adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: manifest.agentRuntime.endpoint, source: { managedDsh: true } };

for (const retirement of ['single-session', 'whole-host', 'child-exit']) test(`${retirement} retirement ${retirement === 'child-exit' ? 'never sends' : 'sends one bounded'} owned-session cancel`, async t => {
  const requests = [], childSignals = [];
  let stored = null, ownedChild;
  class Socket extends EventTarget {
    bufferedAmount = 0;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'item', streamId: 'augmentor', value: { type: 'snapshot', cursor: 0, records: [], hasMore: false } }) }))); }
    close() {}
  }
  const host = await createHarnessHostService({ userRoot: '/synthetic/user', bindings: [binding], env: {},
    store: { read: async () => stored, write: async value => { stored = structuredClone(value); } },
    nativeRuntimeFactory: options => createDshRuntime({ ...options, log() {},
      validatePrefix: async () => ({ entry: '/synthetic/bin.js', version: '0.2.0-rc.2' }),
      prepareHome: async () => ({ cwd: '/synthetic', env: {}, release: async () => {} }), reservePort: async () => {},
      spawnImpl() {
        const child = ownedChild = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = signal => { childSignals.push(signal); queueMicrotask(() => child.emit('exit', null, signal)); return true; };
        queueMicrotask(() => child.stdout.write(`dsh web: ${binding.endpoint}/?token=synthetic-private-token\n`));
        return child;
      },
    }),
    transportFactory: options => createHarnessTransport({ ...options, WebSocketImpl: Socket,
      fetchImpl: async (url, request) => {
        const path = new URL(url).pathname;
        if (new URL(url).search) return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-synthetic=synthetic-cookie' } });
        const body = JSON.parse(request.body); requests.push({ path, body, headers: request.headers, signal: request.signal });
        const value = path.endsWith('modelCatalog') ? { groups: [] } : path.endsWith('prompt') ? { accepted: true } : {};
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
      },
    }),
  });
  t.after(() => host.close());
  await host.registry.install(manifest, { enabled: true, expectedRevision: 0 });
  await host.registry.setGrants(manifest.id, manifest.requestedCapabilities.map(grant => ({ ...grant, granted: true })), { consent: true, expectedRevision: 1 });
  await host.registry.assignSlot('primary-agent', manifest.id, { expectedGeneration: 0 });
  const first = await host.boundary.createSession({ addonId: manifest.id });
  const second = await host.boundary.createSession({ addonId: manifest.id });
  const turn = host.boundary.invoke(first, { messages: [{ role: 'user', content: 'synthetic active turn' }] });
  for (let i = 0; !requests.some(item => item.path === '/api/session/prompt') && i < 50; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(item => item.path === '/api/session/prompt').length, 1, 'one prompt accepted before retirement');
  if (retirement === 'child-exit') { ownedChild.emit('exit', 1, null); await host.close(); }
  else if (retirement === 'whole-host') await host.close();
  else await host.boundary.dispose(first);
  await turn.completion;
  const cancels = requests.filter(item => item.path === '/api/session/cancel');
  if (retirement === 'child-exit') {
    assert.equal(cancels.length, 0, 'no cookie-bearing cancel is attempted after child exit');
    return;
  }
  assert.equal(cancels.length, 1, 'retirement sends exactly one upstream cancel');
  assert.equal(cancels[0].body.payload.args.request.sessionId, requests.find(item => item.path === '/api/session/prompt').body.payload.args.request.sessionId, 'cancel targets only the retired owned session');
  assert.equal(cancels[0].headers.cookie, 'dsh-auth-synthetic=synthetic-cookie', 'cleanup uses the current shared epoch cookie');
  assert.deepEqual(Object.keys(cancels[0].headers).sort(), ['content-type', 'cookie'], 'cleanup adds no plugin or arbitrary headers');
  assert.equal(requests.filter(item => item.path === '/api/session/prompt').length, 1, 'cleanup never replays a prompt');
  if (retirement === 'whole-host') assert.ok(childSignals.includes('SIGTERM'), 'owned child receives stop after cleanup phase');
  else {
    assert.deepEqual(childSignals, [], 'another lease keeps the child live');
    assert.equal(host.boundary.isLive(second), true, 'second session remains live');
    await host.boundary.status(second);
  }
  await assert.rejects(host.boundary.history(first), { code: 'session-not-found' });
});

import { createHarnessCredentials } from '../host/harness-credentials.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

for (const exitTiming of ['before-cleanup', 'during-connect']) test(`custody refuses cleanup ${exitTiming} with a foreign port rebind`, async t => {
  const original = createServer((req, res) => { res.writeHead(303, { 'set-cookie': 'dsh-auth-test=synthetic-cookie' }); res.end(); });
  original.listen(0, '127.0.0.1'); await once(original, 'listening');
  const port = original.address().port;
  const localBinding = { ...binding, endpoint: `http://127.0.0.1:${port}` };
  const runtime = { ...manifest.agentRuntime, endpoint: localBinding.endpoint };
  let child, attempts = 0, received = 0;
  const nativeRuntime = createDshRuntime({ config: { binding: localBinding, port, inherited: {} }, log() {},
    validatePrefix: async () => ({ entry: '/synthetic/bin.js', version: '0.2.0-rc.2' }),
    prepareHome: async () => ({ cwd: '/synthetic', env: {}, release: async () => {} }), reservePort: async () => {},
    spawnImpl() {
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = signal => { queueMicrotask(() => child.emit('exit', null, signal)); return true; };
      queueMicrotask(() => child.stdout.write(`dsh web: ${localBinding.endpoint}/?token=synthetic\n`)); return child;
    },
  });
  t.after(() => nativeRuntime.close());
  t.after(() => new Promise(resolve => original.close(resolve)));
  const custody = createHarnessCredentials({ bindings: [localBinding], nativeRuntime });
  const credentials = { async acquire(options) {
    const lease = await custody.acquire(options);
    if (exitTiming !== 'during-connect') return lease;
    return { ...lease, cleanupUse(callback, signal) {
      return lease.cleanupUse((...args) => {
        const pending = callback(...args);
        child.emit('exit', 1, null);
        return pending;
      }, signal);
    } };
  } };
  const transport = await createHarnessTransport({ credentials, addonId: binding.addonId, runtime, signal: new AbortController().signal,
    fetchImpl: (url, options) => { if (options.headers.cookie) attempts++; return fetch(url, options); },
  });
  t.after(() => transport.dispose());
  await transport.authenticate(); transport.markReady();
  const sessionId = `resonantos-${randomUUID()}`; transport.bindSession(sessionId);
  await new Promise(resolve => original.close(resolve));
  if (exitTiming === 'before-cleanup') child.emit('exit', 1, null);
  const foreign = createServer((req, res) => { received++; res.end(); });
  foreign.on('connection', () => { received++; });
  foreign.listen(port, '127.0.0.1'); await once(foreign, 'listening');
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  await assert.rejects(transport.cancelOwnedSession(sessionId), { code: 'runtime-unavailable' });
  assert.equal(attempts, 0, 'no cookie-bearing connector call after exit');
  assert.equal(received, 0, 'foreign listener receives neither connection nor request');
});
