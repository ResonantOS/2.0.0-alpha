import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessBoundary } from '../host/harness-boundary.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function registry() {
  let listener, valid = true, permitted = true;
  const authorization = { slot: 'primary-agent', addonId: 'addon.native', bootEpoch: 'boot', generation: 1,
    runtime: { supportedOperations: ['createSession', 'invoke', 'cancel', 'history', 'status', 'modelCatalog', 'selectModel'] } };
  return {
    authorize: () => structuredClone(authorization), isCurrent: () => valid,
    assertOperation() { if (!valid || !permitted) throw Object.assign(new Error('denied'), { code: 'permission-denied' }); },
    onFence(fn) { listener = fn; return () => {}; },
    revoke() { valid = false; return listener({ slot: 'primary-agent' }); },
    denyWithoutFence() { permitted = false; },
  };
}

function adapter() {
  return { createSession: async () => ({}), dispose: async () => {}, async *invoke() { yield { type: 'final', data: { text: 'reply' } }; } };
}

test('pending authorization signal crosses resolution and fences before late acquisition', async () => {
  const r = registry(); let args, creates = 0;
  const release = deferred();
  const boundary = createHarnessBoundary({ registry: r, resolveAdapter: async (_authorization, options) => {
    args = options; await release.promise;
    return { ...adapter(), createSession: async () => { creates++; return {}; } };
  } });
  const result = boundary.createSession({ addonId: 'addon.native' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(args.signal?.aborted, false, 'resolution receives an un-aborted signal');
  const revoking = r.revoke();
  assert.equal(args.signal.aborted, true, 'resolution signal aborts at the fence');
  release.resolve();
  await assert.rejects(result, { code: 'ownership-conflict' });
  assert.equal(creates, 0, 'revoked resolution cannot dispatch createSession');
  await revoking; await boundary.close();
});

test('post-create checks reject a session whose authorization was revoked during creation', async () => {
  const r = registry(), entered = deferred(), release = deferred();
  const boundary = createHarnessBoundary({ registry: r, resolveAdapter: async () => ({ ...adapter(),
    createSession: async () => { entered.resolve(); await release.promise; return {}; },
  }) });
  const result = boundary.createSession({ addonId: 'addon.native' });
  await entered.promise;
  const revoking = r.revoke();
  release.resolve();
  await assert.rejects(result, { code: 'ownership-conflict' });
  await revoking; await boundary.close();
});

test('runtime retirement emits one error, invalidates reference and notifies synchronously', async () => {
  const retired = [], r = registry();
  const boundary = createHarnessBoundary({ registry: r, onRetired: ref => retired.push(ref),
    resolveAdapter: async (_authorization, { bindRuntime }) => { bindRuntime('epoch'); return adapter(); } });
  const ref = await boundary.createSession({ addonId: 'addon.native' }), reader = boundary.events(ref);
  assert.equal(boundary.isLive(ref), true);
  const stopping = boundary.retireRuntime('epoch');
  assert.deepEqual(retired, [ref], 'retirement callback fires before retireRuntime returns');
  assert.equal(boundary.isLive(ref), false);
  assert.equal((await reader.next()).value.data.code, 'runtime-unavailable');
  assert.equal((await reader.next()).done, true);
  assert.throws(() => boundary.invoke(ref, {}), { code: 'session-not-found' });
  await stopping; await boundary.retireRuntime('epoch');
  assert.equal(retired.length, 1);
  await boundary.close();
});

test('old epoch cannot retire a replacement', async () => {
  const r = registry(); let epoch = 'old';
  const boundary = createHarnessBoundary({ registry: r, resolveAdapter: async (_authorization, { bindRuntime }) => {
    bindRuntime(epoch); return adapter();
  } });
  const old = await boundary.createSession({ addonId: 'addon.native' });
  await boundary.retireRuntime('old');
  epoch = 'new';
  const next = await boundary.createSession({ addonId: 'addon.native' });
  await boundary.retireRuntime('old');
  assert.equal(boundary.isLive(next), true, 'stale epoch cannot retire replacement');
  assert.equal(boundary.isLive(old), false);
  await boundary.close();
});

test('an absent runtime epoch cannot retire an unbound session', async () => {
  const r = registry();
  const boundary = createHarnessBoundary({ registry: r, resolveAdapter: async () => adapter() });
  const ref = await boundary.createSession({ addonId: 'addon.native' });
  await boundary.retireRuntime(undefined);
  assert.equal(boundary.isLive(ref), true, 'undefined epoch cannot match an unbound session');
  await boundary.close();
});

test('isLive rechecks createSession permission even without a registry fence', async () => {
  const r = registry();
  const boundary = createHarnessBoundary({ registry: r, resolveAdapter: async () => adapter() });
  const ref = await boundary.createSession({ addonId: 'addon.native' });
  assert.equal(boundary.isLive(ref), true);
  r.denyWithoutFence();
  assert.equal(boundary.isLive(ref), false, 'degraded createSession permission denies liveness');
  await boundary.close();
});

test('runtime retirement suppresses late invoke output', async () => {
  const r = registry(), entered = deferred(), release = deferred();
  const boundary = createHarnessBoundary({ registry: r, resolveAdapter: async (_authorization, { bindRuntime }) => {
    bindRuntime('epoch'); return { ...adapter(), async *invoke() {
      entered.resolve(); await release.promise; yield { type: 'final', data: { text: 'late' } };
    } };
  } });
  const ref = await boundary.createSession({ addonId: 'addon.native' }), reader = boundary.events(ref);
  const turn = boundary.invoke(ref, {});
  await entered.promise;
  const stopping = boundary.retireRuntime('epoch');
  release.resolve();
  await turn.completion;
  assert.equal((await reader.next()).value.data.code, 'runtime-unavailable');
  assert.equal((await reader.next()).done, true);
  await stopping; await boundary.close();
});
