import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  assert.throws(() => patchGate(fixture(), { ...results, reply: { passed: false, reason: 'observation-unproven' } }), /gate-key-restriction/);
});
test('gate update preserves all unrelated fields and refuses ambiguous shape', async () => {
  const { patchGate, ATTESTATION } = await load();
  const before = fixture(), after = patchGate(before, results);
  assert.deepEqual(before, fixture());
  const expected = fixture();
  Object.assign(expected.liveVersions[1], { browserVisible: true, pluginCoexistence: false, attestation: ATTESTATION, surface: 'react-harness-demo-shell' });
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
  const value = summary({ ...results, token: secret, reply: secret }, true);
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
  assert.equal(summary(results, true).surface, 'react-harness-demo-shell');
  assert.equal(summary(results, true).surfaceDescription, 'React harness-demo shell over the production bridge; not the Chrome extension');
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
