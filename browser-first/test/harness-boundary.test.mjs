import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHarnessRegistry } from '../host/harness-registry.mjs';
import { createHarnessBoundary } from '../host/harness-boundary.mjs';
const base = JSON.parse(await readFile(new URL('../../public/addons/hermes.json', import.meta.url)));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(adapterOverrides = {}, limits = {}) {
  const manifest = structuredClone(base);
  manifest.id = 'addon.one';
  manifest.requestedCapabilities.push(...['agent-runtime', 'agent-delegation', 'chat-interface'].map(capability => ({ capability, granted: true, scope: 'system', revocationBehavior: 'hard-stop' })));
  manifest.systemSlots = ['primary-agent', 'chat-interface'].map(id => ({ id, role: 'alternative-provider', replaceable: true }));
  Object.assign(manifest.agentRuntime, { adapterVersion: 1, adapterId: 'test-adapter', authScheme: 'none', supportedOperations: ['createSession', 'invoke', 'cancel', 'history', 'status', 'modelCatalog', 'selectModel'], contextRoleFidelity: 'text-only', toolCallbacks: false, requiredCapabilities: ['agent-runtime', 'chat-interface'] });
  let document = null;
  const store = { read: async () => structuredClone(document), write: async value => { document = structuredClone(value); } };
  const registry = await createHarnessRegistry({ store, reviewedAdapterIds: ['test-adapter'] });
  await registry.install(manifest, { enabled: true });
  await registry.setGrants(manifest.id, manifest.requestedCapabilities.map(grant => ({ ...grant, granted: true })), { consent: true, expectedRevision: 1 });
  await registry.assignSlot('primary-agent', manifest.id, { expectedGeneration: 0 });
  const calls = [];
  const adapter = {
    createSession: async () => { calls.push('create'); return { id: 'upstream-private' }; },
    invoke: async function* () { calls.push('invoke'); yield { type: 'delta', data: { text: 'hello' } }; yield { type: 'final', data: { text: 'hello' } }; },
    history: async () => { calls.push('history'); return []; },
    status: async () => { calls.push('status'); return { status: 'idle' }; },
    cancel: async () => { calls.push('cancel'); },
    dispose: async () => { calls.push('dispose'); },
    ...adapterOverrides,
  };
  const boundary = createHarnessBoundary({ registry, resolveAdapter: async () => adapter, ...limits });
  const revoke = () => registry.setGrants(manifest.id, [{ ...manifest.requestedCapabilities.find(grant => grant.capability === 'agent-runtime'), granted: false }], { consent: true, expectedRevision: registry.snapshot().revision });
  return { registry, boundary, calls, revoke, store };
}

test('revocation fences delayed creation and queued output', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ createSession: async ({ signal }) => { entered.resolve(signal); await release.promise; return { id: 'late-upstream' }; } });
  const creating = f.boundary.createSession({ addonId: 'addon.one' });
  const rejected = assert.rejects(creating, { code: 'ownership-conflict' });
  const signal = await entered.promise;
  await f.revoke();
  assert.equal(signal.aborted, true);
  release.resolve();
  await rejected;
  assert.ok(f.calls.includes('dispose'), 'late created session must be disposed');

  const outputEntered = deferred(), outputRelease = deferred();
  const g = await fixture({ invoke: async function* () { outputEntered.resolve(); await outputRelease.promise; yield { type: 'delta', data: { text: 'late' } }; } });
  const session = await g.boundary.createSession({ addonId: 'addon.one' });
  const reader = g.boundary.events(session);
  const turn = g.boundary.invoke(session, { text: 'prompt' });
  await outputEntered.promise;
  await g.revoke();
  outputRelease.resolve();
  await turn.completion;
  const terminal = (await reader.next()).value;
  assert.equal(terminal.type, 'error');
  assert.equal((await reader.next()).done, true);
  assert.ok(g.calls.includes('dispose'));
});

test('foreign sessions and old boot epochs cannot execute', async () => {
  const f = await fixture();
  const session = await f.boundary.createSession({ addonId: 'addon.one' });
  for (const patch of [{ sessionId: 'upstream-private' }, { addonId: 'addon.foreign' }, { bootEpoch: 'old-boot' }, { generation: 0 }]) {
    const ref = { ...session, ...patch };
    assert.throws(() => f.boundary.invoke(ref, { text: 'no' }), { code: 'session-not-found' });
    assert.throws(() => f.boundary.events(ref), { code: 'session-not-found' });
    await assert.rejects(f.boundary.history(ref), { code: 'session-not-found' });
    await assert.rejects(f.boundary.cancel(ref, 'foreign-turn'), { code: 'session-not-found' });
  }
  assert.deepEqual(f.calls, ['create'], 'denials must happen before upstream calls');
  const reader = f.boundary.events(session), turn = f.boundary.invoke(session, { text: 'yes' });
  await turn.completion;
  assert.equal((await reader.next()).value.data.text, 'hello');
  assert.equal((await reader.next()).value.type, 'final');
  assert.deepEqual(await f.boundary.history(session), []);
  await f.boundary.close();
});

test('every reassignment rejects old sessions and late output from the same addon', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ invoke: async function* () { entered.resolve(); await release.promise; yield { type: 'final', data: { text: 'stale' } }; } });
  const session = await f.boundary.createSession({ addonId: 'addon.one' });
  const reader = f.boundary.events(session), turn = f.boundary.invoke(session, {});
  await entered.promise;
  await f.registry.assignSlot('primary-agent', 'addon.one', { expectedGeneration: 1, replace: true });
  release.resolve(); await turn.completion;
  assert.equal((await reader.next()).value.type, 'error');
  assert.throws(() => f.boundary.events(session), { code: 'session-not-found' });
  const fresh = await f.boundary.createSession({ addonId: 'addon.one' });
  assert.equal(fresh.generation, 2);
  await f.boundary.close();
});

test('session references reject every unknown own key before upstream calls', async t => {
  const f = await fixture();
  t.after(() => f.boundary.close());
  const session = await f.boundary.createSession({ addonId: 'addon.one' });
  for (const key of ['extra', Symbol('extra')]) {
    for (const enumerable of [true, false]) {
      const ref = Object.defineProperty({ ...session }, key, { value: true, enumerable });
      assert.throws(() => f.boundary.invoke(ref, {}), { code: 'session-not-found' });
      assert.throws(() => f.boundary.events(ref), { code: 'session-not-found' });
      for (const operation of ['history', 'status', 'modelCatalog', 'selectModel', 'cancel']) {
        await assert.rejects(f.boundary[operation](ref), { code: 'session-not-found' });
      }
    }
  }
  assert.deepEqual(f.calls, ['create'], 'extra keys must be denied before upstream calls');
  assert.deepEqual(await f.boundary.history(session), [], 'exact references remain accepted');
});

test('pending creation and active turns are bounded and cancellation suppresses late output', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ invoke: async function* ({ signal }) { entered.resolve(signal); await release.promise; yield { type: 'delta', data: { text: 'after cancel' } }; } }, { maxSessions: 1 });
  const session = await f.boundary.createSession({ addonId: 'addon.one' });
  await assert.rejects(f.boundary.createSession({ addonId: 'addon.one' }), { code: 'runtime-unavailable' });
  const reader = f.boundary.events(session), turn = f.boundary.invoke(session, {});
  const signal = await entered.promise;
  assert.throws(() => f.boundary.invoke(session, {}), { code: 'ownership-conflict' });
  await assert.rejects(f.boundary.cancel(session, 'foreign-turn'), { code: 'session-not-found' });
  await f.boundary.cancel(session, turn.turnId);
  assert.equal(signal.aborted, true);
  release.resolve(); await turn.completion;
  assert.equal((await reader.next()).value.type, 'cancelled');
  await f.boundary.close();
});

test('awaited history cannot return after revocation', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ history: async () => { entered.resolve(); await release.promise; return ['stale']; } });
  const session = await f.boundary.createSession({ addonId: 'addon.one' });
  const history = f.boundary.history(session);
  const rejected = assert.rejects(history, { code: 'ownership-conflict' });
  await entered.promise; await f.revoke(); release.resolve(); await rejected;
});

test('revocation disposes an adapter whose bootstrap resolves after the fence', async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  let disposed = 0, created = 0;
  const boundary = createHarnessBoundary({ registry: f.registry, resolveAdapter: async () => {
    entered.resolve(); await release.promise;
    return { createSession: async () => { created++; return {}; }, dispose: async () => { disposed++; } };
  } });
  const creation = boundary.createSession({ addonId: 'addon.one' });
  const rejected = assert.rejects(creation, { code: 'ownership-conflict' });
  await entered.promise; await f.revoke(); release.resolve(); await rejected;
  assert.equal(created, 0);
  assert.equal(disposed, 1, 'a late adapter bootstrap must be disposed even before a session exists');
  await boundary.close();
});

test('pending creation consumes capacity and awaited status is fenced', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ createSession: async () => { entered.resolve(); await release.promise; return {}; } }, { maxSessions: 1 });
  const creating = f.boundary.createSession({ addonId: 'addon.one' });
  await entered.promise;
  await assert.rejects(f.boundary.createSession({ addonId: 'addon.one' }), { code: 'runtime-unavailable' });
  release.resolve(); const session = await creating;
  assert.deepEqual(await f.boundary.status(session), { status: 'idle' });
  await f.boundary.close();
});

test('owning a presentation slot cannot bypass primary runtime consent', async () => {
  const f = await fixture();
  await f.registry.assignSlot('chat-interface', 'addon.one', { expectedGeneration: 0 });
  await f.revoke();
  assert.equal(f.registry.snapshot().slots['chat-interface'].available, true, 'presentation consent remains a positive control');
  await assert.rejects(f.boundary.createSession({ addonId: 'addon.one', slot: 'chat-interface' }), { code: 'permission-denied' });
  assert.deepEqual(f.calls, []);
});


for (const cleanup of ['throw', 'timeout']) {
  for (const fence of ['revoke', 'reassign', 'disable']) {
    test(`${fence} commits and reloads even when adapter disposal ${cleanup}s`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const entered = deferred(), never = deferred();
      const f = await fixture({ dispose: () => {
        entered.resolve();
        if (cleanup === 'throw') throw new Error('adapter cleanup failed');
        return never.promise;
      } }, { cleanupTimeoutMs: 10 });
      t.after(() => f.boundary.close());
      const session = await f.boundary.createSession({ addonId: 'addon.one' });
      const reader = f.boundary.events(session);
      const mutation = fence === 'revoke' ? f.revoke()
        : fence === 'reassign' ? f.registry.assignSlot('primary-agent', 'addon.one', { expectedGeneration: 1, replace: true })
        : f.registry.setEnabled('addon.one', false, { expectedRevision: f.registry.snapshot().revision });
      const committed = assert.doesNotReject(mutation, 'adapter cleanup must not prevent durable governance commit');
      await entered.promise;
      assert.throws(() => f.boundary.events(session), { code: 'session-not-found' });
      assert.equal((await reader.next()).value.data.code, 'ownership-conflict');
      t.mock.timers.tick(10);
      await committed;
      assert.equal((await f.store.read()).phase, 'committed');
      const restored = await createHarnessRegistry({ store: f.store, reviewedAdapterIds: ['test-adapter'] });
      assert.deepEqual(restored.snapshot().slots, f.registry.snapshot().slots);
      // A new transaction must remain usable both in-process and after restart.
      for (const registry of [f.registry, restored]) {
        await registry.setEnabled('addon.one', true, { expectedRevision: registry.snapshot().revision });
      }
    });
  }
}

const settledOrPending = promise => Promise.race([
  promise.then(value => ({ value }), error => ({ code: error.code })),
  new Promise(resolve => setImmediate(() => resolve('pending'))),
]);
for (const operation of ['history', 'status', 'modelCatalog', 'selectModel']) {
  test(`${operation} rechecks ownership after await without an abort notification`, async t => {
    const f = await fixture();
    t.after(() => f.boundary.close());
    const entered = deferred(), release = deferred();
    // Suppress this boundary's fence notification to isolate the post-await
    // registry check from bounded()'s abort race. Ownership still changes in
    // the real registry, and the adapter resolves normally afterward.
    const boundary = createHarnessBoundary({
      registry: { ...f.registry, onFence: () => () => {} },
      resolveAdapter: async () => ({
        createSession: async () => ({}),
        dispose: async () => {},
        [operation]: async ({ signal }) => {
          entered.resolve(signal); await release.promise; return 'stale result';
        },
      }),
    });
    t.after(() => boundary.close());
    const session = await boundary.createSession({ addonId: 'addon.one' });
    const request = boundary[operation](session, { model: 'test' });
    const rejected = assert.rejects(request, { code: 'ownership-conflict' }, 'stale result must fail the post-await ownership check');
    const signal = await entered.promise;
    await f.registry.assignSlot('primary-agent', 'addon.one', { expectedGeneration: 1, replace: true });
    assert.equal(f.registry.snapshot().slots['primary-agent'].generation, session.generation + 1);
    assert.equal(signal.aborted, false, 'abort race must not satisfy the ownership assertion');
    release.resolve();
    await rejected;
    assert.equal(signal.aborted, false);
  });

  test(`${operation} settles on revocation even if the adapter ignores abort`, async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ [operation]: async ({ signal }) => {
      entered.resolve(signal); await release.promise; return 'late result';
    } });
    t.after(() => f.boundary.close());
    const session = await f.boundary.createSession({ addonId: 'addon.one' });
    const request = f.boundary[operation](session, { model: 'test' });
    const outcome = settledOrPending(request);
    const signal = await entered.promise;
    await f.revoke();
    assert.equal(signal.aborted, true);
    assert.deepEqual(await outcome, { code: 'ownership-conflict' }, 'revoked operation must settle without adapter cooperation');
    release.resolve();
  });

  test(`${operation} has a deadline and preserves successful results`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entered = deferred(), release = deferred();
    let calls = 0;
    const f = await fixture({ [operation]: async ({ signal }) => {
      if (++calls === 1) { entered.resolve(signal); await release.promise; }
      return { result: 'authorized' };
    } }, { operationTimeoutMs: 10 });
    t.after(() => f.boundary.close());
    const session = await f.boundary.createSession({ addonId: 'addon.one' });
    const request = f.boundary[operation](session, { model: 'test' });
    const outcome = settledOrPending(request);
    const signal = await entered.promise;
    t.mock.timers.tick(10);
    assert.deepEqual(await outcome, { code: 'deadline-exceeded' }, 'unresponsive operation must reach its deadline');
    assert.equal(signal.aborted, true, 'deadline aborts the upstream request');
    release.resolve();
    assert.deepEqual(await f.boundary[operation](session, { model: 'test' }), { result: 'authorized' });
  });
}
