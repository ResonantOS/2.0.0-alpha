import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProviderBridgeService } from '../host/provider-bridge-service.mjs';
import { createProviderHostService } from '../host/provider-host-service.mjs';
import { createHarnessRegistry } from '../host/harness-registry.mjs';
import { createHarnessBoundary } from '../host/harness-boundary.mjs';
import { validateAddOnManifest } from '../../packages/addon-sdk/src/validation.ts';
import { validateHarnessEvent } from '../host/harness-adapter-contract.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const input = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }] };
const example = async name => JSON.parse(await readFile(new URL(`../host/harness-examples/${name}.json`, import.meta.url)));
async function service(t, { host = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (host) t.mock.method(os, 'homedir', () => root);
  const svc = host ? createProviderHostService({ redactDiagnosticText: String, extractJsonObject: JSON.parse }) : createProviderBridgeService({
    ...Object.fromEntries(['providerSecretsPath', 'providerAccountsPath', 'providerRoutingPath', 'providerModelPreferencesPath', 'providerDiagnosticsHistoryPath'].map(name => [name, () => path.join(root, name)])),
    redactDiagnosticText: value => String(value ?? ''), unique: values => [...new Set(values.filter(Boolean))], extractJsonObject: JSON.parse,
  });
  await svc.executeProviderCredentialSave({ providerId: 'shared-openai', credential: 'test-only-placeholder' });
  await svc.executeProviderCredentialSave({ providerId: 'shared-minimax', credential: 'test-only-placeholder' });
  await svc.executeProviderRoutingStrategySave({ strategyId: 'augmentor-chat', primaryModel: 'gpt-5.5', fallbackModels: ['MiniMax-M3'], costPosture: 'quality-first', hardStop: false });
  return svc;
}
async function adapterFor(svc) {
  assert.equal(typeof svc.executeRawProviderChat, 'function', 'raw provider execution must be separate from compatibility dispatch');
  const { createProviderFabricAdapter } = await import('../host/agent-adapters/provider-fabric.mjs');
  return createProviderFabricAdapter({ executeRawProviderChat: svc.executeRawProviderChat });
}
async function governed(t, adapter, owner = 'provider-chat-demo') {
  const manifests = await Promise.all(['deepseek-harness', 'provider-chat-demo'].map(example));
  let state = null;
  const registry = await createHarnessRegistry({
    store: { read: async () => state, write: async value => { state = structuredClone(value); } },
    reviewedAdapterIds: ['provider-fabric-v1', 'dsh-typert-v1'],
    bindings: [{ name: 'dsh.main', addonId: 'addon.deepseek-harness', adapterId: 'dsh-typert-v1', authScheme: 'dsh-action-token', endpoint: 'http://127.0.0.1:3080' }],
  });
  for (const manifest of manifests) {
    await registry.install(manifest, { enabled: true });
    await registry.setGrants(manifest.id, manifest.requestedCapabilities.filter(g => g.capability !== 'agent-delegation').map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: registry.snapshot().revision });
    assert.equal(registry.snapshot().installations[manifest.id].grantedCapabilities.find(g => g.capability === 'agent-delegation').granted, false);
  }
  await registry.assignSlot('primary-agent', `addon.${owner}`, { expectedGeneration: 0 });
  let dshCalls = 0;
  const fakeDsh = {
    createSession: async () => ({}),
    invoke: async function* () { dshCalls++; yield { type: 'final', data: { text: 'fake DSH answer' } }; },
    cancel: async () => {}, dispose: async () => {},
  };
  const boundary = createHarnessBoundary({ registry, resolveAdapter: ({ runtime }) => runtime.adapterId === 'dsh-typert-v1' ? fakeDsh : adapter });
  t.after(() => boundary.close());
  return { registry, boundary, dshCalls: () => dshCalls };
}
async function invoke(f, addonId, payload = input) {
  const ref = await f.boundary.createSession({ addonId });
  const events = f.boundary.events(ref);
  const turn = f.boundary.invoke(ref, payload);
  await turn.completion;
  const event = (await events.next()).value;
  await events.return();
  assert.equal(validateHarnessEvent(event), true);
  return { ref, event };
}

test('selected owner dispatches once without denial fallback', async t => {
  const svc = await service(t), adapter = await adapterFor(svc);
  let rawCalls = 0, fetchCalls = 0;
  const counted = await adapterFor({ executeRawProviderChat: (...args) => { rawCalls++; return svc.executeRawProviderChat(...args); } });
  t.mock.method(globalThis, 'fetch', async () => { fetchCalls++; return Response.json({ choices: [{ message: { content: 'provider answer' } }] }); });
  const f = await governed(t, counted, 'deepseek-harness');
  const dsh = await invoke(f, 'addon.deepseek-harness');
  assert.equal(dsh.event.data.text, 'fake DSH answer');
  assert.deepEqual([f.dshCalls(), rawCalls, fetchCalls], [1, 0, 0]);
  await f.registry.assignSlot('primary-agent', 'addon.provider-chat-demo', { expectedGeneration: 1, replace: true });
  const provider = await invoke(f, 'addon.provider-chat-demo');
  assert.equal(provider.event.data.text, 'provider answer');
  assert.deepEqual([f.dshCalls(), rawCalls, fetchCalls], [1, 1, 1]);
  await f.registry.assignSlot('primary-agent', 'addon.provider-chat-demo', { expectedGeneration: 2, replace: true });
  assert.throws(() => f.boundary.invoke(provider.ref, input), { code: 'session-not-found' });
  assert.throws(() => f.boundary.invoke(dsh.ref, input), { code: 'session-not-found' });
  await assert.rejects(f.boundary.createSession({ addonId: 'addon.deepseek-harness' }), { code: 'permission-denied' });
  assert.deepEqual([f.dshCalls(), rawCalls, fetchCalls], [1, 1, 1], 'revoked owner must call neither adapter nor provider');
  assert.equal((await adapter.probe()).available, true);
});

test('provider denial and transport failure never fall back to compatibility chat', async t => {
  const svc = await service(t), adapter = await adapterFor(svc);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; if (calls === 2) throw new Error('private-transport-canary'); return Response.json({ error: { message: 'private-upstream-canary' } }, { status: 403 }); });
  const f = await governed(t, adapter);
  const { event } = await invoke(f, 'addon.provider-chat-demo', { ...input, model: '__auto__' });
  assert.equal(calls, 1, 'a failed raw attempt must not execute a fallback provider');
  assert.deepEqual(event.data, { code: 'runtime-unavailable', message: 'Runtime unavailable.' });
  const transport = await invoke(f, 'addon.provider-chat-demo', { ...input, model: '__auto__' });
  assert.equal(calls, 2, 'transport failure must not retry');
  assert.deepEqual(transport.event.data, { code: 'runtime-unavailable', message: 'Runtime unavailable.' });
  let denials = 0;
  const denied = await governed(t, await adapterFor({ executeRawProviderChat: async () => { denials++; throw Object.assign(new Error('private-denial'), { code: 'permission-denied' }); } }));
  const result = await invoke(denied, 'addon.provider-chat-demo');
  assert.deepEqual(result.event.data, { code: 'permission-denied', message: 'Runtime permission denied.' });
  assert.equal(denials, 1, 'denial must not retry raw provider chat');
  assert.equal(calls, 2, 'denial must not call compatibility provider chat');
});

for (const phase of ['fetch', 'body']) test(`provider cancellation aborts ${phase} and releases body readers`, async t => {
  const svc = await service(t), adapter = await adapterFor(svc);
  const entered = deferred();
  let signal, body, reads = 0, cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    if (phase === 'fetch') return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { cancelled = true; reject(init.signal.reason); }, { once: true });
      entered.resolve();
    });
    body = new ReadableStream({ pull() { reads++; entered.resolve(); }, cancel() { cancelled = true; } });
    return new Response(body);
  });
  const session = await adapter.createSession({});
  const controller = new AbortController();
  const iterator = adapter.invoke({ session, input, signal: controller.signal });
  const pending = iterator.next();
  await entered.promise;
  await adapter.cancel({ session });
  assert.equal(signal.aborted, true, 'cancel must propagate to fetch signal');
  assert.equal(cancelled, true, 'cancel must reach the pending request or body reader');
  const event = (await pending).value;
  assert.equal(event.type, 'cancelled');
  if (body) {
    assert.equal(body.locked, false, 'aborted body reader must release its lock');
    assert.equal(reads, 1, 'aborted body must not keep reading');
  }
  await adapter.dispose({ session });
});

test('boundary revocation aborts an in-flight provider body', async t => {
  const svc = await service(t), adapter = await adapterFor(svc), entered = deferred();
  let signal, body, cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    body = new ReadableStream({ pull() { entered.resolve(); }, cancel() { cancelled = true; } });
    return new Response(body);
  });
  const f = await governed(t, adapter), ref = await f.boundary.createSession({ addonId: 'addon.provider-chat-demo' });
  const events = f.boundary.events(ref), turn = f.boundary.invoke(ref, input);
  await entered.promise;
  await f.registry.assignSlot('primary-agent', 'addon.provider-chat-demo', { expectedGeneration: 1, replace: true });
  await turn.completion;
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal((await events.next()).value.data.code, 'ownership-conflict');
});

test('provider output passes bounded event validation and fixed error filtering', async t => {
  const svc = await service(t), adapter = await adapterFor(svc);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'x'.repeat(65_537) } }] }));
  const f = await governed(t, adapter);
  const { event } = await invoke(f, 'addon.provider-chat-demo');
  assert.equal(event.type, 'error');
  assert.deepEqual(event.data, { code: 'invalid-event', message: 'Invalid runtime event.' });
});

test('host factory executes one raw attempt while compatibility chat retains fallback', async t => {
  const svc = await service(t, { host: true });
  assert.equal(typeof svc.createHarnessAdapter, 'function', 'host must expose a provider harness adapter factory');
  const adapter = svc.createHarnessAdapter();
  for (const method of ['probe', 'createSession', 'invoke', 'cancel', 'dispose']) assert.equal(typeof adapter[method], 'function');
  const calls = [];
  let denyPrimary = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    return denyPrimary && model === 'gpt-5.5'
      ? Response.json({ error: { message: 'private-denial-canary' } }, { status: 403 })
      : Response.json({ choices: [{ message: { content: `answer from ${model}` } }] });
  });
  const f = await governed(t, adapter);
  const payload = { ...input, model: '__auto__' };
  const success = await invoke(f, 'addon.provider-chat-demo', payload);
  assert.equal(success.event.data.text, 'answer from gpt-5.5');
  assert.deepEqual(calls, ['gpt-5.5']);

  calls.length = 0;
  denyPrimary = true;
  const denied = await invoke(f, 'addon.provider-chat-demo', payload);
  assert.equal(calls.length, 1, 'host factory must not dispatch a fallback provider after denial');
  assert.deepEqual(denied.event.data, { code: 'runtime-unavailable', message: 'Runtime unavailable.' });

  calls.length = 0;
  const compatibility = await svc.executeBridgeChat(payload);
  assert.equal(compatibility.routeFallback, true, 'positive control must exercise the configured compatibility fallback');
  assert.equal(calls.length, 2);
});

test('compatibility route does not interpret bridge request metadata as cancellation options', async t => {
  const svc = await service(t, { host: true });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: 'compatibility answer' } }] });
  });
  const route = svc.providerBridgeRoutes.find(route => route.path === '/augmentor/chat');
  let result;
  await assert.doesNotReject(async () => {
    result = await route.handler(input, { signal: AbortSignal.abort(), method: 'POST', url: '/augmentor/chat' });
  }, 'bridge request metadata must not become raw provider cancellation options');
  assert.equal(result.reply, 'compatibility answer');
  assert.equal(calls, 1);
});

test('example manifests validate and reject paths, unreviewed adapters and unapproved bindings', async () => {
  const manifests = await Promise.all(['deepseek-harness', 'provider-chat-demo'].map(example));
  assert.deepEqual(manifests[0].agentRuntime.supportedOperations, ['createSession', 'invoke', 'cancel', 'history', 'status', 'selectModel']);
  assert.equal(manifests[0].agentRuntime.adapterId, 'dsh-typert-v1');
  assert.equal(manifests[0].agentRuntime.endpoint, 'http://127.0.0.1:3080');
  assert.equal(manifests[0].agentRuntime.authScheme, 'dsh-action-token');
  assert.equal(manifests[0].agentRuntime.credentialBinding, 'dsh.main');
  assert.equal(manifests[0].agentRuntime.contextRoleFidelity, 'text-only');
  assert.deepEqual(manifests[0].agentRuntime.requiredCapabilities, ['agent-runtime', 'network', 'chat-interface']);
  assert.equal(manifests[1].id, 'addon.provider-chat-demo');
  assert.equal(manifests[1].agentRuntime.adapterId, 'provider-fabric-v1');
  assert.equal(manifests[1].agentRuntime.authScheme, 'none');
  assert.equal(Object.hasOwn(manifests[1].agentRuntime, 'credentialBinding'), false);
  assert.deepEqual(manifests[1].agentRuntime.requiredCapabilities, ['agent-runtime', 'providers', 'chat-interface']);
  for (const manifest of manifests) {
    assert.equal(manifest.agentRuntime.adapterVersion, 1);
    assert.equal(manifest.agentRuntime.toolCallbacks, false);
    const validation = validateAddOnManifest(manifest);
    assert.equal(validation.valid, true, JSON.stringify(validation.issues));
    assert.equal(manifest.requestedCapabilities.every(g => g.granted === false), true);
    assert.equal(manifest.agentRuntime.requiredCapabilities.includes('agent-delegation'), false);
    assert.equal(manifest.requestedCapabilities.some(g => g.capability === 'agent-delegation'), true);
    for (const patch of [{ credentialBinding: '/private/secret-file' }, { importPath: './evil.mjs' }, { headers: { Authorization: 'private-canary' } }]) {
      const invalid = structuredClone(manifest); Object.assign(invalid.agentRuntime, patch);
      assert.equal(validateAddOnManifest(invalid).valid, false);
    }
  }
  const registry = await createHarnessRegistry({ store: { read: async () => null, write: async () => {} }, reviewedAdapterIds: ['provider-fabric-v1', 'dsh-typert-v1'] });
  await registry.install(manifests[1], { enabled: true });
  const unknown = structuredClone(manifests[1]); unknown.agentRuntime.adapterId = 'unreviewed-adapter';
  await assert.rejects(registry.install(unknown, { enabled: true }), { code: 'permission-denied' });
  await assert.rejects(registry.install(manifests[0], { enabled: true }), { code: 'permission-denied' });
});
