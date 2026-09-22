import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dsh = 'addon.deepseek-harness', provider = 'addon.provider-chat-demo';
// Independently authored live-shaped input tests the verifier, never live proof.
function bundle() {
  const at = '2026-09-22T12:00:00.000Z';
  const turns = [dsh, provider, dsh].map((addonId, i) => ({
    mode: 'live', at, addonId, generation: i + 1, bootEpoch: 'boot-1',
    sessionId: `session-${i}`, turnId: `turn-${i}`, owner: addonId,
    dispatch: { source: addonId === dsh ? 'dsh-typert' : 'provider-fabric', accepted: true, at },
    answer: { author: addonId, text: `Distinct answer ${i}`, visible: true, at },
    final: { addonId, generation: i + 1, bootEpoch: 'boot-1', sessionId: `session-${i}`, turnId: `turn-${i}`, type: 'final', data: { text: `Distinct answer ${i}` } },
  }));
  return { version: 1, mode: 'live', startedAt: at, finishedAt: at, turns,
    governance: {
      installation: { mode: 'live', at, addonId: dsh, grants: [] },
      denied: { mode: 'live', at, code: 'permission-denied', dispatchesBefore: 0, dispatchesAfter: 0 },
      reload: { mode: 'live', at, before: { addonId: dsh, generation: 3, bootEpoch: 'boot-1', granted: true }, after: { addonId: dsh, generation: 3, bootEpoch: 'boot-2', granted: true } },
      revocation: { mode: 'live', at, addonId: dsh, turnId: 'revoked-turn', generationBefore: 3, generationAfter: 4, dispatched: true, cancelled: true, streamClosed: true, lateEvents: [], staleSessionCode: 'session-not-found' },
      removal: { mode: 'live', at, addonId: dsh, owner: dsh, code: 'ownership-conflict', installed: true },
    } };
}

async function verifier() {
  const module = await import('../../scripts/harness-swap-demo.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.verifyEvidence, 'function', 'demo must export an evidence verifier');
  return module.verifyEvidence;
}

test('demo evidence requires real attributed turns and governance outcomes', async t => {
  const verify = await verifier();
  assert.equal(verify(bundle(), { requireLive: true }), true);
  const mutations = {
    'missing receipts': b => { delete b.turns; },
    'UI text without dispatch': b => { delete b.turns[0].dispatch; },
    'wrong owner identity': b => { b.turns[1].owner = dsh; },
    'no distinct second answer': b => { b.turns[1].answer.text = b.turns[0].answer.text; b.turns[1].final.data.text = b.turns[0].answer.text; },
    'wrong attribution': b => { b.turns[0].answer.author = provider; },
    'no host provenance': b => { delete b.turns[0].final; },
    'wrong generation': b => { b.turns[0].final.generation++; },
    'wrong epoch': b => { b.turns[0].final.bootEpoch = 'stale'; },
    'missing reload': b => { delete b.governance.reload; },
    'lost reload consent': b => { b.governance.reload.after.granted = false; },
    'no restart': b => { b.governance.reload.after.bootEpoch = 'boot-1'; },
    'missing revocation': b => { delete b.governance.revocation; },
    'revocation before dispatch': b => { b.governance.revocation.dispatched = false; },
    'late output': b => { b.governance.revocation.lateEvents.push({ type: 'final' }); },
    'missing removal': b => { delete b.governance.removal; },
    'removed owner': b => { b.governance.removal.installed = false; },
    'denial still dispatched': b => { b.governance.denied.dispatchesAfter++; },
    'missing timestamp': b => { delete b.turns[0].at; },
    'fixture bundle as live': b => { b.mode = 'fixture'; },
    'fixture receipt as live': b => { b.turns[0].mode = 'fixture'; },
    'fixture governance as live': b => { b.governance.reload.mode = 'fixture'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const invalid = bundle(); mutate(invalid);
    assert.throws(() => verify(invalid, { requireLive: true }), /evidence/i);
  });
  const fixture = bundle(); fixture.mode = 'fixture';
  for (const receipt of [...fixture.turns, ...Object.values(fixture.governance)]) receipt.mode = 'fixture';
  assert.equal(verify(fixture, { requireLive: false }), true);
  assert.throws(() => verify(fixture), /evidence/i, 'live is the default');
});

test('demo evidence rejects a swap-back answer matching the provider answer', async () => {
  const verify = await verifier();
  const invalid = bundle();
  invalid.turns[2].answer.text = invalid.turns[2].final.data.text = invalid.turns[1].answer.text;
  assert.throws(() => verify(invalid), /^Error: Invalid demo evidence: distinct second answer$/);
});

test('live-mode verifier success says liveness is attested', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/harness-swap-demo.mjs', import.meta.url)),
    '--verify', '/dev/stdin',
  ], { input: JSON.stringify(bundle()), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /liveness is attested/);
  assert.equal(result.stdout.trim(), 'Evidence is internally consistent; liveness is attested by the operator who ran the demo and by its witnesses, not proven by this verifier');
});

test('demo evidence rejects internally consistent turns in the wrong owner order', async () => {
  const verify = await verifier();
  const invalid = bundle();
  invalid.turns = [invalid.turns[0], invalid.turns[2], invalid.turns[1]];
  for (const [i, turn] of invalid.turns.entries()) {
    turn.generation = turn.final.generation = i + 1;
    assert.equal(turn.owner, turn.addonId);
    assert.equal(turn.dispatch.source, turn.addonId === dsh ? 'dsh-typert' : 'provider-fabric');
  }
  assert.deepEqual(invalid.turns.map(turn => turn.owner), [dsh, dsh, provider]);
  assert.deepEqual(invalid.turns.map(turn => turn.generation), [1, 2, 3]);
  assert.throws(() => verify(invalid), /^Error: Invalid demo evidence: owner order$/);
});

test('demo evidence accepts chronological timestamps with different UTC offsets', async () => {
  const verify = await verifier();
  const valid = bundle();
  valid.startedAt = '2026-09-22T14:00:00+02:00';
  valid.finishedAt = '2026-09-22T08:01:00-04:00';
  assert.equal(verify(valid), true);
});

test('demo evidence rejects a finish instant before its start across UTC offsets', async () => {
  const verify = await verifier();
  const invalid = bundle();
  invalid.startedAt = '2026-09-22T08:01:00-04:00';
  invalid.finishedAt = '2026-09-22T14:00:00+02:00';
  assert.throws(() => verify(invalid), /bundle timestamps/);
});

test('demo evidence rejects unparseable bundle timestamps', async () => {
  const verify = await verifier();
  for (const key of ['startedAt', 'finishedAt']) {
    const invalid = bundle();
    invalid[key] = 'not-a-timestamp';
    assert.throws(() => verify(invalid), /bundle timestamps/);
  }
});

test('demo evidence rejects a whitespace-only turnId', async () => {
  const verify = await verifier();
  const invalid = bundle();
  invalid.turns[0].turnId = invalid.turns[0].final.turnId = ' \t\n ';
  assert.throws(() => verify(invalid), /host provenance/);
});
