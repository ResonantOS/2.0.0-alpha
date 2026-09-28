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
