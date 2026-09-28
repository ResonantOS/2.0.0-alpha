#!/usr/bin/env node
// Intent: docs/addons/harness-adapter-demo.md. Operator evidence is not runtime authority.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalReceipt, receiptFingerprint, createHarnessHostService } from '../browser-first/host/harness-host-service.mjs';
import { createOpenAICompatibleAdapter } from '../browser-first/host/agent-adapters/openai-compatible.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DSH = 'addon.deepseek-harness', A = 'addon.openai-compatible-harness', B = 'addon.second-compatible';
const OWNERS = [DSH, A, B];
const now = () => new Date().toISOString();
const check = (condition, detail) => { if (!condition) throw new Error(`Invalid demo evidence: ${detail}`); };
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const identifier = value => typeof value === 'string' && value.trim().length > 0;
// Deliberately PUBLIC test key material, never an operator credential. Fixed seed
// and standard PKCS8 Ed25519 prefix make fixture signatures reproducible.
const FIXTURE_PRIVATE_KEY = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x46),
]) });
const fixturePublicKey = createPublicKey(FIXTURE_PRIVATE_KEY).export({ type: 'spki', format: 'pem' });
export const FIXTURE_SIGNER = Object.freeze({ algorithm: 'ed25519', publicKey: fixturePublicKey, fingerprint: receiptFingerprint(fixturePublicKey) });
export const SIGNATURE_LIMITATION = 'The signature proves every receipt was issued by the host instance whose fingerprint the operator and witnesses saw printed at boot. It does not attest the operator; a forged bundle can embed its own key. Comparing the recorded fingerprint against the one printed by the real host is the operator\'s step. Liveness is attested by the operator and witnesses, not proven by this verifier.';
const ref = receipt => `${receipt.bootEpoch}:${receipt.receiptSequence}`;
const same = (a, b) => canonicalReceipt(a) === canonicalReceipt(b);

/** Verify signatures first, then require signed host facts for every certification step. */
export function verifyEvidence(bundle, { requireLive = true } = {}) {
  check(bundle?.version === 2, 'unsigned legacy bundle: signatures and fresh execution receipts required');
  check(['live', 'fixture'].includes(bundle.mode) && (!requireLive || bundle.mode === 'live'), 'fixture is not live proof');
  check(timestamp(bundle.startedAt) && timestamp(bundle.finishedAt) && Date.parse(bundle.startedAt) <= Date.parse(bundle.finishedAt), 'bundle timestamps');
  check(Array.isArray(bundle.boots) && bundle.boots.length === 2, 'two boot epochs required');
  const [old, fresh] = bundle.boots;
  check(identifier(old.bootEpoch) && identifier(fresh.bootEpoch) && old.bootEpoch !== fresh.bootEpoch, 'fresh boot epoch');
  const receipts = new Map();
  for (const boot of bundle.boots) {
    let key, fingerprint;
    try { key = createPublicKey(boot.signer.publicKey); fingerprint = receiptFingerprint(boot.signer.publicKey); }
    catch { check(false, 'invalid signature public key'); }
    check(key.asymmetricKeyType === 'ed25519' && boot.signer.algorithm === 'ed25519' && fingerprint === boot.signer.fingerprint, 'signature fingerprint');
    check(!requireLive || fingerprint !== FIXTURE_SIGNER.fingerprint, 'fixture signing key cannot certify live evidence');
    check(Array.isArray(boot.receipts) && boot.receipts.length > 0, 'unsigned/missing receipts');
    let sequence = 0;
    for (const receipt of boot.receipts) {
      check(receipt?.signer?.algorithm === 'ed25519' && receipt.signer.keyId === fingerprint && typeof receipt.signature === 'string', 'unsigned receipt or signature key mismatch');
      const { signature, ...body } = receipt;
      check(verify(null, Buffer.from(canonicalReceipt(body)), key, Buffer.from(signature, 'base64')), 'receipt signature failed');
      check(receipt.bootEpoch === boot.bootEpoch && receipt.mode === bundle.mode && timestamp(receipt.at), 'receipt mode/epoch/timestamp');
      check(Number.isSafeInteger(receipt.receiptSequence) && receipt.receiptSequence > sequence, 'receipt sequence');
      sequence = receipt.receiptSequence;
      receipts.set(ref(receipt), receipt);
    }
    check(boot.receipts[0].kind === 'boot' && boot.receipts[0].projection.bootEpoch === boot.bootEpoch, 'signed boot projection');
  }
  check(!requireLive || old.signer.fingerprint !== fresh.signer.fingerprint, 'per-boot key rotation');
  const get = (id, kind, epoch) => {
    const receipt = receipts.get(id);
    check(receipt && receipt.kind === kind, 'missing signed receipt');
    check(!epoch || receipt.bootEpoch === epoch, 'stale execution receipts');
    return receipt;
  };
  const route = (id, operation, ok = true, epoch) => {
    const receipt = get(id, 'route', epoch);
    check(receipt.operation === operation && receipt.ok === ok, 'governance operation outcome');
    return receipt;
  };
  const sessionEqual = (a, b) => ['addonId', 'sessionId', 'bootEpoch', 'generation'].every(key => a?.[key] === b?.[key]);
  const g = bundle.governance;
  check(g && Array.isArray(g.installations) && g.installations.length === 3, 'three installations');
  const installs = g.installations.map((id, i) => {
    const r = route(id, '/addons/install', true, old.bootEpoch);
    check(r.request.addonId === OWNERS[i] && r.result.installations[OWNERS[i]].grantedCapabilities.every(grant => !grant.granted), 'installation grants nothing');
    return r;
  });
  check(installs[1].declaration.agentRuntime.adapterId === 'openai-compatible-v1' && installs[2].declaration.agentRuntime.adapterId === 'openai-compatible-v1' &&
    installs[1].declaration.agentRuntime.endpoint !== installs[2].declaration.agentRuntime.endpoint, 'independent compatible harnesses on the same adapter');
  const denial = route(g.denied, '/addons/slots/assign', false, old.bootEpoch);
  check(denial.error.code === 'permission-denied', 'ungranted owner denial');
  const before = route(g.beforeRestart, '/addons/registry', true, old.bootEpoch).result;
  const after = fresh.receipts[0].projection;
  check(same(before.slots, after.slots) && OWNERS.every(id => same(before.installations[id].grantedCapabilities, after.installations[id].grantedCapabilities) && before.installations[id].enabled === after.installations[id].enabled) &&
    before.slots['primary-agent'].addonId === B && OWNERS.every(id => after.installations[id].grantedCapabilities.every(grant => grant.granted)), 'restart ownership/grants persistence');
  const stale = route(g.staleSession, '/agent/turn', false, fresh.bootEpoch);
  const staleEvents = route(g.staleEvents, '/agent/events', false, fresh.bootEpoch);
  check(stale.error.code === 'session-not-found' && staleEvents.error.code === 'session-not-found' &&
    stale.request.session.bootEpoch === old.bootEpoch && staleEvents.request.bootEpoch === old.bootEpoch, 'old sessions/events rejected');
  check(Array.isArray(bundle.turns) && bundle.turns.length === 6, 'six attributed turn receipts required');
  const texts = new Set(), sessions = new Set(), turns = new Set();
  let previousGeneration = 0;
  for (const [i, turn] of bundle.turns.entries()) {
    const epoch = i < 3 ? old.bootEpoch : fresh.bootEpoch;
    const expectedOwner = [DSH, A, B, B, DSH, A][i];
    const s = route(turn.session, '/agent/session', true, epoch).result.session;
    const call = route(turn.invocation, '/agent/turn', true, epoch);
    const event = get(turn.final, 'event', epoch).event;
    check(s.addonId === expectedOwner && event.addonId === expectedOwner, 'owner order/identity');
    check(Number.isSafeInteger(s.generation) && s.generation > 0 && (i === 3 ? s.generation === previousGeneration : s.generation > previousGeneration), 'owner generation');
    previousGeneration = s.generation;
    check(['sessionId', 'bootEpoch'].every(key => identifier(s[key])) && identifier(event.turnId) && sessionEqual(s, call.request.session) && sessionEqual(s, event) &&
      call.result.turnId === event.turnId && event.type === 'final', 'final host provenance');
    check(!sessions.has(s.sessionId) && !turns.has(event.turnId), 'fresh independent sessions/turns');
    sessions.add(s.sessionId); turns.add(event.turnId);
    check(call.runtime.adapterId === (expectedOwner === DSH ? 'dsh-typert-v1' : 'openai-compatible-v1'), 'upstream adapter dispatch');
    check(turn.answer?.author === expectedOwner && timestamp(turn.answer.at) && (!requireLive || turn.answer.visible === true) &&
      typeof event.data?.text === 'string' && event.data.text.trim() && event.data.text === turn.answer.text, 'visible attributed answer');
    check(!texts.has(event.data.text.trim()), 'distinct independent answers'); texts.add(event.data.text.trim());
  }
  check(sessionEqual(stale.request.session, route(bundle.turns[2].session, '/agent/session').result.session), 'rejected session must have executed before restart');
  const lock = route(g.lockInstall, '/addons/install', true, fresh.bootEpoch);
  check(lock.request.addonId === B && lock.declaration.systemSlots.find(slot => slot.id === 'primary-agent')?.replaceable === false, 'nonreplaceable incumbent declaration');
  const lockOwner = route(g.lockAssign, '/addons/slots/assign', true, fresh.bootEpoch).result.slots['primary-agent'];
  check(lockOwner.addonId === B, 'locked owner assignment');
  const replacement = route(g.replacement, '/addons/slots/assign', false, fresh.bootEpoch);
  check(replacement.request.addonId === DSH && replacement.request.replace === true && replacement.request.expectedGeneration === lockOwner.generation &&
    replacement.error.code === 'ownership-conflict' && same(replacement.projection.slots['primary-agent'], lockOwner), 'incumbent refuses replacement');
  for (const [name, capability] of [['degrade', 'providers'], ['hardStop', 'network']]) {
    const proof = g[name];
    check(proof, 'missing revocation receipt');
    const call = route(proof.invocation, '/agent/turn', true, fresh.bootEpoch);
    const grant = route(proof.revocation, '/addons/grants', true, fresh.bootEpoch);
    const session = call.request.session;
    check(session.addonId === B && grant.request.addonId === B && proof.upstreamAccepted === true, 'revocation after accepted dispatch');
    const dispatch = get(proof.dispatched, 'adapter-dispatch', fresh.bootEpoch);
    const aborted = get(proof.aborted, 'adapter-abort', fresh.bootEpoch);
    check(dispatch.addonId === B && dispatch.generation === session.generation &&
      dispatch.adapterId === 'openai-compatible-v1' && sessionEqual(dispatch.session, session) &&
      dispatch.turnId === call.result.turnId && sessionEqual(aborted.session, session) && aborted.turnId === call.result.turnId && aborted.dispatchId === dispatch.dispatchId &&
      aborted.addonId === B && aborted.generation === session.generation && aborted.receiptSequence > dispatch.receiptSequence &&
      aborted.receiptSequence <= grant.receiptSequence, 'signed dispatch and dependent abort');
    const revoked = grant.result.installations[B].grantedCapabilities.find(item => item.capability === capability);
    check(revoked?.granted === false && revoked.revocationBehavior === (name === 'degrade' ? 'degrade' : 'hard-stop'), 'declared revocation effect');
    const rejected = route(proof.rejected, '/agent/turn', false, fresh.bootEpoch);
    check(sessionEqual(rejected.request.session, session), 'revoked session identity');
    const relevant = fresh.receipts.filter(r => r.kind === 'event' && r.event.turnId === call.result.turnId);
    check(!relevant.some(r => ['delta', 'final'].includes(r.event.type)), 'no late revoked output');
    if (name === 'degrade') {
      check(relevant.some(r => r.event.type === 'cancelled') && rejected.error.code === 'permission-denied' &&
        grant.result.slots['primary-agent'].generation === session.generation, 'degrade cancels dependent work only');
      const history = route(proof.history, '/agent/history', true, fresh.bootEpoch);
      const status = route(proof.status, '/agent/status', true, fresh.bootEpoch);
      check(sessionEqual(history.request.session, session) && sessionEqual(status.request.session, session) &&
        !grant.result.installations[B].disabledOperations.includes('history') && !grant.result.installations[B].disabledOperations.includes('status'), 'unrelated operations survive degrade');
      check(!fresh.receipts.some(r => r.kind === 'stream-closed' && sessionEqual(r.session, session) && r.receiptSequence < history.receiptSequence), 'degrade keeps stream open');
    } else {
      check(rejected.error.code === 'session-not-found' && grant.result.slots['primary-agent'].generation > session.generation &&
        sessionEqual(get(proof.closed, 'stream-closed', fresh.bootEpoch).session, session) && get(proof.closed, 'stream-closed').receiptSequence > call.receiptSequence, 'hard-stop closes stream and fences session');
    }
  }
  const removal = route(g.removal, '/addons/remove', false, fresh.bootEpoch);
  check(removal.request.addonId === B && removal.error.code === 'ownership-conflict' && removal.projection.installations[B].installed &&
    removal.projection.slots['primary-agent'].addonId === B, 'active owner removal refusal');
  return true;
}

export async function externalEvidenceDirectory(input) {
  if (!input || !path.isAbsolute(input)) throw new Error('Pass an absolute evidence directory outside the repository.');
  const target = path.resolve(input);
  let ancestor = target;
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
  }
  const repository = await realpath(ROOT);
  if (ancestor === repository || ancestor.startsWith(`${repository}${path.sep}`)) throw new Error('Evidence must be outside the repository.');
  await mkdir(target, { mode: 0o700 });
  return realpath(target);
}
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Demo did not observe ${label}. No live certification was produced.`);
}

async function demoManifests(bindings = []) {
  const dsh = JSON.parse(await readFile(new URL('../browser-first/host/harness-examples/deepseek-harness.json', import.meta.url)));
  const first = JSON.parse(await readFile(new URL('../examples/addons/openai-compatible-harness.json', import.meta.url)));
  const second = structuredClone(first);
  second.id = B; second.name = second.agentRuntime.chatAuthorLabel = 'Second Compatible Harness';
  second.agentRuntime.endpoint = 'http://127.0.0.1:8001'; second.agentRuntime.credentialBinding = 'openai.second';
  // Invocation-only dependency: degrading providers must preserve history/status.
  second.requestedCapabilities.push({ capability: 'providers', granted: false, scope: 'system', revocationBehavior: 'degrade' });
  second.tools.find(tool => tool.name === second.agentRuntime.invocationTool).requiredCapabilities.push('providers');
  for (const manifest of [dsh, first, second]) {
    const binding = bindings.find(item => item.addonId === manifest.id);
    if (binding) { manifest.agentRuntime.endpoint = binding.endpoint; manifest.agentRuntime.credentialBinding = binding.name; }
  }
  return [dsh, first, second];
}

// Both deterministic tests and the actual browser driver execute this same
// sequence of host transactions. The transport/UI hooks never supply signatures.
async function certification({ fixture, manifests, createHost, connect = async () => ({}), disconnect = async () => {}, models }) {
  const bundle = { version: 2, mode: fixture ? 'fixture' : 'live', startedAt: now(), boots: [], turns: [], governance: {} };
  const g = bundle.governance;
  let host, io, receipts, hold = false, dispatched = 0;
  const callbacks = { hold: () => hold, dispatched: () => { dispatched++; } };
  const latest = (operation, predicate = () => true) => receipts.findLast(r => r.kind === 'route' && r.operation === operation && predicate(r));
  const invokeBody = session => ({ session, input: { messages: [{ role: 'user', content: 'Write a detailed 2000-word explanation of prime numbers.' }] } });
  async function boot() {
    const bootReceipts = []; receipts = bootReceipts;
    host = await createHost({ onReceipt: r => bootReceipts.push(r), callbacks });
    bundle.boots.push({ bootEpoch: host.registry.snapshot().bootEpoch, signer: host.signer, receipts });
    io = await connect(host, bundle.boots.length);
  }
  async function call(operation, payload = {}, ok = true) {
    const result = io.request ? await io.request(operation, payload) : await directRequest(host, operation, payload);
    const r = latest(operation);
    assert(r && r.ok === ok, `Unexpected ${operation} outcome`);
    if (ok) assert(!result.code, `Failed ${operation}`);
    return r;
  }
  const snapshot = () => host.registry.snapshot();
  const grants = (manifest, revoke) => call('/addons/grants', { addonId: manifest.id, consent: true, expectedRevision: snapshot().revision,
    grants: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: grant.capability !== revoke })) });
  const select = manifest => call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id,
    expectedGeneration: snapshot().slots['primary-agent']?.generation ?? 0, replace: !!snapshot().slots['primary-agent']?.addonId });
  async function openStream(session) {
    if (io.subscribe) return io.subscribe(session);
    const subscription = await host.harnessRoutes.find(r => r.path === '/agent/events').handler({}, { url: `/agent/events?${new URLSearchParams(session)}` });
    const done = (async () => { for await (const event of subscription.events) { void event; } })();
    return { done, close: () => subscription.close() };
  }
  async function answer(manifest, index) {
    if (snapshot().slots['primary-agent']?.addonId !== manifest.id) await select(manifest);
    const prompt = `Reply with one short sentence about ${['seven', 'oceans', 'mountains', 'stars', 'forests', 'rivers'][index]}. Include the word ${['seven', 'ocean', 'mountain', 'star', 'forest', 'river'][index]}.`;
    const prior = receipts.length;
    let observation;
    if (io.answer) observation = await io.answer(manifest, prompt, () => receipts.slice(prior).find(r => r.kind === 'event' && r.event.type === 'final')?.event);
    else {
      const session = (await call('/agent/session', { addonId: manifest.id })).result.session;
      await call('/agent/turn', { session, input: { messages: [{ role: 'user', content: prompt }], ...(models[manifest.id] ? { model: models[manifest.id] } : {}) } });
      const stream = await openStream(session);
      const final = await until(() => receipts.slice(prior).find(r => r.kind === 'event' && r.event.type === 'final'), 'independent final', 150000);
      observation = { author: manifest.id, text: final.event.data.text, visible: false, at: now() };
      await stream.close(); await stream.done;
    }
    const invocation = receipts.slice(prior).find(r => r.operation === '/agent/turn' && r.ok);
    const session = latest('/agent/session', r => r.result?.session?.sessionId === invocation?.request.session.sessionId);
    const final = receipts.slice(prior).find(r => r.kind === 'event' && r.event.turnId === invocation?.result.turnId && r.event.type === 'final');
    assert(session && invocation && final, 'Host must issue session, dispatch and final receipts');
    bundle.turns.push({ session: ref(session), invocation: ref(invocation), final: ref(final), answer: observation });
  }
  try {
    await boot();
    g.installations = [];
    for (const manifest of manifests) {
      g.installations.push(ref(await call('/addons/install', { manifest, enabled: true })));
      if (manifest.id === DSH) g.denied = ref(await call('/addons/slots/assign', { slot: 'primary-agent', addonId: DSH, expectedGeneration: 0 }, false));
      await grants(manifest);
      if (manifest.id === DSH) await call('/addons/slots/assign', { slot: 'chat-interface', addonId: DSH, expectedGeneration: 0 });
    }
    for (let i = 0; i < 3; i++) await answer(manifests[i], i);
    g.beforeRestart = ref(await call('/addons/registry'));
    const oldSession = latest('/agent/session').result.session;
    await disconnect(); await host.close();
    await boot();
    g.staleSession = ref(await call('/agent/turn', invokeBody(oldSession), false));
    g.staleEvents = ref(await call('/agent/events', oldSession, false));
    for (const [i, manifest] of [manifests[2], manifests[0], manifests[1]].entries()) await answer(manifest, i + 3);
    const locked = structuredClone(manifests[2]);
    locked.systemSlots.find(slot => slot.id === 'primary-agent').replaceable = false;
    g.lockInstall = ref(await call('/addons/install', { manifest: locked, enabled: true }));
    await grants(locked); g.lockAssign = ref(await select(locked));
    g.replacement = ref(await call('/addons/slots/assign', { slot: 'primary-agent', addonId: DSH,
      expectedGeneration: snapshot().slots['primary-agent'].generation, replace: true }, false));
    for (const [name, capability] of [['degrade', 'providers'], ['hardStop', 'network']]) {
      await grants(locked);
      const session = (await call('/agent/session', { addonId: B })).result.session;
      const stream = await openStream(session);
      hold = true;
      const count = dispatched, receiptStart = receipts.length;
      const invocation = await call('/agent/turn', { ...invokeBody(session), input: { ...invokeBody(session).input, model: models[B] } });
      await until(() => dispatched > count, 'accepted policy dispatch', 150000);
      assert(!receipts.some(r => r.kind === 'event' && r.event.turnId === invocation.result.turnId && r.event.type === 'final'), 'Turn finished before revocation; rerun for mid-response proof.');
      const revocation = await grants(locked, capability);
      const dispatch = receipts.slice(receiptStart).find(r => r.kind === 'adapter-dispatch');
      const aborted = receipts.slice(receiptStart).find(r => r.kind === 'adapter-abort' && r.dispatchId === dispatch?.dispatchId);
      assert(dispatch && aborted, 'Host must observe dispatch and abort');
      const proof = g[name] = { invocation: ref(invocation), revocation: ref(revocation), dispatched: ref(dispatch), aborted: ref(aborted), upstreamAccepted: true };
      proof.rejected = ref(await call('/agent/turn', invokeBody(session), false));
      if (name === 'degrade') {
        await until(() => receipts.some(r => r.kind === 'event' && r.event.turnId === invocation.result.turnId && r.event.type === 'cancelled'), 'dependent cancellation');
        proof.history = ref(await call('/agent/history', { session }));
        proof.status = ref(await call('/agent/status', { session }));
      } else {
        await stream.done;
        proof.closed = ref(await until(() => receipts.find(r => r.kind === 'stream-closed' && r.session.sessionId === session.sessionId), 'hard-stop stream closure'));
      }
      await stream.close(); await stream.done; hold = false;
    }
    g.removal = ref(await call('/addons/remove', { addonId: B }, false));
    bundle.finishedAt = now();
    verifyEvidence(bundle, { requireLive: !fixture });
    return bundle;
  } finally { await disconnect(); await host?.close(); }
}

async function directRequest(host, operation, payload) {
  const route = host.harnessRoutes.find(r => r.path === operation);
  try { return await route.handler(operation === '/agent/events' ? {} : payload,
    { url: operation === '/agent/events' ? `${operation}?${new URLSearchParams(payload)}` : operation }); }
  catch (error) { return { code: error.code }; }
}

async function fixtureComposition(manifests) {
  const bindings = manifests.map((m, i) => ({ name: m.agentRuntime.credentialBinding, addonId: m.id, adapterId: m.agentRuntime.adapterId,
    authScheme: m.agentRuntime.authScheme, endpoint: m.agentRuntime.endpoint, source: { env: `HARNESS_FIXTURE_${i}` } }));
  const env = Object.fromEntries(bindings.map((b, i) => [b.source.env, `public-fixture-credential-${i}`]));
  env.RESONANTOS_HARNESS_DEMO = '1';
  let stored = null, reply = 0;
  return ({ onReceipt, callbacks }, store) => {
    const dispatches = new Map(), readers = new Set();
    const observe = receipt => {
      if (receipt.kind === 'adapter-dispatch') dispatches.set(receipt.addonId, receipt.session?.sessionId);
      if (receipt.operation === '/agent/events' && receipt.ok) readers.add(receipt.request.sessionId);
      if (receipt.kind === 'stream-closed') readers.delete(receipt.session.sessionId);
      onReceipt(receipt);
    };
    // The normal UI registers its turn before opening SSE. Only fixture output
    // waits for that real subscription; no sleeps or runtime policy changes.
    const ready = addonId => until(() => readers.has(dispatches.get(addonId)), 'fixture event subscription');
    return createHarnessHostService({ store: store ?? { read: async () => stored, write: async value => { stored = structuredClone(value); } },
      bindings, env, fixtureSigningKey: FIXTURE_PRIVATE_KEY, onReceipt: observe,
      transportFactory: async () => ({ dispose() {} }),
      dshAdapterFactory: () => ({ createSession: async () => ({}), history: async () => ({ messages: [] }), status: async () => ({ status: 'idle' }),
        async *invoke() { await ready(DSH); callbacks.dispatched(); yield { type: 'final', data: { text: `Fixture DSH reply ${++reply}` } }; }, cancel() {}, dispose() {} }),
      openaiAdapterFactory: options => createOpenAICompatibleAdapter({ ...options, fetchImpl: async (_url, init) => {
        await ready(options.addonId); callbacks.dispatched();
        const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `Fixture ${options.addonId} reply ${++reply}` } }] })}\n\ndata: [DONE]\n\n`);
        return new Response(new ReadableStream({ start(controller) {
          if (callbacks.hold()) init.signal.addEventListener('abort', () => { try { controller.close(); } catch { /* Already released. */ } }, { once: true });
          else { controller.enqueue(bytes); controller.close(); }
        }, cancel() {} }), { headers: { 'content-type': 'text/event-stream' } });
      } }),
    });
  };
}

/** Full host/registry/2G-adapter fixture certification, no sockets or browser needed. */
export async function runFixtureCertification() {
  const manifests = await demoManifests();
  return certification({ fixture: true, manifests, createHost: await fixtureComposition(manifests), models: { [A]: 'fixture-a', [B]: 'fixture-b' } });
}

/** Actual React shell, authenticated bridge, persisted external registry and reload. */
export async function runDemo({ evidenceDir, fixture = false, headed = false } = {}) {
  const output = await externalEvidenceDirectory(evidenceDir);
  const bindings = fixture ? [] : JSON.parse(process.env.RESONANTOS_HARNESS_BINDINGS ?? '[]');
  const manifests = await demoManifests(bindings);
  const modelNames = fixture ? ['fixture-a', 'fixture-b'] : JSON.parse(process.env.RESONANTOS_COMPATIBLE_MODELS ?? '[]');
  assert(modelNames.length === 2 && modelNames.every(identifier), 'Set RESONANTOS_COMPATIBLE_MODELS to two real endpoint model names.');
  const models = { [A]: modelNames[0], [B]: modelNames[1] };
  if (!fixture) for (const manifest of manifests) assert(bindings.some(binding => binding.addonId === manifest.id), `Approve the ${manifest.id} binding first.`);
  const { createHarnessRegistryStore } = await import('../browser-first/host/harness-registry-store.mjs');
  const { createHarnessTransport } = await import('../browser-first/host/harness-transport.mjs');
  const { startBridgeServer, createBridgeToken } = await import('../browser-first/host/bridge-server.mjs');
  const { devBridgeConfigPlugin, EXPECTED_DEV_SERVER_FS_DENY } = await import('./vite-dev-bridge-config.mjs');
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const { chromium } = await import('playwright');
  const store = createHarnessRegistryStore({ userRoot: path.join(output, 'user') });
  const makeFixtureHost = fixture ? await fixtureComposition(manifests) : null;
  let server, vite, browser, page, bridgeConfig, bridgeToken, capabilities;
  const origin = 'http://127.0.0.1:1430';
  const stopServer = async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined; } };
  try {
    const result = await certification({ fixture, manifests, models,
      createHost: options => fixture ? makeFixtureHost(options, store) : createHarnessHostService({ store, bindings, onReceipt: options.onReceipt,
        env: { ...process.env, RESONANTOS_HARNESS_DEMO: '1' },
        transportFactory: async config => {
          const transport = await createHarnessTransport(config);
          return { ...transport, async request(route, args) {
            const response = await transport.request(route, args);
            if (route === '/api/session/prompt' && response.body?.result?.value?.accepted) options.callbacks.dispatched();
            return response;
          } };
        },
        openaiAdapterFactory: config => createOpenAICompatibleAdapter({ ...config, fetchImpl: async (...args) => {
          const response = await fetch(...args); if (response.ok) options.callbacks.dispatched(); return response;
        } }),
      }),
      disconnect: stopServer,
      connect: async (host, bootNumber) => {
        bridgeToken = createBridgeToken();
        const capabilityBootstrapToken = createBridgeToken();
        capabilities = Object.fromEntries(['addon-runtime-read', 'addon-runtime-control', 'provider-diagnostics-read', 'provider-model-invoke', 'provider-credential-write', 'provider-routing-write'].map(key => [key, createBridgeToken()]));
        // Model choice is host-side, before the first compatible invocation.
        const routes = host.harnessRoutes.map(route => route.path !== '/agent/session' ? route : { ...route, async handler(payload, request) {
          const result = await route.handler(payload, request);
          if (models[payload.addonId]) await host.harnessRoutes.find(r => r.path === '/agent/select-model').handler({ session: result.session, model: { provider: 'local', model: models[payload.addonId] } });
          return result;
        } });
        server = await startBridgeServer({ port: 0, host: '127.0.0.1', bridgeToken, capabilityBootstrapToken, bridgeCapabilityTokens: capabilities,
          routes, allowedOrigins: [origin], openPathPrefixes: [] });
        bridgeConfig = { bridgeUrl: `http://127.0.0.1:${server.address().port}`, bridgeToken, capabilityBootstrapToken };
        if (!vite) {
          const pageKey = randomBytes(32).toString('base64url');
          vite = await createServer({ configFile: false, root: ROOT, mode: 'harness-demo', cacheDir: path.join(output, 'vite-cache'),
            plugins: [devBridgeConfigPlugin({ env: () => ({ RESONANTOS_DEV_BRIDGE_CONFIG: '1', RESONANTOS_DEV_BRIDGE_PAGE_KEY: pageKey }), readConfig: async () => bridgeConfig, expectedPort: 1430 }), react()],
            server: { host: '127.0.0.1', port: 1430, strictPort: true, allowedHosts: ['127.0.0.1'], cors: false,
              fs: { strict: true, deny: [...EXPECTED_DEV_SERVER_FS_DENY] }, watch: { ignored: ['**/bridge-config.generated.js', '**/ResonantOS_User/**', '**/.rig-in/**'] } } });
          await vite.listen();
          browser = await chromium.launch({ headless: !headed });
          const context = await browser.newContext({ httpCredentials: { username: 'dev', password: pageKey }, viewport: { width: 1600, height: 1000 } });
          page = await context.newPage(); page.setDefaultTimeout(30000);
          await page.goto(origin);
          await page.getByRole('button', { name: 'Choose Add-ons Manually', exact: true }).click();
        } else await page.reload();
        const headers = capability => ({ 'content-type': 'application/json', 'X-ResonantOS-Bridge-Token': bridgeToken, 'X-ResonantOS-Bridge-Capability-Token': capabilities[capability] });
        return {
          async request(operation, payload) {
            const get = ['/addons/registry', '/agent/events'].includes(operation);
            const url = `${bridgeConfig.bridgeUrl}${operation}${operation === '/agent/events' ? `?${new URLSearchParams(payload)}` : ''}`;
            const response = await fetch(url, { method: get ? 'GET' : 'POST', headers: headers(get ? 'addon-runtime-read' : 'addon-runtime-control'), ...(get ? {} : { body: JSON.stringify(payload) }) });
            return response.json();
          },
          async subscribe(session) {
            const controller = new AbortController();
            const response = await fetch(`${bridgeConfig.bridgeUrl}/agent/events?${new URLSearchParams(session)}`, { headers: headers('addon-runtime-read'), signal: controller.signal });
            assert.equal(response.status, 200);
            const done = (async () => { try { for await (const chunk of response.body) { void chunk; } } catch (error) { if (!controller.signal.aborted) throw error; } })();
            return { done, close: async () => { controller.abort(); await done; } };
          },
          async answer(manifest, prompt, completed) {
            await page.getByRole('button', { name: /Add-ons/ }).first().click();
            await page.getByRole('button', { name: 'Refresh harnesses' }).click();
            await page.getByText(`Current owner: ${manifest.id === DSH ? manifest.name : manifest.id} · Available`, { exact: true }).waitFor();
            // Imported examples are installed through authenticated host transactions;
            // the current host owner, including its id, must reach the normal chat UI.
            const composer = page.locator('textarea[placeholder^="Message "]');
            if (!(await composer.isVisible())) await page.getByRole('button', { name: 'Chat', exact: true }).click();
            const prior = await page.locator('article.message-bubble.assistant').count();
            await composer.fill(prompt); await page.getByRole('button', { name: 'Send message', exact: true }).click();
            await until(async () => await page.locator('article.message-bubble.assistant').count() > prior, 'visible answer', 150000);
            const final = await until(completed, 'host final reply', 150000);
            const message = page.locator('article.message-bubble.assistant').filter({ hasText: final.data.text }).last();
            await message.waitFor();
            assert((await message.innerText()).includes(manifest.id), 'UI answer must name the host owner');
            await page.screenshot({ path: path.join(output, `reply-${bootNumber}-${manifest.id}.png`), fullPage: true });
            return { author: manifest.id, text: final.data.text, visible: true, at: now() };
          },
        };
      },
    });
    await page.screenshot({ path: path.join(output, 'governance.png'), fullPage: true });
    await writeFile(path.join(output, 'evidence.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return result;
  } finally { await browser?.close(); await vite?.close(); await stopServer(); await rm(path.join(output, 'vite-cache'), { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--verify') {
      assert(args.length === 2 || (args.length === 3 && args[2] === '--fixture'), 'Usage: --verify evidence.json [--fixture]');
      verifyEvidence(JSON.parse(await readFile(args[1], 'utf8')), { requireLive: !args.includes('--fixture') });
      console.log(args.includes('--fixture') ? 'Fixture evidence verified; not live proof.' : 'Host-signed evidence verified.');
      console.log(SIGNATURE_LIMITATION);
    } else {
      const positional = args.filter(arg => !arg.startsWith('--'));
      assert(positional.length === 1 && args.every(arg => !arg.startsWith('--') || ['--fixture', '--headed'].includes(arg)),
        'Usage: node scripts/harness-swap-demo.mjs /absolute/external/evidence-directory [--fixture] [--headed]');
      const result = await runDemo({ evidenceDir: positional[0], fixture: args.includes('--fixture'), headed: args.includes('--headed') });
      console.log(`${result.mode} evidence written outside the repository.`);
    }
  } catch (error) {
    console.error(`Harness demo failed (${error?.code ?? error?.name ?? 'Error'}). No live certification.`);
    if (error?.name === 'AssertionError' || /^Invalid demo evidence:|^Pass an absolute|^Evidence must|^Usage:|^Demo did not observe/.test(error?.message)) console.error(error.message);
    process.exitCode = 1;
  }
}
