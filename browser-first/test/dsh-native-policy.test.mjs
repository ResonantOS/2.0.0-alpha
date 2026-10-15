import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAddOnManifest } from '../../packages/addon-sdk/src/validation.ts';
import { adapterCapabilityFloor, evaluateHarnessPolicy } from '../host/harness-policy.mjs';
import { createHarnessRegistry } from '../host/harness-registry.mjs';

const plugin = JSON.parse(await readFile(new URL('../host/harness-examples/deepseek-harness.json', import.meta.url)));
function native() {
  const m = structuredClone(plugin);
  m.id = 'addon.deepseek-harness-native';
  Object.assign(m.agentRuntime, { authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081', credentialBinding: 'dsh.native' });
  for (const capability of ['filesystem', 'shell']) m.requestedCapabilities.push({ capability, scope: 'system', revocationBehavior: 'hard-stop', granted: false });
  return m;
}
const bindings = [{ name: 'dsh.native', addonId: 'addon.deepseek-harness-native', adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081' }];
const store = () => { let saved = null; return { read: async () => saved, write: async value => { saved = structuredClone(value); } }; };
const granted = (m, denied) => m.requestedCapabilities.map(g => ({ ...g, granted: g.capability !== denied }));

test('native scheme is declarative and narrowly paired', () => {
  assert.equal(validateAddOnManifest(native()).valid, true);
  for (const endpoint of ['http://localhost:3081', 'http://127.0.0.1:3081/', 'http://127.0.0.1:0', 'http://127.0.0.1:1023', 'https://127.0.0.1:3081', 'http://127.0.0.1:3081/?token=x']) {
    const m = native(); m.agentRuntime.endpoint = endpoint;
    assert.equal(validateAddOnManifest(m).valid, false, endpoint);
  }
  const wrong = native(); wrong.agentRuntime.adapterId = 'openai-compatible-v1';
  assert.equal(validateAddOnManifest(wrong).valid, false);
  const path = native(); path.agentRuntime.source = { managedDsh: true };
  assert.equal(validateAddOnManifest(path).valid, false);
  assert.deepEqual(adapterCapabilityFloor(plugin), ['agent-runtime', 'network']);
  assert.deepEqual(adapterCapabilityFloor(native()), ['agent-runtime', 'network', 'filesystem', 'shell']);
});
for (const capability of ['agent-runtime', 'network', 'filesystem', 'shell']) {
  test(`native floor ${capability} cannot be omitted or implicitly granted`, async () => {
    const registry = await createHarnessRegistry({ store: store(), reviewedAdapterIds: ['dsh-typert-v1'], bindings });
    const missing = native(); missing.requestedCapabilities = missing.requestedCapabilities.filter(g => g.capability !== capability);
    await assert.rejects(registry.install(missing, { enabled: true, expectedRevision: 0 }));
    const m = native(); await registry.install(m, { enabled: true, expectedRevision: 0 });
    const grants = granted(m, capability);
    await registry.setGrants(m.id, grants, { consent: true, expectedRevision: 1 });
    await assert.rejects(registry.assignSlot('primary-agent', m.id, { expectedGeneration: 0 }), { code: 'permission-denied' });
    await registry.setGrants(m.id, granted(m), { consent: true, expectedRevision: 2 });
    await registry.assignSlot('primary-agent', m.id, { expectedGeneration: 0 });
    const authorization = registry.authorize('primary-agent', m.id);
    for (const operation of m.agentRuntime.supportedOperations) registry.assertOperation(authorization, operation);
    await registry.setGrants(m.id, grants, { consent: true, expectedRevision: 4 });
    for (const operation of m.agentRuntime.supportedOperations) assert.throws(() => registry.assertOperation(authorization, operation));
    assert.equal(registry.snapshot().slots['primary-agent'].generation, 2);
  });
}
// Filesystem/shell are the additional native floor. SDK dependencies already reject
// omissions of agent-runtime/network, so saved-load coverage focuses on these two.
for (const capability of ['filesystem', 'shell']) {
  test(`saved native floor ${capability} vacates the owner without invalid grants`, async () => {
    const durable = store();
    const options = { store: durable, reviewedAdapterIds: ['dsh-typert-v1'], bindings };
    const registry = await createHarnessRegistry(options), m = native();
    await registry.install(m, { enabled: true, expectedRevision: 0 });
    await registry.setGrants(m.id, granted(m), { consent: true, expectedRevision: 1 });
    await registry.assignSlot('primary-agent', m.id, { expectedGeneration: 0 });
    assert.deepEqual(registry.snapshot().slots['primary-agent'], { addonId: m.id, generation: 1, available: true });
    const document = await durable.read();
    const entry = document.state.installations[m.id];
    entry.manifest.requestedCapabilities = entry.manifest.requestedCapabilities.filter(g => g.capability !== capability);
    entry.grants = entry.grants.filter(g => g.capability !== capability);
    assert.equal(validateAddOnManifest(entry.manifest).valid, true);
    assert.ok(entry.grants.every(g => g.granted && entry.manifest.requestedCapabilities.some(r =>
      r.capability === g.capability && r.scope === g.scope && r.revocationBehavior === g.revocationBehavior)));
    await durable.write(document);
    const loaded = (await createHarnessRegistry(options)).snapshot();
    assert.equal(loaded.revision, 3, 'valid document loaded, not the catch/reset path');
    assert.equal(loaded.installations[m.id].enabled, false);
    assert.deepEqual(loaded.slots['primary-agent'], { addonId: null, generation: 2, available: false });
  });
  test(`native floor ${capability} independently denies slot assignment`, async () => {
    const registry = await createHarnessRegistry({ store: store(), reviewedAdapterIds: ['dsh-typert-v1'], bindings });
    const m = native();
    await registry.install(m, { enabled: true, expectedRevision: 0 });
    await registry.setGrants(m.id, granted(m, capability), { consent: true, expectedRevision: 1 });
    await assert.rejects(registry.assignSlot('primary-agent', m.id, { expectedGeneration: 0 }), { code: 'permission-denied' });
  });
  test(`native floor ${capability} independently disables every operation`, () => {
    const m = native();
    assert.deepEqual(evaluateHarnessPolicy(m, granted(m, capability)).disabledOperations, m.agentRuntime.supportedOperations);
  });
}
