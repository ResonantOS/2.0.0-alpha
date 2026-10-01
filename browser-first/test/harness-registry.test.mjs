import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, copyFile, cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createHarnessRegistry } from '../host/harness-registry.mjs';
import { createHarnessRegistryStore } from '../host/harness-registry-store.mjs';
import * as registryStore from '../host/harness-registry-store.mjs';

async function roots(t) {
  const root = await mkdtemp(join(tmpdir(), 'harness-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { userRoot: join(root, 'user'), stateRoot: join(root, 'state') };
}

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
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ stateRoot, userRoot });
  const registry = await open(store);
  await installGranted(registry);
  await assign(registry);
  const restored = await open(createHarnessRegistryStore({ stateRoot, userRoot }));
  assert.equal(restored.snapshot().slots['primary-agent'].addonId, 'addon.one');
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  const document = await store.read();
  await store.write({ ...document, phase: 'pending' });
  assert.throws(() => (restored.authorize('primary-agent', 'addon.foreign')), { code: 'permission-denied' });
  assert.equal((await open(store)).snapshot().slots['primary-agent'].available, false);
});

test('a rolled-back registry file fails closed and resurrects no consent', async t => {
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ stateRoot, userRoot }), registry = await open(store);
  await installGranted(registry); await assign(registry);
  await copyFile(store.path, store.path + '.old');
  await registry.setGrants('addon.one', manifest().requestedCapabilities.map(grant => ({ ...grant, granted: false })), { consent: true, expectedRevision: registry.snapshot().revision });
  await copyFile(store.path + '.old', store.path);
  const restored = await open(createHarnessRegistryStore({ stateRoot, userRoot }));
  assert.equal(restored.snapshot().governanceActivated, true);
  assert.deepEqual(restored.snapshot().installations, {});
  assert.equal(restored.snapshot().slots['primary-agent'].addonId, null);
  assert.equal(restored.snapshot().slots['primary-agent'].available, false);
  await assert.rejects(restored.install(manifest(), { enabled: true }), { code: 'runtime-unavailable' });
  assert.throws(() => restored.authorize('primary-agent', 'addon.one'), { code: 'runtime-unavailable' });
});

test('a lagging watermark is healed on load', async t => {
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ stateRoot, userRoot }), registry = await open(store);
  await installGranted(registry); await assign(registry);
  const path = store.watermarkPath;
  for (const revision of [null, registry.snapshot().revision - 1, registry.snapshot().revision]) {
    const before = await store.read();
    if (revision === null) await rm(path, { force: true });
    else await writeFile(path, JSON.stringify({ version: 1, revision }));
    const restored = await open(createHarnessRegistryStore({ stateRoot, userRoot }));
    assert.equal(restored.snapshot().revision, before.state.revision);
    assert.equal(restored.authorize('primary-agent', 'addon.one').addonId, 'addon.one');
    assert.equal(await store.watermark(), before.state.revision);
    assert.equal(await store.watermark(), restored.snapshot().revision);
  }
  const document = await store.read(), revision = document.state.revision - 1;
  await store.write({ ...document, phase: 'pending' });
  await writeFile(path, JSON.stringify({ version: 1, revision }));
  const pending = await open(store);
  assert.equal(pending.snapshot().slots['primary-agent'].available, false);
  assert.throws(() => pending.authorize('primary-agent', 'addon.one'), { code: 'runtime-unavailable' });
  assert.equal(await store.watermark(), revision);
});

test('a failed heal is diagnosed and never disables the registry', async t => {
  const fs = await import('node:fs/promises');
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ stateRoot, userRoot }), registry = await open(store);
  await installGranted(registry); await assign(registry);
  const document = await store.read(), lines = [], original = console.error;
  console.error = line => lines.push(JSON.parse(line));
  t.after(() => { console.error = original; });
  for (const revision of [null, document.state.revision - 1]) {
    if (revision === null) await rm(store.watermarkPath, { force: true });
    else await writeFile(store.watermarkPath, JSON.stringify({ version: 1, revision }));
    const unwritable = createHarnessRegistryStore({ stateRoot, userRoot, fs: { ...fs, mkdir: async (path, ...args) => {
      if (path === dirname(store.watermarkPath)) throw new Error('state root unwritable');
      return fs.mkdir(path, ...args);
    } } });
    const restored = await open(unwritable);
    assert.equal(restored.snapshot().revision, document.state.revision);
    assert.equal(restored.authorize('primary-agent', 'addon.one').addonId, 'addon.one', 'authority the document proves must survive a failed heal');
    assert.equal(await store.watermark(), revision, 'a failed heal leaves the watermark as it was');
    assert.deepEqual(lines.splice(0), [{ event: 'harness.registry_watermark_unwritable', revision: document.state.revision, watermarkPath: store.watermarkPath }]);
  }
});

test('a malformed watermark fails closed', async t => {
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ stateRoot, userRoot }), registry = await open(store);
  await installGranted(registry); await assign(registry);
  for (const value of ['null', 'garbage', '{"version":2,"revision":3}', '{"version":1,"revision":1.5}', '{"version":1,"revision":"3"}', '{"version":1,"revision":-1}', '{"version":1,"revision":9007199254740991}', ' '.repeat(8 * 1024 * 1024 + 1)]) {
    await writeFile(store.watermarkPath, value);
    const restored = await open(store);
    assert.deepEqual(restored.snapshot().installations, {});
    assert.equal(restored.snapshot().governanceActivated, true);
    assert.equal(restored.snapshot().slots['primary-agent'].addonId, null);
    assert.equal(restored.snapshot().slots['primary-agent'].available, false);
    await assert.rejects(restored.install(manifest(), { enabled: true }), { code: 'runtime-unavailable' });
    assert.throws(() => restored.authorize('primary-agent', 'addon.one'), { code: 'runtime-unavailable' });
    await assert.rejects(store.watermark());
  }
});

test('the watermark is raised only on commit and never lowered', async t => {
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ stateRoot, userRoot });
  await store.write({ version: 1, phase: 'pending', state: { revision: 6 } });
  assert.equal(await store.watermark(), null);
  await store.write({ version: 1, phase: 'committed', state: { revision: 5 } });
  assert.equal(await store.watermark(), 5);
  const path = store.watermarkPath;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, revision: 5 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.write({ version: 1, phase: 'pending', state: { revision: 6 } });
  assert.equal(await store.watermark(), 5);
  await store.write({ version: 1, phase: 'committed', state: { revision: 4 } });
  assert.equal(await createHarnessRegistryStore({ stateRoot, userRoot }).watermark(), 5);
  await store.raise(3);
  assert.equal(await store.watermark(), 5);
  await store.raise(7);
  assert.equal(await store.watermark(), 7);
  await assert.rejects(store.raise('9'), TypeError);
  assert.equal(await store.watermark(), 7);
});

test('crash ordering: a document rename that succeeds with a failing watermark write still loads', async t => {
  const fs = await import('node:fs/promises');
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ stateRoot, userRoot }), registry = await open(store);
  await installGranted(registry); await assign(registry);
  const path = store.watermarkPath;
  for (const stage of ['open', 'rename']) {
    for (const lower of [false, true]) {
      // Write a genuinely newer document so the surviving rename is observable, not a no-op rewrite.
      const persisted = await store.read(), document = { ...persisted, state: { ...persisted.state, revision: persisted.state.revision + 1 } };
      const revision = lower ? persisted.state.revision : null;
      if (revision === null) await rm(path, { force: true });
      else await writeFile(path, JSON.stringify({ version: 1, revision }));
      const faulty = createHarnessRegistryStore({ stateRoot, userRoot, fs: {
        ...fs,
        open: async (path, flags, ...args) => {
          if (flags === 'wx' && dirname(path) === dirname(store.watermarkPath) && stage === 'open') throw new Error('watermark failed');
          return fs.open(path, flags, ...args);
        },
        rename: async (...args) => {
          if (args[1] === store.watermarkPath && stage === 'rename') throw new Error('watermark failed');
          return fs.rename(...args);
        },
      } });
      await assert.rejects(faulty.write(document), /watermark failed/);
      assert.deepEqual(await store.read(), document);
      const restored = await open(createHarnessRegistryStore({ stateRoot, userRoot }));
      assert.equal(restored.authorize('primary-agent', 'addon.one').addonId, 'addon.one');
      assert.equal(await store.watermark(), document.state.revision);
    }
  }
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
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ stateRoot, userRoot });
  await store.write({ old: true });
  for (const stage of ['file-sync', 'rename', 'directory-sync']) {
    const faulty = createHarnessRegistryStore({ stateRoot, userRoot, fs: {
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
      const { userRoot, stateRoot } = await roots(t);
      const directory = join(userRoot, 'harness-governance');
      let attempted = false, closed = false;
      const failure = Object.assign(new Error(`directory ${stage} failed`), { code });
      const store = createHarnessRegistryStore({ stateRoot, userRoot, fs: {
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

test('legacy import creates consent candidates only', async () => {
  const registry = await open(memoryStore()), value = manifest();
  assert.equal(typeof registry.importLegacy, 'function', 'registry must import legacy records as candidates');
  await registry.importLegacy([{ manifest: value, enabled: true, grantedCapabilities: value.requestedCapabilities }]);
  const candidate = registry.snapshot().installations[value.id];
  assert.equal(candidate.enabled, false);
  assert.ok(candidate.grantedCapabilities.every(grant => !grant.granted));
  await assert.rejects(assign(registry), { code: 'permission-denied' });
  await registry.setEnabled(value.id, true, { expectedRevision: registry.snapshot().revision });
  await assert.rejects(assign(registry), { code: 'permission-denied' });
  await registry.setGrants(value.id, value.requestedCapabilities, { consent: true, expectedRevision: registry.snapshot().revision });
  await assign(registry);
  assert.equal(registry.authorize('primary-agent', value.id).addonId, value.id);
});

test('selected add-on grant batches are atomic, including invalid and stale batches', async () => {
  const registry = await open(memoryStore()), value = manifest();
  await registry.install(value, { enabled: true });
  const before = registry.snapshot();
  const grants = value.requestedCapabilities.slice(0, 2).map(g => ({ ...g, granted: true }));
  await assert.rejects(registry.setGrants(value.id, [...grants, { ...grants[0], capability: 'undeclared' }], { consent: true, expectedRevision: before.revision }), { code: 'permission-denied' });
  assert.deepEqual(registry.snapshot(), before, 'invalid batch grants nothing');
  await assert.rejects(registry.setGrants(value.id, grants, { consent: true, expectedRevision: 0 }), { code: 'ownership-conflict' });
  assert.deepEqual(registry.snapshot(), before, 'stale batch grants nothing');
  await registry.setGrants(value.id, grants, { consent: true, expectedRevision: before.revision });
  assert.equal(registry.snapshot().revision, before.revision + 1);
  assert.deepEqual(registry.snapshot().installations[value.id].grantedCapabilities.filter(g => g.granted), grants);
});

test('ordinary add-ons can install, disable, enable, grant and remove without runtime bindings', async () => {
  for (const name of ['browser', 'hermes']) {
    const value = JSON.parse(await readFile(new URL(`../../public/addons/${name}.json`, import.meta.url)));
    const registry = await open(memoryStore());
    await registry.install(value, { enabled: true });
    await registry.setEnabled(value.id, false, { expectedRevision: 1 });
    assert.equal(registry.snapshot().installations[value.id].enabled, false);
    await registry.setEnabled(value.id, true, { expectedRevision: 2 });
    await registry.setGrants(value.id, value.requestedCapabilities.map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: 3 });
    assert.ok(registry.snapshot().installations[value.id].grantedCapabilities.every(g => g.granted));
    await registry.remove(value.id);
    assert.equal(registry.snapshot().installations[value.id], undefined);
  }
});

test('legacy import never overwrites host consent or ownership and survives restart without grants', async () => {
  const store = memoryStore(), registry = await open(store), value = manifest();
  await registry.importLegacy([{ manifest: value, enabled: true, grantedCapabilities: value.requestedCapabilities }]);
  const restored = await open(store);
  assert.equal(restored.snapshot().installations[value.id].enabled, false);
  assert.ok(restored.snapshot().installations[value.id].grantedCapabilities.every(g => !g.granted));
  await installGranted(restored, value);
  await assign(restored);
  const before = restored.snapshot();
  await restored.importLegacy([{ manifest: value, enabled: false, grantedCapabilities: [] }]);
  assert.deepEqual(restored.snapshot().installations, before.installations);
  assert.deepEqual(restored.snapshot().slots, before.slots);
});

test('failed persistence cannot partially commit a grant batch', async () => {
  const store = memoryStore(), registry = await open(store), value = manifest();
  await registry.install(value, { enabled: true });
  store.write = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(registry.setGrants(value.id, value.requestedCapabilities, { consent: true, expectedRevision: 1 }), { code: 'runtime-unavailable' });
  assert.ok(registry.snapshot().installations[value.id].grantedCapabilities.every(g => !g.granted));
});


test('Living Archive can own memory-system once granted without an agent runtime', async () => {
  const value = JSON.parse(await readFile(new URL('../../public/addons/living-archive.json', import.meta.url)));
  const registry = await open(memoryStore());
  assert.equal(value.agentRuntime, undefined);
  await registry.install(value, { enabled: true });
  await assert.rejects(assign(registry, value.id, 0, 'memory-system'), { code: 'permission-denied' });
  await registry.setGrants(value.id, value.requestedCapabilities.filter(g => g.capability === 'memory-provider').map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: 1 });
  await registry.setEnabled(value.id, false, { expectedRevision: 2 });
  await assert.rejects(assign(registry, value.id, 0, 'memory-system'), { code: 'permission-denied' });
  await registry.setEnabled(value.id, true, { expectedRevision: 3 });
  await assert.doesNotReject(assign(registry, value.id, 0, 'memory-system'), 'granted Living Archive must own memory-system without an adapter');
  assert.equal(registry.snapshot().slots['memory-system'].available, true);
  assert.equal(registry.authorize('memory-system', value.id).addonId, value.id);
});

for (const slot of ['chat-interface', 'communication-channel']) {
  test(`${slot} needs only its own grant and declared slot, without an adapter`, async () => {
    const registry = await open(memoryStore()), value = manifest();
    delete value.agentRuntime;
    await registry.install(value, { enabled: true });
    await assert.rejects(assign(registry, value.id, 0, slot), { code: 'permission-denied' });
    const capability = slot === 'chat-interface' ? slot : 'notifications';
    await registry.setGrants(value.id, value.requestedCapabilities.filter(g => g.capability === capability).map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: 1 });
    await assign(registry, value.id, 0, slot);
    assert.equal(registry.snapshot().slots[slot].available, true);
    await registry.setEnabled(value.id, false, { expectedRevision: 3 });
    assert.equal(registry.snapshot().slots[slot].available, false);
  });
}

test('primary-agent still requires a bound runtime and every adapter capability', async () => {
  const registry = await open(memoryStore()), value = manifest();
  delete value.agentRuntime;
  await installGranted(registry, value);
  await assert.rejects(assign(registry), { code: 'permission-denied' });
  const harness = manifest();
  await registry.install(harness, { enabled: true });
  await registry.setGrants(harness.id, harness.requestedCapabilities.filter(g => g.capability === 'agent-runtime'), { consent: true, expectedRevision: 3 });
  await assert.rejects(assign(registry), { code: 'permission-denied' });
  await registry.setGrants(harness.id, harness.requestedCapabilities.filter(g => g.capability === 'chat-interface'), { consent: true, expectedRevision: 4 });
  await assign(registry);
  assert.deepEqual(registry.authorize('primary-agent', harness.id), {
    slot: 'primary-agent', addonId: harness.id, bootEpoch: registry.snapshot().bootEpoch, generation: 1, runtime: harness.agentRuntime,
  });
});

test('bundled Augmentor declares the reviewed provider fabric runtime and can become primary', async () => {
  const value = JSON.parse(await readFile(new URL('../../public/addons/augmentor-chat.json', import.meta.url)));
  assert.equal(value.agentRuntime?.adapterId, 'provider-fabric-v1', 'Augmentor must declare the provider fabric adapter');
  const registry = await createHarnessRegistry({ store: memoryStore(), reviewedAdapterIds: ['provider-fabric-v1'] });
  await installGranted(registry, value);
  await assign(registry, value.id);
  assert.equal(registry.snapshot().slots['primary-agent'].available, true);
});

for (const replaceable of [false, true]) {
  test(`vacating an incumbent respects replaceable=${replaceable} without blocking disable`, async () => {
    const registry = await open(memoryStore()), incumbent = manifest();
    incumbent.systemSlots[0].replaceable = replaceable;
    await installGranted(registry, incumbent);
    await assign(registry);
    const before = registry.snapshot();
    const authorization = registry.authorize('primary-agent', incumbent.id);
    if (replaceable) {
      await assign(registry, null, 1);
      assert.deepEqual(registry.snapshot().slots['primary-agent'], { addonId: null, generation: 2, available: false });
    } else {
      await assert.rejects(assign(registry, null, 1), { code: 'ownership-conflict' }, 'nonreplaceable incumbent must refuse vacancy');
      assert.deepEqual(registry.snapshot(), before, 'refused vacancy changes neither generation nor revision');
      assert.equal(registry.isCurrent(authorization), true);
      const fences = [];
      registry.onFence(event => { fences.push(event); });
      await registry.setEnabled(incumbent.id, false, { expectedRevision: before.revision });
      assert.equal(registry.snapshot().slots['primary-agent'].available, false, 'disable must still fence a nonreplaceable incumbent');
      assert.equal(registry.snapshot().slots['primary-agent'].generation, 2);
      assert.equal(registry.isCurrent(authorization), false);
      assert.deepEqual(fences, [{ slot: 'primary-agent' }]);
    }
  });

  test(`incumbent replaceable=${replaceable} controls replacement but not revocation`, async () => {
    const registry = await open(memoryStore()), incumbent = manifest();
    incumbent.systemSlots[0].replaceable = replaceable;
    const incoming = manifest('addon.two'); incoming.systemSlots[0].replaceable = !replaceable;
    await installGranted(registry, incumbent); await installGranted(registry, incoming); await assign(registry);
    const before = registry.snapshot();
    if (replaceable) await assign(registry, incoming.id, 1);
    else {
      await assert.rejects(assign(registry, incoming.id, 1), { code: 'ownership-conflict' }, 'nonreplaceable incumbent must refuse replacement');
      assert.deepEqual(registry.snapshot(), before, 'refusal changes neither generation nor revision');
    }
    const owner = replaceable ? incoming : incumbent;
    await registry.setGrants(owner.id, [{ ...owner.requestedCapabilities.find(g => g.capability === 'agent-runtime'), granted: false }], { consent: true, expectedRevision: registry.snapshot().revision });
    assert.equal(registry.snapshot().slots['primary-agent'].available, false, 'revocation ignores replaceable');
  });
}

test('pending revocation denies dependent operations before durability and projections cannot alter policy', async () => {
  const store = memoryStore(), registry = await open(store), value = manifest();
  value.tools.find(tool => tool.name === value.agentRuntime.invocationTool).requiredCapabilities = ['providers'];
  await installGranted(registry, value); await assign(registry);
  const authorization = registry.authorize('primary-agent', value.id);
  const write = store.write;
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { entered = resolve; });
  store.write = async document => { entered(); await blocked; await write(document); };
  const before = registry.snapshot(), grant = value.requestedCapabilities.find(g => g.capability === 'providers');
  const revoking = registry.setGrants(value.id, [{ ...grant, granted: false }], { consent: true, expectedRevision: before.revision });
  await writing;
  try {
    const projected = registry.snapshot();
    assert.ok(projected.installations[value.id].disabledOperations.includes('invoke'));
    projected.installations[value.id].disabledOperations.length = 0;
    assert.throws(() => registry.assertOperation(authorization, 'invoke'), { code: 'permission-denied' }, 'projection mutation cannot restore withdrawn authority');
    assert.doesNotThrow(() => registry.assertOperation(authorization, 'status'));
  } finally { release(); await revoking; }
  assert.equal(registry.snapshot().slots['primary-agent'].generation, before.slots['primary-agent'].generation);
  const restored = await open(store);
  assert.ok(restored.snapshot().installations[value.id].disabledOperations.includes('invoke'));
  assert.throws(() => restored.assertOperation(restored.authorize('primary-agent', value.id), 'invoke'), { code: 'permission-denied' });
});

// The adapter a manifest names decides what that add-on can actually reach. Before the floor,
// a manifest could name the reviewed provider adapter and simply not mention `providers`:
// installation succeeded, the consent screen never showed it, and the operator had nothing to
// revoke. Installation now refuses a manifest that understates its own adapter. The fixtures are
// the repository's own reviewed examples, so only the declaration differs.
const exampleFor = {
  'provider-fabric-v1': '../host/harness-examples/provider-chat-demo.json',
  'openai-compatible-v1': '../../examples/addons/openai-compatible-harness.json',
  'dsh-typert-v1': '../host/harness-examples/deepseek-harness.json',
};
const examples = Object.fromEntries(await Promise.all(Object.entries(exampleFor)
  .map(async ([adapterId, path]) => [adapterId, JSON.parse(await readFile(new URL(path, import.meta.url)))])));
function shrink(value, capability) {
  const copy = structuredClone(value);
  copy.requestedCapabilities = copy.requestedCapabilities.filter(grant => grant.capability !== capability);
  copy.agentRuntime.requiredCapabilities = copy.agentRuntime.requiredCapabilities.filter(item => item !== capability);
  for (const tool of copy.tools ?? []) tool.requiredCapabilities = (tool.requiredCapabilities ?? []).filter(item => item !== capability);
  return copy;
}
const reviewedRegistry = store => createHarnessRegistry({ store,
  reviewedAdapterIds: Object.keys(exampleFor),
  bindings: Object.values(examples).filter(value => value.agentRuntime.endpoint).map(value => ({
    name: value.agentRuntime.credentialBinding, addonId: value.id, adapterId: value.agentRuntime.adapterId,
    authScheme: value.agentRuntime.authScheme, endpoint: value.agentRuntime.endpoint })) });

test('installation refuses a manifest that understates what its adapter reaches', async () => {
  for (const [adapterId, hidden] of [['provider-fabric-v1', 'providers'], ['openai-compatible-v1', 'network'], ['dsh-typert-v1', 'network']]) {
    const honest = examples[adapterId];
    const registry = await reviewedRegistry(memoryStore());
    await assert.rejects(registry.install(shrink(honest, hidden), { enabled: true }), error => error.code === 'invalid-manifest',
      `${adapterId} must not install while omitting ${hidden}`);
    assert.deepEqual(Object.keys(registry.snapshot().installations), [], 'a refused install must leave no entry');

    await registry.install(structuredClone(honest), { enabled: true });
    const shown = registry.snapshot().installations[honest.id].grantedCapabilities.map(grant => grant.capability);
    assert.ok(shown.includes(hidden), `${adapterId}: the honest manifest installs and shows ${hidden} to the operator`);
  }
});

test('legacy import refuses a manifest that understates what its adapter reaches', async () => {
  // Migration is an authority path like any other: a record that predates the floor must not be
  // a way around it.
  const registry = await reviewedRegistry(memoryStore());
  const honest = examples['provider-fabric-v1'];
  await assert.rejects(registry.importLegacy([{ manifest: shrink(honest, 'providers'), enabled: true, grantedCapabilities: [] }]),
    error => error.code === 'invalid-manifest', 'a legacy record must not import while omitting providers');
  assert.deepEqual(Object.keys(registry.snapshot().installations), [], 'a refused import must leave no entry');
  await registry.importLegacy([{ manifest: structuredClone(honest), enabled: true, grantedCapabilities: [] }]);
  assert.ok(registry.snapshot().installations[honest.id], 'the honest record still imports');
});

test('an add-on with no agent runtime is unaffected by the adapter floor', async () => {
  const registry = await open(memoryStore());
  const value = manifest();
  delete value.agentRuntime;
  await registry.install(value, { enabled: true });
  assert.ok(registry.snapshot().installations['addon.one'], 'non-harness add-ons must still install');
});

test('an adapter id that names an Object prototype member has no floor', async () => {
  // `constructor` satisfies the adapter-name syntax check; a plain object lookup would return
  // Object.prototype.constructor and throw while spreading it.
  const registry = await reviewedRegistry(memoryStore());
  const value = structuredClone(examples['provider-fabric-v1']);
  value.agentRuntime.adapterId = 'constructor';
  await assert.rejects(registry.install(value, { enabled: true }), error => error.code === 'permission-denied',
    'an unreviewed adapter is refused by the reviewed-adapter check, not by a type error');
  // Legacy import accepts candidates with every grant denied; an unreviewed adapter is stopped
  // where it matters, at slot assignment. What must never happen is a TypeError from the lookup.
  await registry.importLegacy([{ manifest: value, enabled: true, grantedCapabilities: [] }]);
  assert.ok(registry.snapshot().installations[value.id], 'the candidate imports with no floor and no grants');
  await assert.rejects(registry.assignSlot('primary-agent', value.id, { expectedGeneration: 0 }),
    error => error.code === 'permission-denied', 'an unreviewed adapter can never take the primary slot');
});

test('an installation persisted before the floor can be removed even when it owned a slot', async () => {
  // Fail-closed is right, but it must not strand the operator: the entry is disabled, its slot
  // is vacated, and removal then works. The missing capability is never granted.
  const honest = examples['provider-fabric-v1'];
  const shrunken = shrink(honest, 'providers');
  shrunken.systemSlots = shrunken.systemSlots.map(slot => ({ ...slot, replaceable: false }));
  const store = memoryStore();
  await store.write({ version: 1, phase: 'committed', state: {
    revision: 1, governanceActivated: true,
    installations: { [shrunken.id]: { manifest: shrunken, enabled: true,
      grants: shrunken.requestedCapabilities.map(grant => ({ ...grant, granted: true })) } },
    slots: { 'primary-agent': { addonId: shrunken.id, generation: 1 } } } });

  const registry = await reviewedRegistry(store);
  const snapshot = registry.snapshot();
  assert.equal(snapshot.installations[shrunken.id].enabled, false, 'the understating installation is disabled on load');
  assert.equal(snapshot.slots['primary-agent'].addonId, null, 'its slot is vacated so it no longer blocks removal');
  assert.ok(!snapshot.installations[shrunken.id].grantedCapabilities.some(grant => grant.capability === 'providers'),
    'the missing capability is never granted on the operator behalf');
  await registry.remove(shrunken.id);
  assert.deepEqual(Object.keys(registry.snapshot().installations), [], 'the operator can now remove it and install a corrected manifest');
});

test('a slot is not advertised available when the floor leaves every operation disabled', async () => {
  // A manifest may REQUEST a capability — satisfying the install floor — while leaving it out of
  // its runtime requirements. Policy still gates invoke on the floor, so without the floor in
  // eligibility the slot would report itself available while every operation was disabled.
  const value = structuredClone(examples['provider-fabric-v1']);
  value.agentRuntime.requiredCapabilities = value.agentRuntime.requiredCapabilities.filter(item => item !== 'providers');
  for (const tool of value.tools ?? []) tool.requiredCapabilities = (tool.requiredCapabilities ?? []).filter(item => item !== 'providers');
  const registry = await reviewedRegistry(memoryStore());
  await registry.install(value, { enabled: true });  // still requests providers, so the floor check passes
  const granted = registry.snapshot().installations[value.id].grantedCapabilities
    .map(grant => ({ ...grant, granted: grant.capability !== 'providers' }));
  await registry.setGrants(value.id, granted, { consent: true, expectedRevision: registry.snapshot().revision });
  assert.ok(registry.snapshot().installations[value.id].disabledOperations.includes('invoke'),
    'policy already denies invoke without the floor capability');
  await assert.rejects(registry.assignSlot('primary-agent', value.id, { expectedGeneration: 0 }),
    error => error.code === 'permission-denied', 'so the slot must refuse the owner rather than advertise it available');
  assert.ok(!registry.snapshot().slots['primary-agent']?.addonId, 'and the slot stays empty');
});

test('a whole-directory restore of the user root is refused', async t => {
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ userRoot, stateRoot }), registry = await open(store);
  await installGranted(registry); await assign(registry);
  const directory = dirname(store.path), backup = join(dirname(userRoot), 'backup');
  await cp(directory, backup, { recursive: true });
  await registry.setGrants('addon.one', manifest().requestedCapabilities.map(grant => ({ ...grant, granted: false })), { consent: true, expectedRevision: registry.snapshot().revision });
  await rm(directory, { recursive: true });
  await cp(backup, directory, { recursive: true });
  const restored = await open(createHarnessRegistryStore({ userRoot, stateRoot }));
  assert.equal(restored.snapshot().governanceActivated, true);
  assert.deepEqual(restored.snapshot().installations, {});
  assert.equal(restored.snapshot().slots['primary-agent'].addonId, null);
  assert.equal(restored.snapshot().slots['primary-agent'].available, false);
  await assert.rejects(restored.install(manifest(), { enabled: true }), { code: 'runtime-unavailable' });
  assert.throws(() => restored.authorize('primary-agent', 'addon.one'), { code: 'runtime-unavailable' });
});

test('a fresh user root continues the counter from the watermark', async t => {
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ userRoot, stateRoot }), registry = await open(store);
  await installGranted(registry); await assign(registry);
  const revision = registry.snapshot().revision;
  await rm(dirname(store.path), { recursive: true });
  const restored = await open(store);
  assert.equal(restored.snapshot().revision, revision);
  assert.equal(restored.snapshot().governanceActivated, false);
  await restored.install(manifest(), { enabled: true });
  assert.equal(restored.snapshot().revision, revision + 1);
  assert.equal(await store.watermark(), revision + 1);
  await restored.setGrants('addon.one', manifest().requestedCapabilities, { consent: true, expectedRevision: revision + 1 });
  await assign(restored);
  assert.equal((await open(store)).authorize('primary-agent', 'addon.one').addonId, 'addon.one');
});

test('user roots on one host keep separate watermarks', async t => {
  const { userRoot, stateRoot } = await roots(t);
  const a = createHarnessRegistryStore({ userRoot, stateRoot });
  const b = createHarnessRegistryStore({ userRoot: join(dirname(userRoot), 'other'), stateRoot });
  const registry = await open(a);
  await installGranted(registry); await assign(registry); await assign(registry, 'addon.one', 1); await assign(registry, 'addon.one', 2);
  await (await open(b)).install(manifest(), { enabled: true });
  assert.equal(await a.watermark(), 5);
  assert.equal((await open(b)).snapshot().revision, 1);
  assert.ok((await open(b)).snapshot().installations['addon.one']);
  assert.notEqual(a.watermarkPath, b.watermarkPath);
  for (const store of [a, b]) {
    assert.equal(dirname(store.watermarkPath), join(stateRoot, 'harness-governance'));
    assert.ok((await stat(store.watermarkPath)).isFile());
  }
});

test('the watermark is machine-bound and 0600 under the state root', async t => {
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ userRoot, stateRoot });
  await installGranted(await open(store));
  assert.equal(dirname(store.watermarkPath), join(stateRoot, 'harness-governance'));
  assert.match(basename(store.watermarkPath), /^[a-f0-9]{32}\.watermark\.json$/);
  const { createHash } = await import('node:crypto');
  assert.equal(basename(store.watermarkPath), createHash('sha256').update(resolve(userRoot)).digest('hex').slice(0, 32) + '.watermark.json');
  assert.equal((await stat(store.watermarkPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(store.watermarkPath))).mode & 0o777, 0o700);
});

test('defaultHarnessStateRoot resolves per platform', () => {
  assert.equal(typeof registryStore.defaultHarnessStateRoot, 'function');
  const home = '/test/home';
  for (const [platform, env, expected] of [
    ['darwin', {}, join(home, 'Library', 'Application Support', 'ResonantOS')],
    ['win32', { LOCALAPPDATA: '/test/local' }, join('/test/local', 'ResonantOS')],
    ['win32', { LOCALAPPDATA: '' }, join(home, 'AppData', 'Local', 'ResonantOS')],
    ['win32', {}, join(home, 'AppData', 'Local', 'ResonantOS')],
    ['linux', { XDG_STATE_HOME: '/test/state' }, join('/test/state', 'resonantos')],
    ['linux', { XDG_STATE_HOME: '' }, join(home, '.local', 'state', 'resonantos')],
    ['linux', {}, join(home, '.local', 'state', 'resonantos')],
  ]) assert.equal(registryStore.defaultHarnessStateRoot({ platform, env, home }), expected);
});

test('refusal is diagnosed with the watermark path', async t => {
  const { userRoot, stateRoot } = await roots(t);
  const store = createHarnessRegistryStore({ userRoot, stateRoot }), registry = await open(store);
  await installGranted(registry); await assign(registry);
  const document = await readFile(store.path), documentRevision = registry.snapshot().revision;
  await registry.setGrants('addon.one', manifest().requestedCapabilities.map(grant => ({ ...grant, granted: false })), { consent: true, expectedRevision: documentRevision });
  const watermark = await store.watermark();
  await writeFile(store.path, document);
  const lines = [], original = console.error;
  console.error = line => lines.push(JSON.parse(line));
  t.after(() => { console.error = original; });
  const fs = await import('node:fs/promises');
  const unreadable = createHarnessRegistryStore({ userRoot, stateRoot, fs: { ...fs, open: async (path, ...args) => {
    if (path === store.watermarkPath) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.open(path, ...args);
  } } });
  for (const [reason, target] of [['rollback', store], ['watermark-unreadable', unreadable], ['watermark-invalid', store]]) {
    if (reason === 'watermark-invalid') await writeFile(store.watermarkPath, 'null');
    await open(target);
    assert.deepEqual(lines.splice(0), [{ event: 'harness.registry_refused', reason, documentRevision, watermark: reason === 'rollback' ? watermark : null, watermarkPath: store.watermarkPath }]);
  }
  await rm(dirname(store.path), { recursive: true });
  const restored = await open(store);
  assert.deepEqual(lines.splice(0), [{ event: 'harness.registry_refused', reason: 'watermark-invalid', documentRevision: null, watermark: null, watermarkPath: store.watermarkPath }]);
  await assert.rejects(restored.install(manifest(), { enabled: true }), { code: 'runtime-unavailable' });
});
