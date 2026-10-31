import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const url = new URL('./dsh-native-browser.live.mjs', import.meta.url);
const load = () => import(url.href);
const fixture = () => ({ deterministic: true, liveVersions: [
  { version: '0.1.5-rc.1', status: 'blocked', blockedReasons: ['observer-anchor-missing'] },
  { version: '0.2.0-rc.2', status: 'blocked', reply: true, browserVisible: false,
    pluginCoexistence: false, blockedReasons: ['browserVisible', 'pluginCoexistence'],
    reasons: { reply: 'preserved', browserVisible: 'requires-conductor-browser', pluginCoexistence: 'requires-conductor-browser' } },
] });
const screenshotNames = ['browser-visible.png', ...[1, 2, 3, 4].map(i => `plugin-swap-${i}.png`)];
const fullDigests = Object.fromEntries(screenshotNames.map(name => [name, 'a'.repeat(64)]));
const results = { browserVisible: { passed: true, reason: 'passed' }, pluginCoexistence: { passed: false, reason: 'observation-unproven' } };

test('companion exists outside deterministic test discovery and import has no live effects', async () => {
  assert.ok(!url.pathname.endsWith('.test.mjs'));
  const runner = await readFile(new URL('../../scripts/run-browser-first-extension-tests.mjs', import.meta.url), 'utf8');
  assert.match(runner, /endsWith\(["']\.test\.mjs["']\)/);
  assert.equal(typeof (await load()).main, 'function');
});
test('external evidence paths reject relative, repository and symlink paths', async () => {
  const { externalPath } = await load();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-contract-'));
  try {
    await assert.rejects(externalPath('relative'));
    await assert.rejects(externalPath(fileURLToPath(new URL('../', import.meta.url))));
    await symlink(fileURLToPath(new URL('../', import.meta.url)), path.join(tmp, 'link'));
    await assert.rejects(externalPath(path.join(tmp, 'link')));
    assert.ok(path.isAbsolute(await externalPath(tmp)));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('tarball digest mismatch refuses before use', async () => {
  const { verifyTarball } = await load();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-digest-'));
  try {
    const file = path.join(tmp, 'plugin.tgz'); await writeFile(file, 'wrong package');
    await assert.rejects(verifyTarball(file), /tarball-digest-mismatch/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('all protected ports are refused', async () => {
  const { assertPort } = await load();
  for (const port of [19387, 47773, 47883, 0, -1, 65536, NaN]) assert.throws(() => assertPort(port));
  assert.equal(assertPort(32001), 32001);
});
test('gate-key restriction rejects third-key patches', async () => {
  const { patchGate } = await load();
  const before = fixture().liveVersions[1], after = patchGate(fixture(), results).liveVersions[1];
  assert.deepEqual(Object.keys(after).filter(key => !(key in before)).sort(),
    ['attestation', 'surface', 'pluginVersion', 'pluginDshVersion', 'pluginHostToolsVersion', 'pluginTarballSha1'].sort());
  assert.throws(() => patchGate(fixture(), { ...results, reply: { passed: false, reason: 'observation-unproven' } }), /gate-key-restriction/);
});
test('gate update preserves all unrelated fields and refuses ambiguous shape', async () => {
  const { patchGate, ATTESTATION } = await load();
  const before = fixture(), after = patchGate(before, results);
  assert.deepEqual(before, fixture());
  const expected = fixture();
  Object.assign(expected.liveVersions[1], { browserVisible: true, pluginCoexistence: false, attestation: ATTESTATION, surface: 'react-harness-demo-shell', pluginVersion: '0.2.11', pluginDshVersion: '0.1.5-rc.1', pluginHostToolsVersion: '0.1.5-rc.3', pluginTarballSha1: '9a2096ee68652fd9fc171665b8462b71f83de4f1' });
  Object.assign(expected.liveVersions[1].reasons, { browserVisible: 'passed', pluginCoexistence: 'observation-unproven' });
  assert.deepEqual(after, expected);
  assert.throws(() => patchGate({}, results));
  const duplicate = fixture(); duplicate.liveVersions.push(duplicate.liveVersions[1]);
  assert.throws(() => patchGate(duplicate, results));
  const missing = fixture(); delete missing.liveVersions[1].browserVisible;
  assert.throws(() => patchGate(missing, results));
});
test('evidence serializer never forwards secret fields, arbitrary reasons or replies', async () => {
  const { summary } = await load();
  const secret = 'PRIVATE_SENTINEL';
  const value = summary({ ...results, token: secret, reply: secret }, true, fullDigests);
  assert.ok(!JSON.stringify(value).includes(secret));
  assert.throws(() => summary({ ...results, browserVisible: { passed: false, reason: secret } }, true));
  assert.throws(() => summary({ ...results, browserVisible: { passed: secret, reason: 'passed' } }, true));
});
test('atomic gate writer refuses noncanonical input and preserves previous file', async () => {
  const { updateGate } = await load();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-gate-'));
  try {
    const file = path.join(tmp, 'final-gate.json');
    await writeFile(file, JSON.stringify(fixture(), null, 2) + '\n');
    await updateGate(file, results);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).liveVersions[1].browserVisible, true);
    const unsafe = '{"liveVersions":[],"liveVersions":[]}'; await writeFile(file, unsafe);
    await assert.rejects(updateGate(file, results));
    assert.equal(await readFile(file, 'utf8'), unsafe);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('surface is recorded in sanitized summary and gate', async () => {
  const { summary, patchGate } = await load();
  assert.equal(summary(results, true, fullDigests).surface, 'react-harness-demo-shell');
  assert.equal(summary(results, true, fullDigests).surfaceDescription, 'React harness-demo shell over the production bridge; not the Chrome extension');
  assert.equal(patchGate(fixture(), results).liveVersions[1].surface, 'react-harness-demo-shell');
});
test('React composition replaces the unavailable extension lane', async () => {
  const source = await readFile(url, 'utf8');
  assert.doesNotMatch(source, /harness-ui-unavailable|chrome-extension:\/\//);
  for (const text of ["mode: 'harness-demo'", 'Choose Add-ons Manually', 'createHarnessRegistryStore', 'startBridgeServer', 'createBridgeClient', 'matchSignedReply']) assert.ok(source.includes(text), text);
});

test('signed reply binds displayed text and owner to the dispatched host turn', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { canonicalReceipt, receiptFingerprint } = await import('../host/harness-host-service.mjs');
  const { matchSignedReply } = await load();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const signer = { publicKey: pem, fingerprint: receiptFingerprint(pem) };
  const session = { addonId: 'addon.test', sessionId: 'session', bootEpoch: 'boot', generation: 1 };
  const seal = body => {
    body = { ...body, bootEpoch: 'boot', mode: 'live', signer: { keyId: signer.fingerprint } };
    return { ...body, signature: sign(null, Buffer.from(canonicalReceipt(body)), privateKey).toString('base64') };
  };
  const invocation = seal({ kind: 'route', operation: '/agent/turn', ok: true, request: { session }, result: { turnId: 'turn' } });
  const final = seal({ kind: 'event', event: { ...session, type: 'final', turnId: 'turn', data: { text: 'synthetic' } } });
  const input = { receipts: [invocation, final], signer, addonId: session.addonId, text: 'synthetic', author: session.addonId };
  await matchSignedReply(input);
  await assert.rejects(matchSignedReply({ ...input, author: 'other' }), /displayed-owner-mismatch/);
  await assert.rejects(matchSignedReply({ ...input, text: 'different' }));
  await assert.rejects(matchSignedReply({ ...input, author: session.addonId + '-native' }), /displayed-owner-mismatch/);
  const altered = structuredClone(final); altered.event.data.text = 'forged';
  await assert.rejects(matchSignedReply({ ...input, receipts: [invocation, altered] }), /invalid-host-signature/);
  for (const field of ['addonId', 'sessionId', 'bootEpoch', 'generation', 'turnId']) {
    const stale = seal({ kind: 'event', event: { ...final.event, [field]: 'other' } });
    await assert.rejects(matchSignedReply({ ...input, receipts: [invocation, stale] }));
  }
  await assert.rejects(matchSignedReply({ ...input, receipts: [final] }), /missing-signed-dispatch/);
});

test('shell bootstrap supplies every capability requested by React transport', async () => {
  const { shellCapabilities } = await load();
  const { scopedCapabilityTokenPayload } = await import('../host/bridge-server.mjs');
  const source = await readFile(new URL('../../src/core/web-transport.ts', import.meta.url), 'utf8');
  const requested = [...new Set([...source.matchAll(/capability: "([a-z-]+)"/g)].map(match => match[1]))];
  assert.ok(requested.length >= 4);
  const tokens = shellCapabilities({ read: 'read-token', control: 'control-token' });
  assert.deepEqual(Object.keys(scopedCapabilityTokenPayload(requested, tokens)).sort(), requested.sort());
  assert.equal(tokens['addon-runtime-read'], 'read-token');
  assert.equal(tokens['addon-runtime-control'], 'control-token');
});

const overrideEnv = {
  DSH_LIVE_PLUGIN_DSH_VERSION: '0.2.0-rc.2',
  DSH_LIVE_PLUGIN_HOST_TOOLS_VERSION: '0.2.0-rc.2',
  DSH_LIVE_PLUGIN_VERSION: '0.2.13',
  DSH_LIVE_PLUGIN_TARBALL_SHA1: '4f26522a64a67138331e191e93b54de5969293fc',
};
test('plugin overrides require all four or none, including empty values', async () => {
  const { pluginConfig } = await load();
  const keys = Object.keys(overrideEnv);
  for (let mask = 1; mask < 15; mask++) {
    const env = Object.fromEntries(keys.filter((_, i) => mask & (1 << i)).map(key => [key, overrideEnv[key]]));
    assert.throws(() => pluginConfig({ ...env, DSH_LIVE_GATE_MODE: 'observe' }), /plugin-overrides-all-or-none/);
  }
  assert.throws(() => pluginConfig({ [keys[0]]: '', DSH_LIVE_GATE_MODE: 'observe' }), /plugin-overrides-all-or-none/);
});
test('observe mode never reads, locks, creates or updates the gate', async () => {
  const { updateGate } = await load();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-observe-'));
  try {
    const file = path.join(tmp, 'final-gate.json');
    const bytes = JSON.stringify(fixture(), null, 2) + '\n';
    await writeFile(file, bytes);
    await updateGate(file, results, 'observe');
    assert.equal(await readFile(file, 'utf8'), bytes);
    await writeFile(`${file}.browser-lanes.lock`, 'foreign lock');
    await writeFile(file, 'not even JSON');
    await updateGate(file, results, 'observe');
    assert.equal(await readFile(file, 'utf8'), 'not even JSON');
    assert.equal(await readFile(`${file}.browser-lanes.lock`, 'utf8'), 'foreign lock');
    await updateGate(undefined, results, 'observe');
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('plugin config strictly validates versions, digest and gate mode', async () => {
  const { pluginConfig } = await load();
  for (const key of Object.keys(overrideEnv).slice(0, 3)) {
    for (const value of ['', 'latest', '^0.2.13', 'v0.2.13', '0.2', '01.2.3', '0.2.13\n', '../0.2.13', '0.2.13;echo']) {
      assert.throws(() => pluginConfig({ ...overrideEnv, [key]: value, DSH_LIVE_GATE_MODE: 'observe' }), /invalid-plugin-version/);
    }
  }
  for (const value of ['', 'a'.repeat(39), 'a'.repeat(41), 'G'.repeat(40), 'A'.repeat(40), overrideEnv.DSH_LIVE_PLUGIN_TARBALL_SHA1 + '\n']) {
    assert.throws(() => pluginConfig({ ...overrideEnv, DSH_LIVE_PLUGIN_TARBALL_SHA1: value, DSH_LIVE_GATE_MODE: 'observe' }), /invalid-plugin-tarball-sha1/);
  }
  for (const value of ['', 'Observe', 'observe\n', 'skip']) assert.throws(() => pluginConfig({ DSH_LIVE_GATE_MODE: value }), /invalid-gate-mode/);
});
test('defaults stay pinned and summary records every effective plugin value', async () => {
  const { pluginConfig, summary } = await load();
  assert.deepEqual(pluginConfig({}), { dshVersion: '0.1.5-rc.1', hostToolsVersion: '0.1.5-rc.3', pluginVersion: '0.2.11', tarballSha1: '9a2096ee68652fd9fc171665b8462b71f83de4f1', gateMode: 'update' });
  const config = pluginConfig({ ...overrideEnv, DSH_LIVE_GATE_MODE: 'observe' });
  const value = summary(results, true, fullDigests, config);
  assert.equal(value.pluginDshVersion, overrideEnv.DSH_LIVE_PLUGIN_DSH_VERSION);
  assert.equal(value.pluginHostToolsVersion, overrideEnv.DSH_LIVE_PLUGIN_HOST_TOOLS_VERSION);
  assert.equal(value.pluginVersion, overrideEnv.DSH_LIVE_PLUGIN_VERSION);
  assert.equal(value.expectedTarballSha1, overrideEnv.DSH_LIVE_PLUGIN_TARBALL_SHA1);
  assert.equal(value.gateMode, 'observe');
});


test('any override requires explicit observe, even partial or default-valued overrides', async () => {
  const { pluginConfig } = await load();
  for (const env of [overrideEnv, { DSH_LIVE_PLUGIN_VERSION: '0.2.11' }]) {
    for (const mode of [undefined, 'update', '', 'Observe']) {
      assert.throws(() => pluginConfig({ ...env, DSH_LIVE_GATE_MODE: mode }), /overrides-require-observe/);
    }
  }
});
test('summary refuses either passed lane without all five digests', async () => {
  const { summary } = await load();
  for (const name of screenshotNames) {
    const digests = { ...fullDigests }; delete digests[name];
    for (const key of ['browserVisible', 'pluginCoexistence']) {
      const lanes = { browserVisible: { passed: false, reason: 'preflight-failed' }, pluginCoexistence: { passed: false, reason: 'preflight-failed' } };
      lanes[key] = { passed: true, reason: 'passed' };
      assert.throws(() => summary(lanes, true, digests), /evidence-missing/);
    }
  }
});
test('disk evidence rejects hash-only fake, tampering, directories and symlinks', async () => {
  const { verifyEvidence } = await load();
  const { createHash } = await import('node:crypto');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-evidence-'));
  const bytes = Buffer.from('fake screenshot');
  const digests = Object.fromEntries(screenshotNames.map(name => [name, createHash('sha256').update(bytes).digest('hex')]));
  const passed = () => Object.fromEntries(['browserVisible', 'pluginCoexistence'].map(key => [key, { passed: true, reason: 'passed' }]));
  const checkFailure = async () => {
    const lanes = passed(); await verifyEvidence(tmp, lanes, digests);
    for (const lane of Object.values(lanes)) assert.deepEqual(lane, { passed: false, reason: 'evidence-missing' });
  };
  try {
    await checkFailure(); // Fake hashes PNG bytes but skips writing them.
    for (const name of screenshotNames) await writeFile(path.join(tmp, name), bytes);
    const lanes = passed(); await verifyEvidence(tmp, lanes, digests); assert.deepEqual(lanes, passed());
    const file = path.join(tmp, screenshotNames[0]);
    await writeFile(file, 'tampered'); await checkFailure();
    await rm(file); await mkdir(file); await checkFailure();
    await rm(file, { recursive: true }); await symlink(path.join(tmp, screenshotNames[1]), file); await checkFailure();
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('host tools cannot resolve outside plugin prefix, including symlink escapes', async () => {
  const { assertPluginTools } = await load();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-tools-'));
  try {
    const prefix = path.join(tmp, 'prefix'), outside = path.join(tmp, 'outside');
    await mkdir(prefix); await mkdir(outside);
    await assert.rejects(assertPluginTools(prefix, outside), /plugin-tools-outside-prefix/);
    await symlink(outside, path.join(prefix, 'escape'));
    await assert.rejects(assertPluginTools(prefix, path.join(prefix, 'escape')), /plugin-tools-outside-prefix/);
    await mkdir(path.join(prefix, 'tools')); await assertPluginTools(prefix, path.join(prefix, 'tools'));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('shared prefixes still require distinct real homes and ports', async () => {
  const { assertLaneIsolation } = await load();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-isolation-'));
  try {
    const homes = ['home', 'plugin-home', 'native-dsh', 'plugin-dsh'].map(name => path.join(tmp, name));
    for (const home of homes) await mkdir(home);
    await assertLaneIsolation(homes, [32001, 32002, 32003, 32004]);
    await assert.rejects(assertLaneIsolation(homes, [32001, 32002, 32002, 32004]), /lane-isolation/);
    await rm(homes[3], { recursive: true }); await symlink(homes[2], homes[3]);
    await assert.rejects(assertLaneIsolation(homes, [32001, 32002, 32003, 32004]), /lane-isolation/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('observe output preflight refuses nonempty directories', async () => {
  const { assertOutputDirectory } = await load();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-output-'));
  try {
    await assertOutputDirectory(tmp, 'observe'); await writeFile(path.join(tmp, 'existing'), 'preserve');
    await assert.rejects(assertOutputDirectory(tmp, 'observe'), /observe-output-not-empty/);
    assert.equal(await readFile(path.join(tmp, 'existing'), 'utf8'), 'preserve');
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('main structurally confines final-gate resolution to update mode and verifies disk before summary', async () => {
  const source = (await readFile(url, 'utf8')).split('export async function main()')[1];
  assert.equal((source.match(/DSH_LIVE_FINAL_GATE/g) ?? []).length, 1);
  assert.match(source, /if \(config.gateMode === 'update'\) \{\s*gate = await externalPath\(process.env.DSH_LIVE_FINAL_GATE/);
  assert.match(source, /await verifyEvidence\(out, results, digests\);\s*await atomicWrite/);
  assert.match(source, /await assertPluginTools\(pluginPrefix, tools\)/);
  assert.match(source, /await assertLaneIsolation\(\[home, pluginHome, dshHome, pluginDshHome\], \[bridgePort, nativePort, pluginPort, shellPort\]\)/);
});
test('observe leaves a nonexistent gate and lock absent', async () => {
  const { updateGate } = await load();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-absent-gate-'));
  try {
    const file = path.join(tmp, 'final-gate.json'); await updateGate(file, results, 'observe');
    for (const name of [file, `${file}.browser-lanes.lock`]) await assert.rejects(readFile(name), { code: 'ENOENT' });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('header documents mode and all four override controls', async () => {
  const header = (await readFile(url, 'utf8')).split('*/')[0];
  for (const name of ['DSH_LIVE_GATE_MODE', ...Object.keys(overrideEnv)]) assert.ok(header.includes(name), name);
});
