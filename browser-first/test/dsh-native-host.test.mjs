import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { createHarnessTransport } from '../host/harness-transport.mjs';
import { createHarnessHostService } from '../host/harness-host-service.mjs';
const native = JSON.parse(await readFile(new URL('../host/harness-examples/deepseek-harness-native.json', import.meta.url)));
async function fixture(t, { sessionGate, invokeGate, nativeClose = async () => {}, transportFactoryOverride, sessionRejectDisposed = false, nativeRuntimeOverride } = {}) {
  let stored = null, epoch = 0, onFailure, resolves = 0;
  const receipts = [], secret = randomBytes(24).toString('base64url');
  const host = await createHarnessHostService({ userRoot: '/safe/user', env: {},
    bindings: [{ name: 'dsh.native', addonId: native.id, adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: native.agentRuntime.endpoint, source: { managedDsh: true } }],
    store: { read: async () => stored, write: async value => { stored = structuredClone(value); } }, onReceipt: receipt => receipts.push(receipt),
    nativeRuntimeFactory(options) { onFailure = options.onFailure; return nativeRuntimeOverride ?? { close: nativeClose }; },
    transportFactory: transportFactoryOverride ?? (async () => ({ epoch: `epoch-${epoch}`, runtimeSignal: new AbortController().signal, deadline: Date.now() + 30000,
      authenticate: async () => {}, markReady() {}, failRuntime() {}, bindSession() {}, dispose: async () => {},
      readinessLease: () => ({ ready() {}, fail: async () => {}, dispose: async () => {} }), sanitize: value => JSON.parse(JSON.stringify(value).split(secret).join('[redacted]')),
    })),
    dshAdapterFactory: ({ transport }) => ({ probe: async () => ({ protocolReady: true, providerAvailable: true }),
      createSession: async () => { resolves++; if (sessionGate) await sessionGate;
        if (sessionRejectDisposed && transport.isDisposed) throw new Error('first waiter transport disposed');
        return { sessionId: `resonantos-${randomUUID()}` }; }, dispose: async () => {}, cancel: async () => {},
      async *invoke() { if (invokeGate) await invokeGate; yield { type: 'delta', data: { text: secret.slice(0, 12) } }; yield { type: 'delta', data: { text: secret.slice(12) } }; yield { type: 'final', data: { text: secret } }; },
      history: async () => ({ messages: [{ role: 'assistant', content: secret }], hasMore: false }), status: async () => ({ status: 'idle', detail: secret }), modelCatalog: async () => ({ groups: [], detail: secret }), selectModel: async () => ({ selected: true, detail: secret }),
    }),
  });
  t.after(() => host.close());
  await host.registry.install(native, { enabled: true, expectedRevision: 0 });
  await host.registry.setGrants(native.id, native.requestedCapabilities.map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: 1 });
  await host.registry.assignSlot('primary-agent', native.id, { expectedGeneration: 0 });
  return { host, secret, receipts, resolves: () => resolves, lateCrash() { onFailure({ epoch: 'epoch-0', code: 'runtime-unavailable' }); }, crash() { onFailure({ epoch: `epoch-${epoch++}`, code: 'runtime-unavailable' }); } };
}
test('native final and method results are sanitized before event/receipt publication', async t => {
  const f = await fixture(t), ref = await f.host.boundary.createSession({ addonId: native.id });
  const reader = f.host.boundary.events(ref); const turn = f.host.boundary.invoke(ref, { messages: [{ role: 'user', content: 'hello' }] });
  const event = (await reader.next()).value; assert.equal(event.type, 'final'); assert.equal(event.data.text, '[redacted]'); await turn.completion; await reader.return();
  assert.ok(!JSON.stringify(f.receipts).includes(f.secret), 'receipts must omit secret');
});
for (const [name, path, payload] of [
  ['history', '/agent/history', ref => ({ session: ref })],
  ['status', '/agent/status', ref => ({ session: ref })],
  ['selectModel', '/agent/select-model', ref => ({ session: ref, model: { provider: 'synthetic', model: 'synthetic' } })],
]) {
  test(`native ${name} result omits assembled secret`, async t => {
    const f = await fixture(t), ref = await f.host.boundary.createSession({ addonId: native.id });
    const result = await f.host.harnessRoutes.find(route => route.path === path).handler(payload(ref));
    assert.ok(!JSON.stringify(result).includes(f.secret), `${name} must redact assembled output`);
  });
}
test('native modelCatalog result omits assembled secret', async t => {
  const f = await fixture(t), ref = await f.host.boundary.createSession({ addonId: native.id });
  assert.ok(!JSON.stringify(await f.host.boundary.modelCatalog(ref)).includes(f.secret), 'modelCatalog must redact assembled output');
});
test('idle runtime crash clears only matching compatibility session', async t => {
  const f = await fixture(t), input = { messages: [{ role: 'user', content: 'hello' }] };
  const one = await f.host.executeBridgeChat(input); const projection = f.host.registry.snapshot();
  f.crash(); const two = await f.host.executeBridgeChat(input);
  assert.notEqual(one.harness.sessionId, two.harness.sessionId); assert.equal(f.resolves(), 2);
  assert.deepEqual(f.host.registry.snapshot(), projection);
  assert.equal(f.host.boundary.isLive(one.harness), false);
});
test('cold chat starts reply clock after session allocation', async t => {
  let release; const sessionGate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { sessionGate }), original = globalThis.setTimeout; let replyClocks = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => { if (ms === 30000) replyClocks++; return original(callback, ms, ...args); });
  const pending = f.host.executeBridgeChat({ messages: [{ role: 'user', content: 'cold synthetic' }] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(replyClocks, 0);
  release(); await pending; assert.equal(replyClocks, 1);
});
test('late old-epoch retirement cannot erase replacement compatibility cache', async t => {
  const f = await fixture(t), input = { messages: [{ role: 'user', content: 'synthetic' }] };
  await f.host.executeBridgeChat(input); f.crash(); const replacement = await f.host.executeBridgeChat(input);
  f.lateCrash(); const reused = await f.host.executeBridgeChat(input);
  assert.equal(reused.harness.sessionId, replacement.harness.sessionId); assert.equal(f.resolves(), 2);
});
test('retirement callback compares each of the four reference fields', async () => {
  const source = await readFile(new URL('../host/harness-host-service.mjs', import.meta.url), 'utf8');
  const signature = '    onRetired(ref) {', start = source.indexOf(signature);
  const end = source.indexOf('\n    },', start);
  assert.ok(start >= 0 && end > start);
  const retire = new Function('compatibilitySession', 'ref', source.slice(start + signature.length, end) + '\nreturn compatibilitySession;');
  const current = { addonId: 'addon.native', sessionId: 'session', bootEpoch: 'boot', generation: 2 };
  assert.equal(retire(current, { ...current }), undefined);
  for (const key of Object.keys(current)) {
    const stale = { ...current, [key]: key === 'generation' ? 1 : 'old-' + current[key] };
    assert.equal(retire(current, stale), current, `retirement must compare ${key}`);
  }
});
test('retirement between session return and cache assignment cannot retain a dead reference', async t => {
  const f = await fixture(t), input = { messages: [{ role: 'user', content: 'cache race' }] };
  const create = f.host.boundary.createSession.bind(f.host.boundary);
  let retireFirst = true;
  f.host.boundary.createSession = async args => {
    const ref = await create(args);
    if (retireFirst) { retireFirst = false; f.crash(); }
    return ref;
  };
  await assert.rejects(f.host.executeBridgeChat(input));
  const next = await f.host.executeBridgeChat(input); assert.ok(next.harness.sessionId); assert.equal(f.resolves(), 2);
});

test('timeout cancellation keeps the local four-field session reference after retirement', async t => {
  let release; const invokeGate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { invokeGate });
  const original = globalThis.setTimeout; let fireReplyTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 30000) { fireReplyTimeout = callback; return original(() => {}, ms, ...args); }
    return original(callback, ms, ...args);
  });
  const input = { messages: [{ role: 'user', content: 'held' }] };
  const pending = f.host.executeBridgeChat(input);
  while (!fireReplyTimeout) await new Promise(resolve => setImmediate(resolve));
  const first = [...f.receipts].reverse().find(receipt => receipt.kind === 'adapter-dispatch');
  assert.ok(first?.session, 'dispatch records original session reference');
  f.crash(); await assert.rejects(pending);
  const calls = [];
  t.mock.method(f.host.boundary, 'cancel', async (...args) => { calls.push(args); });
  fireReplyTimeout();
  assert.deepEqual(calls[0][0], first.session, 'timeout uses original four-field reference');
  assert.equal(calls[0][1], first.turnId, 'timeout uses original turn ID');
  release();
});
test('shared readiness through real custody survives first transport disposal', async t => {
  let releaseAuth, authStarted, firstTransport, created = 0, ready = 0, exchanges = 0, acquired = 0;
  const authentication = new Promise(resolve => { releaseAuth = resolve; });
  const started = new Promise(resolve => { authStarted = resolve; });
  const epoch = new AbortController();
  const f = await fixture(t, { sessionRejectDisposed: true,
    nativeRuntimeOverride: { close: async () => {}, async acquire() {
      acquired++;
      return { epoch: 'real-custody-epoch', signal: epoch.signal, deadline: Date.now() + 30000, version: '0.2.0-rc.2',
        use: callback => callback({ endpoint: native.agentRuntime.endpoint, loginToken: 'synthetic' }),
        ready() { ready++; }, fail() { epoch.abort(); }, release: async () => {}, isChildAlive: () => true };
    } },
    transportFactoryOverride: async options => {
      const real = await createHarnessTransport({ ...options, fetchImpl: async () => {
        exchanges++; authStarted(); await authentication;
        return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-test=synthetic-cookie' } });
      } });
      const transport = { ...real, isDisposed: false, async dispose() { transport.isDisposed = true; await real.dispose(); } };
      if (!options.credentialLease && !firstTransport) firstTransport = transport;
      created++; return transport;
    },
  });
  const first = f.host.boundary.createSession({ addonId: native.id }); first.catch(() => {});
  await started;
  const second = f.host.boundary.createSession({ addonId: native.id });
  for (let i = 0; acquired < 2 && i < 50; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(acquired, 2, 'both waiters own a custody lease');
  await new Promise(resolve => setImmediate(resolve));
  await firstTransport.dispose();
  releaseAuth();
  const secondRef = await second;
  assert.equal(f.host.boundary.isLive(secondRef), true);
  assert.equal(created, 3, 'two session transports share one readiness transport');
  assert.equal(exchanges, 1, 'real custody shares the authentication exchange');
  assert.equal(ready, 1, 'runtime marked Ready once');
  await assert.rejects(first, /runtime/i);
});
test('host close waits for the native stop after resource drain', async t => {
  let releaseStop;
  const stop = new Promise(resolve => { releaseStop = resolve; });
  const f = await fixture(t, { nativeClose: () => stop });
  await f.host.boundary.createSession({ addonId: native.id });
  let settled = false; const closing = f.host.close().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'close remains pending while native stop is pending');
  releaseStop(); await closing;
  assert.equal(settled, true, 'close settles after native stop');
});
