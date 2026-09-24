import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FIXTURE_SIGNER, runFixtureCertification, verifyEvidence } from '../../scripts/harness-swap-demo.mjs';

const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const fingerprint = async publicKey => (await import('node:crypto')).createHash('sha256')
  .update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 32);
let fixturePromise;
const fixtureBundle = async () => structuredClone(await (fixturePromise ??= runFixtureCertification()));
// Independently generated keys exercise the live verifier. This is synthetic
// test input, never live evidence: witnesses must compare fingerprints at boot.
async function liveBundle() {
  const bundle = await fixtureBundle();
  bundle.mode = 'live';
  const keys = [];
  for (const boot of bundle.boots) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519'); keys.push(privateKey);
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    boot.signer = { algorithm: 'ed25519', publicKey: pem, fingerprint: await fingerprint(pem) };
  }
  for (const turn of bundle.turns) turn.answer.visible = true;
  resign(bundle, keys);
  return { bundle, keys };
}
function resign(bundle, keys) {
  for (const [i, boot] of bundle.boots.entries()) for (const receipt of boot.receipts) {
    receipt.mode = bundle.mode;
    receipt.signer = { algorithm: 'ed25519', keyId: boot.signer.fingerprint };
    const { signature, ...body } = receipt;
    receipt.signature = sign(null, Buffer.from(canonical(body)), keys[i]).toString('base64');
  }
}
const get = (b, id) => b.boots.flatMap(boot => boot.receipts).find(r => `${r.bootEpoch}:${r.receiptSequence}` === id);

test('fixture certification completes both boot epochs, three owners and all policy steps', async () => {
  const bundle = await fixtureBundle();
  assert.equal(verifyEvidence(bundle, { requireLive: false }), true);
  assert.equal(bundle.turns.length, 6);
  assert.deepEqual(bundle.turns.map(t => get(bundle, t.final).event.addonId), [
    'addon.deepseek-harness', 'addon.openai-compatible-harness', 'addon.second-compatible',
    'addon.second-compatible', 'addon.deepseek-harness', 'addon.openai-compatible-harness',
  ]);
  assert.notEqual(bundle.boots[0].bootEpoch, bundle.boots[1].bootEpoch);
  assert.deepEqual(bundle.boots[0].signer, FIXTURE_SIGNER);
  assert.deepEqual(bundle.boots[1].signer, FIXTURE_SIGNER);
  assert.ok(bundle.boots.every(boot => boot.receipts.every(r => r.signature && r.mode === 'fixture')));
});

test('restart certification rejects stale execution receipts', async t => {
  for (const key of ['session', 'invocation', 'final']) await t.test(`old ${key}`, async () => {
    const { bundle } = await liveBundle();
    bundle.turns[3][key] = bundle.turns[2][key];
    assert.throws(() => verifyEvidence(bundle), /stale execution receipts/);
  });
});

test('live certification rejects unsigned receipts even with consistent labels', async t => {
  // A receipt is unsigned whether the signature, the signer block, or both are missing;
  // the verifier must not treat an absent signer as "nothing to verify" (audit finding).
  for (const [name, strip] of Object.entries({
    'missing signature': receipt => { delete receipt.signature; },
    'missing signer': receipt => { delete receipt.signer; },
    'missing signer and signature': receipt => { delete receipt.signer; delete receipt.signature; },
  })) await t.test(name, async () => {
    const { bundle } = await liveBundle();
    strip(get(bundle, bundle.turns[0].final));
    assert.throws(() => verifyEvidence(bundle), /unsigned|signature/);
  });
});

test('demo evidence requires real attributed turns and governance outcomes', async t => {
  const mutations = {
    'missing receipts': b => { delete b.turns; },
    'UI text without dispatch': b => { delete b.turns[0].invocation; },
    'wrong owner order': b => { [b.turns[0], b.turns[1]] = [b.turns[1], b.turns[0]]; },
    'no distinct second answer': b => { const text = b.turns[0].answer.text; b.turns[1].answer.text = get(b, b.turns[1].final).event.data.text = text; },
    'swap-back matching answer': b => { const text = b.turns[0].answer.text; b.turns[4].answer.text = get(b, b.turns[4].final).event.data.text = text; },
    'wrong attribution': b => { b.turns[0].answer.author = 'wrong'; },
    'no visible reply': b => { b.turns[0].answer.visible = false; },
    'wrong generation': b => { get(b, b.turns[0].final).event.generation++; },
    'wrong event epoch': b => { get(b, b.turns[3].final).event.bootEpoch = b.boots[0].bootEpoch; },
    'wrong session epoch': b => { get(b, b.turns[3].session).result.session.bootEpoch = b.boots[0].bootEpoch; },
    'lost reload consent': b => { b.boots[1].receipts[0].projection.installations['addon.second-compatible'].grantedCapabilities[0].granted = false; },
    'lost reload owner': b => { b.boots[1].receipts[0].projection.slots['primary-agent'].addonId = 'wrong'; },
    'no restart': b => { b.boots[1].bootEpoch = b.boots[0].bootEpoch; },
    'reused session after restart': b => { b.governance.staleSession = b.turns[3].invocation; },
    'missing stale events check': b => { delete b.governance.staleEvents; },
    'missing hard-stop': b => { delete b.governance.hardStop; },
    'missing degrade': b => { delete b.governance.degrade; },
    'revocation before dispatch': b => { b.governance.hardStop.dispatched = false; },
    'open hard-stop stream': b => { delete b.governance.hardStop.closed; },
    'degrade aborts unrelated status': b => { get(b, b.governance.degrade.status).ok = false; },
    'late output': b => { const r = b.boots[1].receipts.find(r => r.kind === 'event' && r.event.type === 'cancelled'); r.event.type = 'final'; },
    'replaceable incumbent': b => { get(b, b.governance.lockInstall).declaration.systemSlots[0].replaceable = true; },
    'wrong generation caused refusal': b => { get(b, b.governance.replacement).request.expectedGeneration++; },
    'missing removal': b => { delete b.governance.removal; },
    'removed owner': b => { get(b, b.governance.removal).projection.installations['addon.second-compatible'].installed = false; },
    'same compatible endpoint': b => { get(b, b.governance.installations[2]).declaration.agentRuntime.endpoint = get(b, b.governance.installations[1]).declaration.agentRuntime.endpoint; },
    'missing timestamp': b => { delete b.turns[0].answer.at; },
    'empty turn id': b => { get(b, b.turns[0].final).event.turnId = ' \t\n '; },
    'time reversal': b => { b.startedAt = '2026-09-22T08:01:00-04:00'; b.finishedAt = '2026-09-22T14:00:00+02:00'; },
    'invalid timestamp': b => { b.startedAt = 'not-a-timestamp'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const { bundle, keys } = await liveBundle(); mutate(bundle); resign(bundle, keys);
    assert.throws(() => verifyEvidence(bundle), /evidence/i);
  });
});

test('every host receipt is verified, including unreferenced receipts', async t => {
  for (const kind of ['boot', 'route', 'event', 'stream-closed']) await t.test(kind, async () => {
    const { bundle } = await liveBundle();
    bundle.boots[0].receipts.find(r => r.kind === kind).at = '2000-01-01T00:00:00Z';
    assert.throws(() => verifyEvidence(bundle), /signature failed/);
  });
  const { bundle } = await liveBundle();
  bundle.boots[0].receipts[0].signer.keyId = bundle.boots[1].signer.fingerprint;
  assert.throws(() => verifyEvidence(bundle), /key mismatch/);
});

test('fixture key is rejected as live even after every fixture label is relabelled', async () => {
  const bundle = await fixtureBundle(); bundle.mode = 'live';
  for (const boot of bundle.boots) for (const receipt of boot.receipts) receipt.mode = 'live';
  assert.throws(() => verifyEvidence(bundle), /fixture signing key/);
  assert.throws(() => verifyEvidence({ ...bundle, mode: 'fixture' }), /fixture/);
});

test('fingerprint is recomputed and each boot requires its own live key', async () => {
  const { bundle, keys } = await liveBundle();
  bundle.boots[0].signer.fingerprint = '0'.repeat(32);
  assert.throws(() => verifyEvidence(bundle), /fingerprint/);
  bundle.boots[0].signer = bundle.boots[1].signer;
  resign(bundle, [keys[1], keys[1]]);
  assert.throws(() => verifyEvidence(bundle), /key rotation/);
});

test('canonical signatures survive JSON property reordering and whitespace', async () => {
  const { bundle } = await liveBundle();
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
  const reordered = JSON.parse(JSON.stringify(reorder(bundle), null, 4));
  assert.equal(verifyEvidence(reordered), true);
  reordered.startedAt = '2026-09-22T14:00:00+02:00';
  reordered.finishedAt = '2026-09-22T08:01:00-04:00';
  assert.equal(verifyEvidence(reordered), true);
});

test('CLI verifies fixture end to end and explains fingerprint comparison and liveness limits', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'harness-swap-demo-'));
  try {
    const file = path.join(directory, 'evidence.json');
    const script = fileURLToPath(new URL('../../scripts/harness-swap-demo.mjs', import.meta.url));
    const run = flags => spawnSync(process.execPath, [script, '--verify', file, ...flags], { encoding: 'utf8' });
    writeFileSync(file, JSON.stringify(await fixtureBundle()));
    const fixture = run(['--fixture']); assert.equal(fixture.status, 0, fixture.stderr);
    assert.match(fixture.stdout, /Fixture evidence verified; not live proof/);
    assert.equal(run([]).status, 1);
    const { bundle } = await liveBundle(); writeFileSync(file, JSON.stringify(bundle));
    const live = run([]); assert.equal(live.status, 0, live.stderr);
    assert.match(live.stdout, /does not attest the operator/);
    assert.match(live.stdout, /forged bundle can embed its own key/);
    assert.match(live.stdout, /Comparing the recorded fingerprint against the one printed by the real host/);
    assert.match(live.stdout, /Liveness is attested/);
    delete bundle.boots[0].receipts[0].signature;
    writeFileSync(file, JSON.stringify(bundle)); assert.equal(run([]).status, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

async function compatibleSwap(t, loopback) {
  const { readFile } = await import('node:fs/promises');
  const { createHash, randomBytes } = await import('node:crypto');
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { createHarnessHostService } = await import('../host/harness-host-service.mjs');
  const { createOpenAICompatibleAdapter } = await import('../host/agent-adapters/openai-compatible.mjs');
  const { validateHarnessManifest } = await import('../host/harness-adapter-contract.mjs');
  const examplePath = new URL('../../examples/addons/openai-compatible-harness.json', import.meta.url);
  const original = JSON.parse(await readFile(examplePath));
  assert.equal(validateHarnessManifest(original).valid, true);
  const adapterPath = new URL('../host/agent-adapters/openai-compatible.mjs', import.meta.url);
  const hash = async () => createHash('sha256').update(await readFile(adapterPath)).digest('hex');
  const before = await hash();
  const manifests = [], bindings = [], dispatches = [], receipts = [], env = {}, responders = new Map();
  for (let i = 0; i < 2; i++) {
    const token = randomBytes(24).toString('hex');
    let endpoint = `http://127.0.0.1:${35000 + i}`;
    const respond = (url, authorization, request) => {
      assert.equal(new URL(url, endpoint).pathname, '/v1/chat/completions');
      assert.equal(authorization, `Bearer ${token}`);
      dispatches.push({ source: 'openai-compatible-v1', accepted: true, model: request.model, endpoint });
      return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `Independent reply ${i}` } }] })}\n\ndata: [DONE]\n\n`;
    };
    if (loopback) {
      const server = createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(respond(req.url, req.headers.authorization, JSON.parse(body)));
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      t.after(() => { server.closeAllConnections(); server.close(); });
      endpoint = `http://127.0.0.1:${server.address().port}`;
    }
    responders.set(endpoint, respond);
    const manifest = structuredClone(original);
    if (i) { manifest.id = 'addon.second-compatible'; manifest.name = manifest.agentRuntime.chatAuthorLabel = 'Second Compatible'; }
    manifest.agentRuntime.endpoint = endpoint;
    manifest.agentRuntime.credentialBinding = `compatible.demo${i}`;
    assert.equal(validateHarnessManifest(manifest).valid, true);
    manifests.push(manifest);
    env[`DEMO_BEARER_${i}`] = token;
    bindings.push({ name: manifest.agentRuntime.credentialBinding, addonId: manifest.id, adapterId: manifest.agentRuntime.adapterId,
      authScheme: 'bearer', endpoint: manifest.agentRuntime.endpoint, source: { env: `DEMO_BEARER_${i}` } });
  }
  let stored = null;
  const host = await createHarnessHostService({ bindings, env, ...(loopback ? {} : { openaiAdapterFactory: options => createOpenAICompatibleAdapter({ ...options, fetchImpl: async (url, init) => new Response(responders.get(url.origin)(url, init.headers.Authorization, JSON.parse(init.body)), { headers: { 'content-type': 'text/event-stream' } }) }) }), store: { read: async () => stored, write: async value => { stored = structuredClone(value); } } });
  t.after(() => host.close());
  for (const [i, manifest] of manifests.entries()) {
    await host.registry.install(manifest, { enabled: true });
    await host.registry.setGrants(manifest.id, manifest.requestedCapabilities.map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: host.registry.snapshot().revision });
    await host.registry.assignSlot('primary-agent', manifest.id, { expectedGeneration: i, replace: i > 0 });
    const session = await host.boundary.createSession({ addonId: manifest.id });
    const reader = host.boundary.events(session);
    await host.boundary.selectModel(session, { provider: 'local', model: `model-${i}` });
    const turn = host.boundary.invoke(session, { messages: [{ role: 'user', content: `prompt ${i}` }] });
    const final = (await reader.next()).value;
    await turn.completion;
    assert.equal(final.type, 'final');
    assert.equal(final.addonId, manifest.id);
    assert.equal(final.generation, i + 1);
    assert.equal(final.turnId, turn.turnId);
    assert.equal(final.sessionId, session.sessionId);
    assert.equal(final.bootEpoch, session.bootEpoch);
    assert.equal(final.data.text, `Independent reply ${i}`);
    assert.equal(dispatches[i].model, `model-${i}`);
    // The 2H live driver will collect this shape; these real HTTP protocol
    // fixtures remain explicitly fixture evidence, never live certification.
    receipts.push({ mode: 'fixture', at: new Date().toISOString(), ...session, turnId: turn.turnId,
      owner: manifest.id, adapterSourceHash: await hash(), dispatch: dispatches[i],
      answer: { author: manifest.id, text: final.data.text, visible: false }, final });
    assert.equal(receipts[i].adapterSourceHash, before, 'manifest swaps must not edit adapter source');
    await reader.return();
    if (i === 0) {
      await host.boundary.dispose(session);
      await assert.rejects(host.boundary.history(session), { code: 'session-not-found' });
    }
  }
  assert.notEqual(receipts[0].dispatch.endpoint, receipts[1].dispatch.endpoint);
  assert.notEqual(receipts[0].dispatch.model, receipts[1].dispatch.model);
  assert.notEqual(receipts[0].answer.text, receipts[1].answer.text);
  assert.equal(await hash(), before);
 }

test('a second compatible harness requires only a manifest and binding', { timeout: 8000 }, t => compatibleSwap(t, true));
test('compatible harness receipt shape and host attribution with deterministic transport', { timeout: 8000 }, t => compatibleSwap(t, false));



test('policy proof requires host-signed dispatch and abort receipts', async () => {
  const bundle = await fixtureBundle();
  for (const proof of [bundle.governance.degrade, bundle.governance.hardStop]) {
    assert.equal(typeof proof.dispatched, 'string', 'dispatch must reference a signed host receipt, not an operator boolean');
    assert.equal(get(bundle, proof.dispatched).kind, 'adapter-dispatch');
    assert.deepEqual(get(bundle, proof.dispatched).session, get(bundle, proof.invocation).request.session, 'dispatch must identify the executing session');
    assert.equal(get(bundle, proof.dispatched).turnId, get(bundle, proof.invocation).result.turnId);
    assert.equal(get(bundle, proof.aborted).kind, 'adapter-abort');
  }
});
