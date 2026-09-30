import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
const policy = await import('../host/harness-policy.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const manifest = {
  systemSlots: [{ id: 'primary-agent', replaceable: false }],
  agentRuntime: { requiredCapabilities: ['agent-runtime'], invocationTool: 'chat', supportedOperations: ['createSession', 'invoke', 'history', 'status'] },
  tools: [{ name: 'chat', requiredCapabilities: ['providers'] }],
  surfaces: [{ id: 'dependent', shellNavigation: { requiredCapabilities: ['providers'] } }, { id: 'unrelated' }],
};
const bundledDirectory = new URL('../../public/addons/', import.meta.url);
const bundledManifests = readdirSync(bundledDirectory).filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(new URL(name, bundledDirectory), 'utf8')))
  .filter(value => !Array.isArray(value));
for (const [name, surfaceId] of [['opencode', 'opencode-workspace'], ['browser', 'browser-pane'], ['obsidian', 'obsidian-workspace']]) {
  test(`revoking ui-embedding hides bundled ${name} embedded panes`, () => {
    const value = JSON.parse(readFileSync(new URL(`${name}.json`, bundledDirectory), 'utf8'));
    const embeddedIds = value.surfaces.filter(surface => surface.type === 'embedded-pane').map(surface => surface.id);
    assert.ok(embeddedIds.includes(surfaceId));
    const grants = value.requestedCapabilities.map(grant => ({ ...grant, granted: true }));
    assert.deepEqual(policy.evaluateHarnessPolicy(value, grants).hiddenSurfaceIds, []);
    const result = policy.evaluateHarnessPolicy(value, grants.map(grant => ({ ...grant, granted: grant.capability !== 'ui-embedding' })), { revoked: ['ui-embedding'] });
    for (const id of embeddedIds) assert.ok(result.hiddenSurfaceIds.includes(id), `revoking ui-embedding must hide ${id}`);
  });
}
test('every bundled hide-surface grant has a dependent surface in host policy', async t => {
  assert.ok(bundledManifests.length > 0);
  let checkedGrants = 0;
  for (const value of bundledManifests) {
    for (const grant of value.requestedCapabilities.filter(item => item.revocationBehavior === 'hide-surface')) {
      checkedGrants++;
      await t.test(`${value.id}: ${grant.capability}`, () => {
        const grants = value.requestedCapabilities.map(item => ({ ...item, granted: item.capability !== grant.capability }));
        assert.ok(policy.evaluateHarnessPolicy(value, grants, { revoked: [grant.capability] }).hiddenSurfaceIds.length > 0,
          `${value.id}: revoking ${grant.capability} must hide a dependent surface`);
      });
    }
  }
  assert.ok(checkedGrants > 0);
});
for (const capability of ['ui-embedding', 'chat-interface']) {
  test(`hide-surface implicitly depends on ${capability} for every surface`, () => {
    const value = structuredClone(manifest);
    if (capability === 'chat-interface') value.systemSlots.push({ id: 'chat-interface', replaceable: true });
    const grant = { capability, granted: true, revocationBehavior: 'hide-surface' };
    assert.deepEqual(policy.evaluateHarnessPolicy(value, [grant]).hiddenSurfaceIds, []);
    assert.deepEqual(policy.evaluateHarnessPolicy(value, [{ ...grant, granted: false }], { revoked: [capability] }).hiddenSurfaceIds,
      ['dependent', 'unrelated']);
  });
}
for (const capability of ['providers', 'chat-interface']) {
  for (const dependency of ['shellNavigation', 'embeddedWorkspace']) {
    test(`hide-surface scopes revoked ${capability} to its ${dependency} dependency`, () => {
      const value = structuredClone(manifest);
      value.surfaces = [{ id: 'dependent' }, { id: 'unrelated' }];
      if (dependency === 'shellNavigation') {
        value.surfaces[0].shellNavigation = { requiredCapabilities: [capability] };
      } else {
        value.embeddedWorkspace = { surfaceId: 'dependent', requiredCapabilities: [capability] };
      }
      const grant = { capability, granted: true, revocationBehavior: 'hide-surface' };
      assert.deepEqual(policy.evaluateHarnessPolicy(value, [grant]).hiddenSurfaceIds, []);
      assert.deepEqual(policy.evaluateHarnessPolicy(value, [{ ...grant, granted: false }], { revoked: [capability] }).hiddenSurfaceIds,
        ['dependent'], 'revocation must not hide an unrelated surface');
    });
  }
}
test('incumbent replaceable controls replacement but not revocation', () => {
  assert.equal(typeof policy.replacementAllowed, 'function', 'replacement policy must exist');
  assert.equal(policy.replacementAllowed(manifest, 'primary-agent'), false);
  assert.equal(policy.replacementAllowed({ ...manifest, systemSlots: [{ id: 'primary-agent', replaceable: true }] }, 'primary-agent'), true);
});
for (const behavior of ['hard-stop', 'degrade', 'hide-surface']) {
  test(`revocation effects never preserve withdrawn authority: ${behavior}`, () => {
    assert.equal(typeof policy.evaluateHarnessPolicy, 'function', 'revocation policy must exist');
    const grants = [{ capability: 'agent-runtime', granted: true, revocationBehavior: 'degrade' }, { capability: 'providers', granted: false, revocationBehavior: behavior }];
    const result = policy.evaluateHarnessPolicy(manifest, grants, { revoked: ['providers'], slot: 'primary-agent' });
    assert.equal(result.hardStop, behavior === 'hard-stop');
    assert.deepEqual(result.disabledOperations, ['invoke']);
    assert.deepEqual(result.hiddenSurfaceIds, behavior === 'hide-surface' ? ['dependent'] : []);
    const essential = policy.evaluateHarnessPolicy(manifest, grants.map(g => ({ ...g, granted: false, revocationBehavior: behavior })), { revoked: ['agent-runtime'], slot: 'primary-agent' });
    assert.equal(essential.hardStop, true, 'essential runtime revocation always hard-stops');
    assert.deepEqual(essential.disabledOperations, manifest.agentRuntime.supportedOperations);
  });
}

// A manifest declares what it needs, and the same manifest's declarations decide what the
// operator is asked to consent to and can later revoke. Nothing bound those declarations to
// what the adapter the manifest names actually reaches, so an add-on could name the reviewed
// provider adapter, omit `providers`, and spend the operator's credential with that capability
// never appearing on the consent screen — and no lever to withdraw it. Demonstrated end to end
// against a real host on 2026-09-28.
const floorManifest = (adapterId, declared) => ({
  id: 'addon.floor-fixture',
  requestedCapabilities: declared.map(capability => ({ capability, granted: false, scope: 'system', revocationBehavior: 'hard-stop' })),
  systemSlots: [{ id: 'primary-agent', replaceable: true }],
  agentRuntime: { adapterId, adapterVersion: 1, requiredCapabilities: declared, invocationTool: 'harness.invoke',
    supportedOperations: ['createSession', 'invoke', 'cancel', 'history', 'status'] },
  tools: [{ name: 'harness.invoke', requiredCapabilities: declared }],
});
const allGranted = value => value.requestedCapabilities.map(grant => ({ ...grant, granted: true }));

test('every reviewed adapter declares the capabilities it actually reaches', () => {
  assert.deepEqual(policy.adapterCapabilityFloor({ agentRuntime: { adapterId: 'provider-fabric-v1' } }), ['agent-runtime', 'providers']);
  assert.deepEqual(policy.adapterCapabilityFloor({ agentRuntime: { adapterId: 'openai-compatible-v1' } }), ['agent-runtime', 'network']);
  assert.deepEqual(policy.adapterCapabilityFloor({ agentRuntime: { adapterId: 'dsh-typert-v1' } }), ['agent-runtime', 'network']);
  // An add-on with no runtime, or one naming an adapter the host does not review, has no floor
  // to enforce; the reviewed-adapter check refuses those separately.
  assert.deepEqual(policy.adapterCapabilityFloor({}), []);
  assert.deepEqual(policy.adapterCapabilityFloor({ agentRuntime: { adapterId: 'not-reviewed' } }), []);
});

test('a manifest that omits what its adapter reaches is reported as undeclared', () => {
  assert.deepEqual(policy.undeclaredAdapterCapabilities(floorManifest('provider-fabric-v1', ['agent-runtime', 'chat-interface'])), ['providers']);
  assert.deepEqual(policy.undeclaredAdapterCapabilities(floorManifest('openai-compatible-v1', ['agent-runtime', 'chat-interface'])), ['network']);
  assert.deepEqual(policy.undeclaredAdapterCapabilities(floorManifest('provider-fabric-v1', ['agent-runtime', 'providers', 'chat-interface'])), []);
});

test('omitting a capability the adapter reaches cannot buy an operation the honest manifest loses', () => {
  for (const [adapterId, hidden] of [['provider-fabric-v1', 'providers'], ['openai-compatible-v1', 'network'], ['dsh-typert-v1', 'network']]) {
    const honest = floorManifest(adapterId, ['agent-runtime', hidden, 'chat-interface']);
    const shrunken = floorManifest(adapterId, ['agent-runtime', 'chat-interface']);
    // The operator grants everything each manifest asks for. The honest one still cannot invoke
    // once the hidden capability is withheld; the shrunken one must not be better off for
    // never having asked.
    const withheld = allGranted(honest).map(grant => ({ ...grant, granted: grant.capability !== hidden }));
    const honestPolicy = policy.evaluateHarnessPolicy(honest, withheld);
    const shrunkenPolicy = policy.evaluateHarnessPolicy(shrunken, allGranted(shrunken));
    assert.ok(honestPolicy.disabledOperations.includes('invoke'), `${adapterId}: honest manifest should lose invoke`);
    assert.deepEqual(shrunkenPolicy.disabledOperations, honestPolicy.disabledOperations,
      `${adapterId}: a manifest that never asked for ${hidden} must be gated exactly as one that asked and was refused`);
  }
});
