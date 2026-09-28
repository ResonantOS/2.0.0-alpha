import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHarnessRegistry } from '../host/harness-registry.mjs';
import { createHarnessBoundary } from '../host/harness-boundary.mjs';
const base = JSON.parse(await readFile(new URL('../../public/addons/hermes.json', import.meta.url)));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(adapterOverrides = {}, limits = {}, configure = () => {}) {
  const manifest = structuredClone(base);
  manifest.id = 'addon.one';
  manifest.requestedCapabilities.push(...['agent-runtime', 'agent-delegation', 'chat-interface'].map(capability => ({ capability, granted: true, scope: 'system', revocationBehavior: 'hard-stop' })));
  manifest.systemSlots = ['primary-agent', 'chat-interface'].map(id => ({ id, role: 'alternative-provider', replaceable: true }));
  Object.assign(manifest.agentRuntime, { adapterVersion: 1, adapterId: 'test-adapter', authScheme: 'none', supportedOperations: ['createSession', 'invoke', 'cancel', 'history', 'status', 'modelCatalog', 'selectModel'], contextRoleFidelity: 'text-only', toolCallbacks: false, requiredCapabilities: ['agent-runtime', 'chat-interface'] });
  configure(manifest);
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
test('history rechecks degraded permission after await without a generation change or fence', async t => {
  const f = await fixture();
  t.after(() => f.boundary.close());
  const entered = deferred(), release = deferred();
  let degraded = false, fences = 0;
  const authorization = f.registry.authorize('primary-agent', 'addon.one');
  t.after(f.registry.onFence(() => { fences++; }));
  const boundary = createHarnessBoundary({
    registry: { ...f.registry, assertOperation: (authorization, operation) => {
      f.registry.assertOperation(authorization, operation);
      if (degraded && operation === 'history') throw Object.assign(new Error('Permission denied.'), { code: 'permission-denied' });
    } },
    resolveAdapter: async () => ({
      createSession: async () => ({}),
      dispose: async () => {},
      history: async ({ signal }) => {
        entered.resolve(signal); await release.promise; return ['withdrawn result'];
      },
    }),
  });
  t.after(() => boundary.close());
  const session = await boundary.createSession({ addonId: 'addon.one' });
  const surfaced = [];
  const request = boundary.history(session).then(result => { surfaced.push(result); return result; });
  const rejected = assert.rejects(request, { code: 'permission-denied' });
  const signal = await entered.promise;
  degraded = true;
  assert.equal(f.registry.isCurrent(authorization), true);
  assert.equal(f.registry.snapshot().slots['primary-agent'].generation, session.generation);
  assert.equal(fences, 0);
  assert.equal(signal.aborted, false, 'only the post-await policy check can reject the result');
  release.resolve();
  await rejected;
  assert.deepEqual(surfaced, [], 'withdrawn adapter output must not reach the caller');
  assert.equal(signal.aborted, false);
});

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

for (const behavior of ['hard-stop', 'degrade', 'hide-surface']) {
  test(`revocation effects never preserve withdrawn authority at boundary: ${behavior}`, async t => {
    const entered = deferred(), release = deferred(), historyEntered = deferred(), historyRelease = deferred();
    const f = await fixture({
      invoke: async function* ({ signal }) { entered.resolve(signal); await release.promise; yield { type: 'final', data: { text: 'withdrawn' } }; },
      history: async ({ signal }) => { historyEntered.resolve(signal); await historyRelease.promise; return ['unrelated']; },
    }, {}, manifest => {
      manifest.requestedCapabilities.find(g => g.capability === 'providers').revocationBehavior = behavior;
      manifest.tools.find(tool => tool.name === manifest.agentRuntime.invocationTool).requiredCapabilities = ['providers'];
      manifest.surfaces[0].shellNavigation = { sectionId: 'hermes', dockIcon: 'bot', eyebrow: 'Test', requiredCapabilities: ['providers'] };
    });
    t.after(() => f.boundary.close());
    const session = await f.boundary.createSession({ addonId: 'addon.one' }), reader = f.boundary.events(session);
    const turn = f.boundary.invoke(session, {}), signal = await entered.promise;
    const history = f.boundary.history(session);
    const outcome = history.then(value => ({ value }), error => ({ code: error.code }));
    const historySignal = await historyEntered.promise;
    const before = f.registry.snapshot();
    const grant = before.installations['addon.one'].grantedCapabilities.find(g => g.capability === 'providers');
    await f.registry.setGrants('addon.one', [{ ...grant, granted: false }], { consent: true, expectedRevision: before.revision });
    assert.equal(signal.aborted, true, 'dependent running work must be cancelled');
    assert.equal(historySignal.aborted, behavior === 'hard-stop', 'unrelated running work survives degrade/hide');
    assert.ok(f.registry.snapshot().installations['addon.one'].disabledOperations.includes('invoke'), 'dependent operation must be projected disabled');
    assert.deepEqual(f.registry.snapshot().installations['addon.one'].hiddenSurfaceIds, behavior === 'hide-surface' ? ['hermes-panel'] : []);
    release.resolve(); historyRelease.resolve(); await turn.completion;
    if (behavior === 'hard-stop') {
      assert.deepEqual(await outcome, { code: 'ownership-conflict' });
      assert.equal((await reader.next()).value.type, 'error');
      assert.equal((await reader.next()).done, true);
      assert.ok(f.calls.includes('dispose'));
    } else {
      assert.deepEqual(await outcome, { value: ['unrelated'] });
      assert.equal(f.registry.snapshot().slots['primary-agent'].generation, session.generation);
      assert.equal((await reader.next()).value.type, 'cancelled', 'late dependent output must not arrive');
      assert.throws(() => f.boundary.invoke(session, {}), { code: 'permission-denied' });
      assert.deepEqual(await f.boundary.status(session), { status: 'idle' });
      assert.ok(!f.calls.includes('dispose'));
    }
    await reader.return();
  });
  test(`essential runtime revocation hard-stops even under ${behavior}`, async t => {
    const f = await fixture({}, {}, manifest => {
      manifest.systemSlots[0].replaceable = false;
      manifest.requestedCapabilities.find(g => g.capability === 'agent-runtime').revocationBehavior = behavior;
      manifest.surfaces[0].shellNavigation = { sectionId: 'hermes', dockIcon: 'bot', eyebrow: 'Test', requiredCapabilities: ['agent-runtime'] };
    });
    t.after(() => f.boundary.close());
    const session = await f.boundary.createSession({ addonId: 'addon.one' }), reader = f.boundary.events(session);
    await f.revoke();
    assert.equal((await reader.next()).value.type, 'error');
    assert.equal((await reader.next()).done, true);
    assert.throws(() => f.boundary.invoke(session, {}), { code: 'session-not-found' });
    assert.ok(f.calls.includes('dispose'));
  });
}

test('client session disposal is idempotent but refuses superseded generations and foreign references', async t => {
  const f = await fixture(); t.after(() => f.boundary.close());
  assert.equal(typeof f.boundary.dispose, 'function', 'boundary must expose client disposal');
  const session = await f.boundary.createSession({ addonId: 'addon.one' }), reader = f.boundary.events(session);
  for (const patch of [{ addonId: 'addon.foreign' }, { generation: 0 }, { extra: true }]) {
    await assert.rejects(f.boundary.dispose({ ...session, ...patch }), { code: 'session-not-found' });
  }
  await f.boundary.dispose(session); await f.boundary.dispose(session);
  assert.equal(f.calls.filter(call => call === 'dispose').length, 1);
  assert.equal((await reader.next()).value.type, 'error');
  assert.equal((await reader.next()).done, true);
  assert.throws(() => f.boundary.invoke(session, {}), { code: 'session-not-found' });
  await f.registry.assignSlot('primary-agent', 'addon.one', { expectedGeneration: 1, replace: true });
  await assert.rejects(f.boundary.dispose(session), { code: 'session-not-found' });
});

for (const operation of ['modelCatalog', 'selectModel']) {
  test(`degrade cancels dependent ${operation} while keeping unrelated session work`, async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ [operation]: async ({ signal }) => { entered.resolve(signal); await release.promise; return 'withdrawn result'; } }, {}, manifest => {
      manifest.agentRuntime.modelSelection.requiredCapabilities = ['providers'];
    });
    t.after(() => f.boundary.close());
    const session = await f.boundary.createSession({ addonId: 'addon.one' });
    const work = f.boundary[operation](session, { model: 'test' });
    const rejected = assert.rejects(work, { code: 'permission-denied' });
    const signal = await entered.promise;
    const grant = f.registry.snapshot().installations['addon.one'].grantedCapabilities.find(g => g.capability === 'providers');
    await f.registry.setGrants('addon.one', [{ ...grant, granted: false }], { consent: true, expectedRevision: f.registry.snapshot().revision });
    assert.equal(signal.aborted, true);
    await rejected; // Adapter ignoring abort cannot postpone withdrawal.
    await assert.rejects(f.boundary[operation](session, {}), { code: 'permission-denied' });
    assert.deepEqual(await f.boundary.status(session), { status: 'idle' });
    await f.registry.setGrants('addon.one', [{ ...grant, granted: true }], { consent: true, expectedRevision: f.registry.snapshot().revision });
    release.resolve();
    assert.equal(await f.boundary[operation](session, {}), 'withdrawn result', 'new explicitly authorized operations may proceed');
  });
}

test('degrade attempts upstream cancellation even if abort immediately unwinds the turn', async t => {
  const entered = deferred();
  const f = await fixture({ invoke: async function* ({ signal }) {
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } }, {}, manifest => {
    manifest.tools.find(tool => tool.name === manifest.agentRuntime.invocationTool).requiredCapabilities = ['providers'];
  });
  t.after(() => f.boundary.close());
  const session = await f.boundary.createSession({ addonId: 'addon.one' });
  const turn = f.boundary.invoke(session, {}); await entered.promise;
  const grant = f.registry.snapshot().installations['addon.one'].grantedCapabilities.find(g => g.capability === 'providers');
  await f.registry.setGrants('addon.one', [{ ...grant, granted: false }], { consent: true, expectedRevision: f.registry.snapshot().revision });
  await turn.completion;
  assert.ok(f.calls.includes('cancel'), 'upstream cancellation must use the captured turn');
});

test('a runtime-wide degraded dependency cannot leave a session that revives on regrant', async t => {
  const f = await fixture({}, {}, manifest => {
    manifest.agentRuntime.requiredCapabilities.push('providers');
  });
  t.after(() => f.boundary.close());
  const session = await f.boundary.createSession({ addonId: 'addon.one' });
  const grant = f.registry.snapshot().installations['addon.one'].grantedCapabilities.find(g => g.capability === 'providers');
  await f.registry.setGrants('addon.one', [{ ...grant, granted: false }], { consent: true, expectedRevision: f.registry.snapshot().revision });
  assert.ok(f.calls.includes('dispose'), 'loss of every session operation retires the unusable session');
  await f.registry.setGrants('addon.one', [{ ...grant, granted: true }], { consent: true, expectedRevision: f.registry.snapshot().revision });
  assert.throws(() => f.boundary.invoke(session, {}), { code: 'session-not-found' });
  const fresh = await f.boundary.createSession({ addonId: 'addon.one' });
  assert.deepEqual(await f.boundary.status(fresh), { status: 'idle' });
});

test('disposal stays idempotent after repeated session churn without retaining session capacity', async t => {
  const f = await fixture({}, { maxSessions: 1 });
  t.after(() => f.boundary.close());
  const first = await f.boundary.createSession({ addonId: 'addon.one' });
  await f.boundary.dispose(first);
  const second = await f.boundary.createSession({ addonId: 'addon.one' });
  await f.boundary.dispose(second);
  await assert.doesNotReject(f.boundary.dispose(first), 'idempotence must survive subsequent session disposal');
  await assert.rejects(f.boundary.dispose({ ...first, sessionId: 'unknown' }), { code: 'session-not-found' });
  assert.equal(f.calls.filter(call => call === 'dispose').length, 2);
});
