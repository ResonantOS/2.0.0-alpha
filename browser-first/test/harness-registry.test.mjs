import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessRegistry } from '../host/harness-registry.mjs';
import { createHarnessRegistryStore } from '../host/harness-registry-store.mjs';

const base = JSON.parse(await readFile(new URL('../../public/addons/hermes.json', import.meta.url)));
function manifest(id = 'addon.one') {
  const value = structuredClone(base);
  value.id = id;
  value.requestedCapabilities.push(...['agent-runtime', 'agent-delegation', 'chat-interface', 'memory-provider'].map(capability => ({ capability, granted: true, scope: 'system', revocationBehavior: 'hard-stop' })));
  value.systemSlots = ['primary-agent', 'chat-interface', 'memory-system', 'communication-channel'].map(slot => ({ id: slot, role: 'alternative-provider', replaceable: true, recommended: false }));
  Object.assign(value.agentRuntime, { adapterVersion: 1, adapterId: 'test-adapter', authScheme: 'none', supportedOperations: ['createSession', 'invoke', 'cancel', 'history', 'status', 'selectModel'], contextRoleFidelity: 'text-only', toolCallbacks: false, requiredCapabilities: ['agent-runtime', 'chat-interface'] });
  return value;
}
function memoryStore() {
  let document = null;
  return { read: async () => structuredClone(document), write: async value => { document = structuredClone(value); } };
}
const open = store => createHarnessRegistry({ store, reviewedAdapterIds: ['test-adapter'] });
async function installGranted(registry, value = manifest()) {
  await registry.install(value, { enabled: true });
  await registry.setGrants(value.id, value.requestedCapabilities.map(grant => ({ ...grant, granted: true })), { consent: true, expectedRevision: registry.snapshot().revision });
}
const assign = (registry, id = 'addon.one', expectedGeneration = 0, slot = 'primary-agent') => registry.assignSlot(slot, id, { expectedGeneration, replace: true });

test('installation clears authored consent', async () => {
  const registry = await open(memoryStore());
  await registry.install(manifest(), { enabled: true });
  assert.ok(registry.snapshot().installations['addon.one'].grantedCapabilities.every(grant => !grant.granted), 'authored consent must never install as granted');
  await assert.rejects(assign(registry), { code: 'permission-denied' });
  assert.throws(() => registry.authorize('primary-agent', 'addon.one'), { code: 'permission-denied' });
  await assert.rejects(registry.setGrants('addon.one', manifest().requestedCapabilities, { consent: false, expectedRevision: 1 }), { code: 'permission-denied' });
  await assert.rejects(registry.setGrants('addon.one', [{ capability: 'agent-runtime', granted: true, scope: 'shared', revocationBehavior: 'hard-stop' }], { consent: true, expectedRevision: 1 }), { code: 'permission-denied' });
});

for (const runtimeRequested of [false, true]) {
  test(`delegation consent does not migrate to runtime consent (runtime requested: ${runtimeRequested})`, async () => {
    const store = memoryStore(), value = manifest();
    if (!runtimeRequested) value.requestedCapabilities = value.requestedCapabilities.filter(grant => grant.capability !== 'agent-runtime');
    const grants = value.requestedCapabilities.filter(grant => grant.capability !== 'agent-runtime');
    await store.write({ version: 1, phase: 'committed', state: {
      revision: 7, governanceActivated: true,
      installations: { [value.id]: { manifest: value, enabled: true, grants } },
      slots: { 'primary-agent': { addonId: value.id, generation: 3 } },
    } });
    const registry = await open(store);
    const pending = registry.snapshot().installations[value.id]?.grantedCapabilities.find(grant => grant.capability === 'agent-runtime');
    assert.deepEqual(pending, { capability: 'agent-runtime', granted: false, scope: 'system', revocationBehavior: 'hard-stop' },
      'legacy delegation consent must expose a pending runtime request');
    assert.equal(registry.snapshot().installations[value.id].grantedCapabilities.find(grant => grant.capability === 'agent-delegation').granted, true);
    assert.equal(registry.snapshot().slots['primary-agent'].available, false);
    assert.throws(() => registry.authorize('primary-agent', value.id), { code: 'permission-denied' });
    await assert.rejects(assign(registry, value.id, 3), { code: 'permission-denied' });
    await assert.rejects(registry.setGrants(value.id, [{ ...pending, granted: true }], { consent: false, expectedRevision: 7 }), { code: 'permission-denied' });
    await registry.setGrants(value.id, [{ ...pending, granted: true }], { consent: true, expectedRevision: 7 });
    assert.equal(registry.authorize('primary-agent', value.id).addonId, value.id);
    const restored = await open(store);
    assert.equal(restored.authorize('primary-agent', value.id).addonId, value.id, 'explicit runtime consent survives restart');
  });
}

test('replacement persists one compare-and-swap winner', async () => {
  const store = memoryStore(), registry = await open(store);
  for (const id of ['addon.one', 'addon.two', 'addon.three']) await installGranted(registry, manifest(id));
  await assign(registry);
  const results = await Promise.allSettled([assign(registry, 'addon.two', 1), assign(registry, 'addon.three', 1)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'exactly one replacement wins');
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ownership-conflict');
  const before = registry.snapshot(), restored = await open(store);
  assert.deepEqual(restored.snapshot().slots, before.slots);
  assert.equal(restored.snapshot().governanceActivated, true);
  assert.notEqual(restored.snapshot().bootEpoch, before.bootEpoch);
  await assign(registry, before.slots['primary-agent'].addonId, 2);
  assert.equal(registry.snapshot().slots['primary-agent'].generation, 3, 'even same-owner assignment advances generation');
});

test('failed persistence is never acknowledged and incomplete journal fails closed', async () => {
  for (const failAt of [1, 2]) {
    const store = memoryStore(), registry = await open(store);
    await installGranted(registry);
    await assign(registry);
    const durableWrite = store.write;
    let writes = 0;
    store.write = async value => { if (++writes === failAt) throw new Error('disk unavailable'); await durableWrite(value); };
    await assert.rejects(assign(registry, 'addon.one', 1), { code: 'runtime-unavailable' });
    assert.equal(registry.snapshot().slots['primary-agent'].available, false, 'failed write latches execution off');
    assert.throws(() => registry.authorize('primary-agent', 'addon.one'), { code: 'runtime-unavailable' });
    if (failAt === 2) {
      const restored = await open(store);
      assert.equal(restored.snapshot().slots['primary-agent'].available, false);
      assert.throws(() => restored.authorize('primary-agent', 'addon.one'), { code: 'runtime-unavailable' });
    }
  }
});

test('every current slot owner blocks uninstall', async () => {
  const registry = await open(memoryStore());
  for (const [index, slot] of ['primary-agent', 'chat-interface', 'memory-system', 'communication-channel'].entries()) {
    const value = manifest(`addon.owner-${index}`);
    await installGranted(registry, value);
    await assign(registry, value.id, 0, slot);
    await assert.rejects(registry.remove(value.id), { code: 'ownership-conflict' });
    await registry.assignSlot(slot, null, { expectedGeneration: 1, replace: true });
    await registry.remove(value.id);
    assert.equal(registry.snapshot().installations[value.id], undefined);
  }
  assert.equal(registry.snapshot().governanceActivated, true, 'vacancy retains governance');
});

test('binding authorization checks identity, adapter and exact endpoint without reading secrets', async () => {
  const store = memoryStore();
  const value = manifest();
  Object.assign(value.agentRuntime, { authScheme: 'bearer', credentialBinding: 'test.main', endpoint: 'http://127.0.0.1:3080' });
  const registry = await createHarnessRegistry({ store, reviewedAdapterIds: ['test-adapter'], bindings: [{ name: 'test.main', addonId: value.id, adapterId: 'test-adapter', endpoint: 'http://127.0.0.1:3080', authScheme: 'bearer' }] });
  await installGranted(registry, value);
  await assign(registry);
  assert.equal(registry.authorize('primary-agent', value.id).addonId, value.id);
  for (const patch of [{ id: 'addon.foreign' }, { endpoint: 'http://127.0.0.1:3081' }, { adapterId: 'unreviewed' }]) {
    const other = structuredClone(value);
    if (patch.id) other.id = patch.id; else Object.assign(other.agentRuntime, patch);
    await assert.rejects(registry.install(other, { enabled: true }), { code: 'permission-denied' });
  }
});

test('durable store atomically replaces private files and reloads governance', async t => {
  const userRoot = await mkdtemp(join(tmpdir(), 'harness-registry-'));
  t.after(() => rm(userRoot, { recursive: true, force: true }));
  const store = createHarnessRegistryStore({ userRoot });
  const registry = await open(store);
  await installGranted(registry);
  await assign(registry);
  const restored = await open(createHarnessRegistryStore({ userRoot }));
  assert.equal(restored.snapshot().slots['primary-agent'].addonId, 'addon.one');
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  const document = await store.read();
  await store.write({ ...document, phase: 'pending' });
  assert.throws(() => (restored.authorize('primary-agent', 'addon.foreign')), { code: 'permission-denied' });
  assert.equal((await open(store)).snapshot().slots['primary-agent'].available, false);
});

test('stale consent revisions and undeclared slots cannot mutate authority', async () => {
  const registry = await open(memoryStore()), value = manifest();
  value.systemSlots = value.systemSlots.filter(item => item.id === 'primary-agent');
  await installGranted(registry, value);
  await assert.rejects(registry.setGrants(value.id, value.requestedCapabilities, { consent: true, expectedRevision: 0 }), { code: 'ownership-conflict' });
  await assert.rejects(assign(registry, value.id, 0, 'memory-system'), { code: 'permission-denied' });
  const invalid = manifest('addon.invalid'); invalid.agentRuntime.token = 'must-reject';
  await assert.rejects(registry.install(invalid, { enabled: true }), { code: 'invalid-manifest' });
});

test('ownership is fenced while durability is pending and no acknowledgement precedes commit', async () => {
  const store = memoryStore(), registry = await open(store);
  await installGranted(registry); await assign(registry);
  const authorization = registry.authorize('primary-agent', 'addon.one');
  let release, entered;
  const paused = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const write = store.write;
  store.write = async document => { if (document.phase === 'committed') { entered(); await wait; } await write(document); };
  let acknowledged = false;
  const operation = assign(registry, 'addon.one', 1).then(() => { acknowledged = true; });
  await paused;
  assert.equal(acknowledged, false);
  assert.equal(registry.isCurrent(authorization), false);
  assert.equal(registry.snapshot().slots['primary-agent'].available, false);
  release(); await operation;
  assert.equal(acknowledged, true);
  assert.equal(registry.snapshot().slots['primary-agent'].generation, 2);
});

test('store rejects sync and rename failures and leaves a readable prior document', async t => {
  const fs = await import('node:fs/promises');
  const userRoot = await mkdtemp(join(tmpdir(), 'harness-durability-'));
  t.after(() => rm(userRoot, { recursive: true, force: true }));
  const store = createHarnessRegistryStore({ userRoot });
  await store.write({ old: true });
  for (const stage of ['file-sync', 'rename', 'directory-sync']) {
    const faulty = createHarnessRegistryStore({ userRoot, fs: {
      ...fs,
      rename: async (...args) => { if (stage === 'rename') throw new Error('rename failed'); return fs.rename(...args); },
      open: async (path, flags, ...args) => {
        const handle = await fs.open(path, flags, ...args);
        if ((stage === 'file-sync' && flags === 'wx') || (stage === 'directory-sync' && flags === 'r')) handle.sync = async () => { throw new Error('sync failed'); };
        return handle;
      },
    } });
    await assert.rejects(faulty.write({ next: true }), /failed/);
    assert.deepEqual(await store.read(), stage === 'directory-sync' ? { next: true } : { old: true });
  }
});

for (const stage of ['open', 'sync']) {
  for (const code of ['EISDIR', 'EPERM', 'ENOTSUP', 'EINVAL', 'EBADF', 'ENOSPC']) {
    test(`directory ${stage} ${code} ${code === 'ENOSPC' ? 'rejects' : 'allows'} an already renamed registry write`, async t => {
      const fs = await import('node:fs/promises');
      const userRoot = await mkdtemp(join(tmpdir(), 'harness-directory-sync-'));
      t.after(() => rm(userRoot, { recursive: true, force: true }));
      const directory = join(userRoot, 'harness-governance');
      let attempted = false, closed = false;
      const failure = Object.assign(new Error(`directory ${stage} failed`), { code });
      const store = createHarnessRegistryStore({ userRoot, fs: {
        ...fs,
        open: async (path, ...args) => {
          if (path !== directory) return fs.open(path, ...args);
          attempted = true;
          if (stage === 'open') throw failure;
          return {
            sync: async () => { throw failure; },
            close: async () => { closed = true; },
          };
        },
      } });
      const writing = store.write({ persisted: true });
      if (code === 'ENOSPC') await assert.rejects(writing, { code });
      else await assert.doesNotReject(writing, `${code} directory ${stage} must not reject a completed data write`);
      assert.equal(attempted, true, 'directory sync must be attempted on every platform');
      if (stage === 'sync') assert.equal(closed, true, 'directory handle must close even when sync fails');
      assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), { persisted: true });
    });
  }
}

test('unreadable and malformed durable state fail closed instead of resetting consent', async () => {
  for (const store of [{ read: async () => { throw new Error('permission error'); }, write: async () => {} }, { read: async () => ({ version: 1, phase: 'committed', state: { revision: 4 } }), write: async () => {} }]) {
    const registry = await open(store);
    assert.equal(registry.snapshot().governanceActivated, true, 'unreadable governance must not advertise legacy fallback');
    assert.equal(registry.snapshot().slots['primary-agent'].available, false);
    await assert.rejects(registry.install(manifest(), { enabled: true }), { code: 'runtime-unavailable' });
  }
});
