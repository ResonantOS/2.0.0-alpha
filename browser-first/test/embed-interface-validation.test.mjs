import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAddOnManifest } from '../../packages/addon-sdk/src/validation.ts';
const design = readFileSync(new URL('../../docs/planning/embed-governance-design.md', import.meta.url), 'utf8');
const examples = [...design.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
const fresh = () => structuredClone(examples[0]);
const issues = m => validateAddOnManifest(m).issues.filter(i => i.path.startsWith('interfaces'));
function rejects(edit, code, path) {
  const m = fresh(); edit(m);
  assert.ok(issues(m).some(i => i.code === code && i.path === path && i.severity === 'error'), code);
}
test('complete examples, both tiers, dual interfaces, and unchanged legacy diagnostics', () => {
  assert.equal(examples.length, 2);
  for (const example of examples) {
    const before = structuredClone(example);
    assert.equal(validateAddOnManifest(example).valid, true);
    assert.deepEqual(example, before);
    example.interfaces[0].governance = 'governed';
    assert.equal(validateAddOnManifest(example).valid, true);
  }
  const dual = fresh(), adapter = structuredClone(examples[1]);
  dual.tools = adapter.tools; dual.agentRuntime = adapter.agentRuntime;
  dual.requestedCapabilities.push(...adapter.requestedCapabilities);
  dual.interfaces.push(...adapter.interfaces);
  assert.equal(validateAddOnManifest(dual).valid, true);
  const legacy = fresh(); delete legacy.interfaces;
  const old = validateAddOnManifest(legacy);
  for (const value of [undefined, []]) {
    legacy.interfaces = value; assert.deepEqual(validateAddOnManifest(legacy), old);
  }
  legacy.name = null;
  const badOld = validateAddOnManifest(legacy);
  delete legacy.interfaces;
  assert.deepEqual(validateAddOnManifest(legacy), badOld);
});
test('closed entries, exact lexical bounds, explicit tiers and reserved modes', () => {
  for (const v of [null, {}, 'x', Array(17).fill({})]) rejects(m => m.interfaces = v, 'interfaces-array', 'interfaces');
  for (const v of [null, [], new Date(), 'x']) rejects(m => m.interfaces = [v], 'interface-object', 'interfaces[0]');
  for (const key of ['endpoint', 'credentials', 'default', 'command']) rejects(m => m.interfaces[0][key] = 'PRIVATE', 'interface-field', `interfaces[0].${key}`);
  for (const id of ['', 'Upper', ' x', 'x ', 'a'.repeat(65)]) rejects(m => m.interfaces[0].id = id, 'interface-id', 'interfaces[0].id');
  rejects(m => m.interfaces.push(structuredClone(m.interfaces[0])), 'duplicate-interface-id', 'interfaces[1].id');
  for (const label of ['', ' x', 'x ', '\0x', 'x\x7f', '😀'.repeat(81)]) rejects(m => m.interfaces[0].label = label, 'interface-label', 'interfaces[0].label');
  for (const mode of ['web', 'terminal', '', null]) rejects(m => m.interfaces[0].mode = mode, 'interface-mode', 'interfaces[0].mode');
  for (const tier of [undefined, null, 'trusted']) rejects(m => m.interfaces[0].governance = tier, 'interface-governance', 'interfaces[0].governance');
  const m = fresh(); m.interfaces[0].label = '😀'.repeat(80); m.interfaces[0].id = 'a'.repeat(64);
  assert.deepEqual(issues(m), []);
});
test('references and both capability subset directions', () => {
  rejects(m => m.interfaces[0].requiredCapabilities = null, 'interface-capabilities', 'interfaces[0].requiredCapabilities');
  rejects(m => m.interfaces[0].requiredCapabilities = ['ui-embedding', 'ui-embedding'], 'interface-capabilities', 'interfaces[0].requiredCapabilities[1]');
  rejects(m => m.interfaces[0].requiredCapabilities = ['private'], 'interface-capabilities', 'interfaces[0].requiredCapabilities[0]');
  rejects(m => m.interfaces[0].requiredCapabilities.push('network'), 'interface-unrequested-capability', 'interfaces[0].requiredCapabilities[1]');
  rejects(m => m.interfaces[0].requiredCapabilities = [], 'interface-missing-capability', 'interfaces[0].requiredCapabilities');
  rejects(m => m.interfaces[0].surfaceId = 'missing', 'interface-surface-reference', 'interfaces[0].surfaceId');
  rejects(m => m.surfaces[0].type = 'panel', 'interface-surface-reference', 'interfaces[0].surfaceId');
  rejects(m => m.interfaces[0].agentRuntimeRef = 'agentRuntime', 'interface-surface-reference', 'interfaces[0].agentRuntimeRef');
  for (const source of ['navigation', 'workspace']) {
    const m = fresh();
    m.requestedCapabilities.push({ capability: 'network', granted: false, scope: 'self', revocationBehavior: 'hard-stop' });
    if (source === 'navigation') m.surfaces[0].shellNavigation = { sectionId: 'test', dockIcon: 'browser', eyebrow: 'Test', requiredCapabilities: ['network'] };
    else m.embeddedWorkspace = { surfaceId: 'augmentor-panel', mode: 'hosted-dashboard', autoStart: false, settingsVisibility: 'visible', requiredCapabilities: ['network'] };
    assert.ok(issues(m).some(i => i.code === 'interface-missing-capability'));
    m.interfaces[0].requiredCapabilities.push('network'); assert.deepEqual(issues(m), []);
  }
  for (const dependency of ['runtime', 'invoke', 'selection', 'change']) {
    const m = structuredClone(examples[1]);
    m.requestedCapabilities.push({ capability: 'network', granted: false, scope: 'self', revocationBehavior: 'hard-stop' });
    if (dependency === 'runtime') m.agentRuntime.requiredCapabilities.push('network');
    if (dependency === 'invoke') m.tools[0].requiredCapabilities.push('network');
    if (['selection', 'change'].includes(dependency)) {
      m.agentRuntime.supportsModelSelection = true; m.agentRuntime.supportedOperations.push('selectModel');
      m.agentRuntime.modelSelection = { source: 'runtime-audit', currentModelField: 'model', selectable: true, requiredCapabilities: dependency === 'selection' ? ['network'] : [] };
      if (dependency === 'change') {
        m.tools.push({ ...structuredClone(m.tools[0]), name: 'example.model', requiredCapabilities: ['network'] });
        m.agentRuntime.modelSelection.changeTool = 'example.model';
      }
    }
    assert.ok(issues(m).some(i => i.code === 'interface-missing-capability'));
    m.interfaces[0].requiredCapabilities.push('network'); assert.deepEqual(issues(m), []);
  }
  const legacy = structuredClone(examples[1]);
  for (const k of ['adapterVersion','adapterId','authScheme','supportedOperations','contextRoleFidelity','toolCallbacks']) delete legacy.agentRuntime[k];
  assert.ok(issues(legacy).some(i => i.code === 'interface-runtime-reference'));
  delete legacy.interfaces; assert.equal(validateAddOnManifest(legacy).valid, true);
});
