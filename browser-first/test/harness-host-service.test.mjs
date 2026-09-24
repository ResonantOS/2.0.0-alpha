import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { evaluateBridgeRequestForSelfTest } from '../host/bridge-server.mjs';
import { createChatTurnController } from '../resonantos-side-panel-extension/src/lib/chat-turn-controller.js';
import { createProviderHostService } from '../host/provider-host-service.mjs';
import { Readable, Writable } from 'node:stream';
import { createBridgeRequestHandler, HarnessTransportError } from '../host/bridge-server.mjs';

const load = async () => {
  const module = await import('../host/harness-host-service.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.createHarnessHostService, 'function', 'harness host composition must exist');
  return module.createHarnessHostService;
};
const example = async name => JSON.parse(await readFile(new URL(`../host/harness-examples/${name}.json`, import.meta.url)));
const input = { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] };
const tokens = { 'addon-runtime-read': 'read-token', 'addon-runtime-control': 'control-token' };
const ref = { addonId: 'addon.provider-chat-demo', sessionId: 'unknown', bootEpoch: 'unknown', generation: 1 };
async function fixture(t, options = {}) {
  const create = await load();
  let stored = null, writes = 0, invokes = 0;
  const host = await create({
    env: {}, store: { read: async () => stored, write: async value => { writes++; stored = structuredClone(value); } },
    providerHost: { executeRawProviderChat: async () => { invokes++; return { reply: 'answer' }; }, executeProviderStatus: async () => ({ providers: [{ configured: true, models: [{ allowed: true }] }] }) },
    ...options,
  });
  t.after(() => host.close());
  const call = (url, body = {}, overrides = {}) => {
    const method = url.startsWith('/addons/registry') || url.startsWith('/agent/events') ? 'GET' : 'POST';
    const route = host.harnessRoutes.find(r => r.path === url.split('?')[0]);
    return evaluateBridgeRequestForSelfTest({ method, url, body, routes: host.harnessRoutes,
      bridgeToken: 'bridge-token', bridgeCapabilityTokens: tokens, listenerPort: 47773,
      headers: { host: '127.0.0.1:47773', 'x-resonantos-bridge-token': 'bridge-token', 'x-resonantos-bridge-capability-token': tokens[route?.requiredCapability] },
      rawHeaders: ['Host', '127.0.0.1:47773'], ...overrides });
  };
  return { host, call, writes: () => writes, invokes: () => invokes, stored: () => stored };
}
async function installed(f, granted = true) {
  const manifest = await example('provider-chat-demo');
  assert.equal((await f.call('/addons/install', { manifest, enabled: true })).status, 200);
  if (granted) {
    assert.equal((await f.call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: true })), consent: true, expectedRevision: f.host.registry.snapshot().revision })).status, 200);
    assert.equal((await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: 0 })).status, 200);
  }
  return manifest;
}
const requests = async () => [
  ['/addons/registry', {}],
  ['/addons/install', { manifest: await example('provider-chat-demo'), enabled: true }],
  ['/addons/grants', { addonId: ref.addonId, grants: [], consent: true, expectedRevision: 0 }],
  ['/addons/enabled', { addonId: ref.addonId, enabled: false, expectedRevision: 0 }],
  ['/addons/remove', { addonId: ref.addonId }],
  ['/addons/slots/assign', { slot: 'primary-agent', addonId: ref.addonId, expectedGeneration: 0 }],
  ['/agent/session', { addonId: ref.addonId }],
  ['/agent/turn', { session: ref, input }],
  ['/agent/dispose', { session: ref }],
  ['/agent/cancel', { session: ref, turnId: 'turn' }],
  [`/agent/events?${new URLSearchParams(ref)}`, {}],
  ['/agent/history', { session: ref }], ['/agent/status', { session: ref }],
  ['/agent/select-model', { session: ref, model: { provider: 'test', model: 'test' } }],
];

test('ordinary add-ons without agentRuntime have a host acknowledgement projection', async t => {
  const manifest = JSON.parse(await readFile(new URL('../../public/addons/browser.json', import.meta.url)));
  assert.equal(manifest.agentRuntime, undefined);
  // Seed a committed host installation to isolate projection from the registry
  // install eligibility change required by 2B-a. This is not a legacy import.
  const f = await fixture(t, { store: {
    read: async () => ({ version: 1, phase: 'committed', state: {
      revision: 1, governanceActivated: false, slots: {},
      installations: { [manifest.id]: {
        manifest, enabled: true,
        grants: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: false })),
      } },
    } }),
    write: async () => {},
  } });
  assert.equal(f.host.registry.snapshot().installations[manifest.id].enabled, true);
  const result = await f.call('/addons/registry');
  assert.equal(result.status, 200, 'ordinary add-ons must be readable through the shared host acknowledgement projection');
  assert.deepEqual(result.payload.installations[manifest.id].supportedOperations, []);
  assert.ok(result.payload.installations[manifest.id].grantedCapabilities.every(grant => !grant.granted));
  const disabled = await f.call('/addons/enabled', { addonId: manifest.id, enabled: false, expectedRevision: 1 });
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.payload.installations[manifest.id].disabledOperations, []);
  const enabled = await f.call('/addons/enabled', { addonId: manifest.id, enabled: true, expectedRevision: 2 });
  assert.equal(enabled.status, 200);
  const granted = await f.call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: true })), consent: true, expectedRevision: 3 });
  assert.equal(granted.status, 200);
  assert.ok(granted.payload.installations[manifest.id].grantedCapabilities.every(g => g.granted));
  assert.equal((await f.call('/addons/remove', { addonId: manifest.id })).status, 200);
  assert.equal((await f.call('/addons/install', { manifest, enabled: false })).status, 200);
});

test('all harness routes enforce transport and add-on authority', async t => {
  const f = await fixture(t);
  for (const [url, body] of await requests()) {
    const route = f.host.harnessRoutes.find(r => r.path === url.split('?')[0]);
    assert.equal(route.loopbackHostOnly, true);
    for (const [label, overrides, status] of [
      ['missing token', { headers: {} }, 401],
      ['wrong token', { headers: { 'x-resonantos-bridge-token': 'wrong' } }, 401],
      ['missing capability', { headers: { host: '127.0.0.1:47773', 'x-resonantos-bridge-token': 'bridge-token' } }, 403],
      ['wrong capability', { headers: { host: '127.0.0.1:47773', 'x-resonantos-bridge-token': 'bridge-token', 'x-resonantos-bridge-capability-token': 'wrong' } }, 403],
      ['invalid Host', { headers: { host: 'evil.test:47773', 'x-resonantos-bridge-token': 'bridge-token', 'x-resonantos-bridge-capability-token': tokens[route.requiredCapability] }, rawHeaders: ['Host', 'evil.test:47773'] }, 403],
    ]) {
      const result = await f.call(url, body, overrides);
      assert.equal(result.status, status, `${url}: ${label}`);
      assert.equal(result.payload.code, 'permission-denied', `${url}: fixed public vocabulary`);
    }
    const malformed = await f.call(url.includes('?') ? `${url}&credential=secret` : url, { ...body, credential: 'secret' });
    // GET registry payloads live in the query, not the request body.
    if (url !== '/addons/registry') assert.equal(malformed.status, 400, `${url}: unknown payload field`);
  }
  assert.equal((await f.call('/addons/registry?credential=secret')).status, 400);
  assert.equal(f.writes(), 0, 'transport or malformed payload denial must never persist');
  assert.equal(f.invokes(), 0);
  const manifest = await installed(f, false);
  const before = f.writes();
  assert.equal((await f.call('/agent/session', { addonId: manifest.id })).payload.code, 'permission-denied');
  assert.equal((await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: 0 })).payload.code, 'permission-denied');
  for (const [url, body] of (await requests()).filter(([url]) => url.startsWith('/agent/') && url !== '/agent/session')) {
    assert.equal((await f.call(url, body)).payload.code, 'session-not-found', url);
  }
  assert.equal(f.writes(), before);
  assert.equal(f.invokes(), 0);
  await f.call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: true })), consent: true, expectedRevision: 1 });
  await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: 0 });
  const sessionResult = await f.call('/agent/session', { addonId: manifest.id });
  assert.equal(sessionResult.status, 200, 'authorized session control');
  const session = sessionResult.payload.session;
  const events = f.host.boundary.events(session);
  const turn = await f.call('/agent/turn', { session, input });
  assert.equal(turn.status, 200);
  assert.equal((await events.next()).value.data.text, 'answer');
  assert.equal(f.invokes(), 1);
  const revocation = await f.call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: false })), consent: true, expectedRevision: f.host.registry.snapshot().revision });
  assert.equal(revocation.status, 200);
  const writes = f.writes();
  for (const [url, body] of (await requests()).filter(([url]) => url.startsWith('/agent/'))) {
    const updated = url.startsWith('/agent/events') ? `/agent/events?${new URLSearchParams(session)}` : url;
    assert.notEqual((await f.call(updated, { ...body, ...(body.session ? { session } : {}) })).status, 200, url);
  }
  assert.equal(f.invokes(), 1, 'revoked routes never dispatch');
  assert.equal(f.writes(), writes);
});

test('demo candidates require host opt-in and never confer bindings or grants', async t => {
  const ordinary = await fixture(t);
  assert.deepEqual((await ordinary.call('/addons/registry')).payload.candidates, []);
  const env = { RESONANTOS_HARNESS_DEMO: '1' };
  const demo = await fixture(t, { env });
  env.RESONANTOS_HARNESS_DEMO = '0';
  const snapshot = (await demo.call('/addons/registry')).payload;
  assert.deepEqual(snapshot.candidates.map(m => m.id).sort(), ['addon.deepseek-harness', 'addon.provider-chat-demo']);
  assert.deepEqual(snapshot.installations, {});
  const manifest = await example('deepseek-harness');
  assert.equal((await demo.call('/addons/install', { manifest, enabled: true })).payload.code, 'permission-denied');
  assert.equal((await demo.call('/addons/install', { manifest, enabled: true, bindings: [{ name: 'dsh.main' }] })).status, 400);
  assert.equal(demo.writes(), 0);
  for (const name of ['index.json', 'dev-index.json']) {
    const catalog = await readFile(new URL(`../../public/addons/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(catalog, /addon\.(?:deepseek-harness|provider-chat-demo)/);
  }
});

test('demo catalog requires exactly the string opt-in in a populated environment', async t => {
  for (const [label, optIn] of [['absent', {}], ['disabled', { RESONANTOS_HARNESS_DEMO: '0' }],
    ['numeric one', { RESONANTOS_HARNESS_DEMO: 1 }], ['enabled', { RESONANTOS_HARNESS_DEMO: '1' }]]) {
    await t.test(label, async t => {
      const env = { HOME: '/x', PATH: '/bin', NODE_ENV: 'test', ...optIn };
      const f = await fixture(t, { env });
      const result = await f.call('/addons/registry');
      assert.equal(result.status, 200);
      assert.deepEqual(result.payload.candidates.map(candidate => candidate.id).sort(),
        label === 'enabled' ? ['addon.deepseek-harness', 'addon.provider-chat-demo'] : [],
        `${label}: unrelated environment keys must not enable demo candidates`);
    });
  }
});

test('provider readiness follows configured usable models without raw dispatch', async t => {
  let providers = [], calls = 0;
  const f = await fixture(t, { providerHost: { executeRawProviderChat: async () => { calls++; }, executeProviderStatus: async () => ({ providers }) } });
  await installed(f);
  for (providers of [[], [{ configured: false, models: [{ allowed: true }] }], [{ configured: true, models: [{ allowed: false }] }]]) {
    assert.equal((await f.call('/agent/session', { addonId: ref.addonId })).payload.code, 'runtime-unavailable');
  }
  providers = [{ configured: true, models: [{ allowed: true }] }];
  assert.equal((await f.call('/agent/session', { addonId: ref.addonId })).status, 200);
  assert.equal(calls, 0);
});

test('shutdown attempts every session and transport cleanup with bounded throwing or slow disposal', async t => {
  const disposals = [], transports = [];
  const f = await fixture(t, { cleanupTimeoutMs: 20,
    bindings: [{ name: 'dsh.main', addonId: 'addon.deepseek-harness', adapterId: 'dsh-typert-v1', authScheme: 'dsh-action-token', endpoint: 'http://127.0.0.1:3080', source: { env: 'DSH_TEST' } }],
    transportFactory: async () => ({ dispose() { transports.push(true); } }),
    dshAdapterFactory: () => ({ createSession: async () => ({}), dispose() { disposals.push(true); if (disposals.length === 1) throw new Error('private-canary'); return new Promise(() => {}); } }),
  });
  const manifest = await example('deepseek-harness');
  await f.call('/addons/install', { manifest, enabled: true });
  await f.call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: true })), consent: true, expectedRevision: 1 });
  await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: 0 });
  for (let i = 0; i < 2; i++) assert.equal((await f.call('/agent/session', { addonId: manifest.id })).status, 200);
  await f.host.close();
  assert.equal(disposals.length, 2);
  assert.equal(transports.length, 2, 'transport cleanup must run even when adapter disposal fails or stalls');
  assert.notEqual((await f.call('/agent/session', { addonId: manifest.id })).status, 200);
});

test('governed compatibility chat cannot bypass the selected owner or revoked grants', async t => {
  let legacy = 0, raw = 0;
  const f = await fixture(t, { providerHost: {
    executeBridgeChat: async () => { legacy++; return { reply: 'legacy' }; },
    executeRawProviderChat: async () => { raw++; return { reply: 'governed' }; },
    executeProviderStatus: async () => ({ providers: [{ configured: true, models: [{ allowed: true }] }] }),
  } });
  assert.equal(typeof f.host.executeBridgeChat, 'function', 'composition must govern the compatibility facade');
  assert.equal((await f.host.executeBridgeChat(input)).reply, 'legacy');
  await installed(f);
  assert.equal((await f.host.executeBridgeChat(input)).reply, 'governed');
  assert.equal(legacy, 1);
  assert.equal(raw, 1);
  await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: null, expectedGeneration: 1, replace: true });
  await assert.rejects(f.host.executeBridgeChat(input), { code: 'permission-denied' });
  assert.equal(legacy, 1);
  assert.equal(raw, 1);
});

test('governed compatibility turn errors never retry or fall back to the legacy provider', async t => {
  const manifest = await example('deepseek-harness');
  const legacy = t.mock.fn(async () => ({ reply: 'legacy fallback' }));
  const invoke = t.mock.fn(async function* () {
    yield { type: 'delta', data: { text: 'partial answer' } };
    yield { type: 'error', data: { code: 'deadline-exceeded' } };
  });
  const f = await fixture(t, {
    providerHost: { executeBridgeChat: legacy },
    bindings: [{ name: 'dsh.main', addonId: manifest.id, adapterId: 'dsh-typert-v1', authScheme: 'dsh-action-token', endpoint: manifest.agentRuntime.endpoint, source: { env: 'DSH_TEST' } }],
    transportFactory: async () => ({ dispose() {} }),
    dshAdapterFactory: () => ({ createSession: async () => ({}), invoke, dispose() {} }),
  });
  assert.equal((await f.call('/addons/install', { manifest, enabled: true })).status, 200);
  assert.equal((await f.call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: true })), consent: true, expectedRevision: 1 })).status, 200);
  assert.equal((await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: 0 })).status, 200);
  await assert.rejects(f.host.executeBridgeChat(input), error => {
    assert.ok(error instanceof HarnessTransportError, 'turn failure must retain its harness error type');
    assert.equal(error.code, 'deadline-exceeded');
    return true;
  }, 'a mid-turn adapter error must reject the compatibility request');
  assert.equal(legacy.mock.callCount(), 0, 'a governed turn error must never invoke the legacy provider');
  assert.equal(invoke.mock.callCount(), 1, 'a governed turn error must never invoke the adapter a second time');
});

test('governed compatibility chat accepts the extension wire payload and preserves provider options', async t => {
  const received = [];
  const f = await fixture(t, { providerHost: {
    executeRawProviderChat: async payload => { received.push(payload); return { reply: 'governed' }; },
    executeProviderStatus: async () => ({ providers: [{ configured: true, models: [{ allowed: true }] }] }),
  } });
  await installed(f);
  for (const contextual of [false, true]) {
    let payload;
    const controller = createChatTurnController({
      addMessage: async () => {},
      bridgeRequest: async (_path, request) => { payload = JSON.parse(JSON.stringify(request.body)); return { reply: 'captured' }; },
      chatSessionStore: { getAttachments: () => contextual ? [{ name: 'notes', content: 'attachment' }] : [], getMessages: () => input.messages },
      clearActivitySoon() {}, clearAttachments() {}, setActivity() {}, setStatus() {},
      getLastSnapshot: () => contextual ? { title: 'Page', url: 'https://example.com/', text: 'Visible' } : null,
      consumeScopedTabContexts: () => contextual ? [{ tabId: 7, title: 'Tab', url: 'https://example.com/tab', text: 'scoped' }, { title: 'Other', text: 'other' }] : [],
      getModel: () => input.model, getThinkingDepth: () => 'high',
    });
    await controller.runChatTurn();
    const original = structuredClone(payload);
    const result = await f.host.executeBridgeChat(payload);
    assert.equal(result.reply, 'governed');
    assert.equal(result.harness.addonId, ref.addonId);
    const forwarded = received.at(-1);
    assert.equal(forwarded.workload, 'augmentor-chat');
    assert.equal(forwarded.thinkingDepth, 'high');
    assert.equal(forwarded.pageContext ?? null, payload.pageContext);
    assert.equal(forwarded.runtimeContext ?? null, payload.runtimeContext);
    assert.deepEqual(forwarded.tabContexts, payload.tabContexts.map(({ title, url, text }) => ({ title, url, text })));
    assert.deepEqual(payload, original, 'normalization must not mutate the caller payload');
  }
  assert.equal(received.length, 2);
});

test('compatibility normalization rejects malformed options before creating a session', async t => {
  let probes = 0;
  const f = await fixture(t, { providerHost: {
    executeRawProviderChat: async () => assert.fail('invalid requests cannot dispatch'),
    executeProviderStatus: async () => { probes++; return { providers: [{ configured: true, models: [{ allowed: true }] }] }; },
  } });
  await installed(f);
  const before = f.writes();
  const tab = { title: 'Tab', url: 'https://example.com', text: 'scoped' };
  for (const extra of [
    { workload: 'other' }, { thinkingDepth: {} }, { thinkingDepth: 'x'.repeat(65537) },
    { runtimeContext: {} }, { pageContext: [] }, { credential: 'secret' },
    { tabContexts: [{ ...tab, tabId: 'secret' }] }, { tabContexts: [{ ...tab, tabId: 7, credential: 'secret' }] },
  ]) await assert.rejects(f.host.executeBridgeChat({ ...input, ...extra }), { code: 'invalid-event' });
  assert.equal(probes, 0, 'malformed compatibility input must not create an adapter session');
  assert.equal(f.writes(), before);
});

test('composed compatibility HTTP route uses fixed harness errors and retains provider capability', async t => {
  const providerRoutes = createProviderHostService({ redactDiagnosticText: value => String(value ?? ''), extractJsonObject: JSON.parse }).providerBridgeRoutes;
  const f = await fixture(t);
  await installed(f);
  await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: null, expectedGeneration: 1, replace: true });
  const routes = f.host.composeProviderRoutes(providerRoutes);
  const chat = routes.find(route => route.path === '/augmentor/chat');
  assert.equal(chat.requiredCapability, 'provider-model-invoke');
  const { handler: legacyHandler, ...legacyFlags } = providerRoutes.find(route => route.path === '/augmentor/chat');
  const { handler: governedHandler, ...flags } = chat;
  assert.deepEqual(flags, legacyFlags, 'compatibility route must retain the pre-1F transport flags');
  for (const route of providerRoutes.filter(route => route.path !== '/augmentor/chat')) assert.ok(routes.includes(route));
  const handler = createBridgeRequestHandler({ routes, bridgeToken: 'bridge', allowedOrigins: [], allowedCidrs: [],
    extensionOrigin: 'chrome-extension://test', bridgeCapabilityTokens: { 'provider-model-invoke': 'invoke' } });
  const before = f.writes();
  const request = Readable.from([JSON.stringify(input)]);
  Object.assign(request, { method: 'POST', url: '/augmentor/chat', socket: { localPort: 47773 },
    rawHeaders: ['Host', '127.0.0.1:47773'], headers: { host: '127.0.0.1:47773', origin: 'chrome-extension://test',
      'x-resonantos-bridge-token': 'bridge', 'x-resonantos-bridge-capability-token': 'invoke' } });
  let status, text = '';
  const response = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  response.writeHead = value => { status = value; response.headersSent = true; };
  await handler(request, response);
  assert.equal(status, 403, 'governed compatibility denial must be 403, not generic 500');
  assert.equal(JSON.parse(text).code, 'permission-denied');
  assert.equal(f.invokes(), 0);
  assert.equal(f.writes(), before);
});

// Exercise the actual HTTP handler without opening a sandboxed loopback socket.
function compatibilityHttp(f) {
  const providerRoutes = createProviderHostService({ redactDiagnosticText: String, extractJsonObject: JSON.parse }).providerBridgeRoutes;
  const handler = createBridgeRequestHandler({ routes: f.host.composeProviderRoutes(providerRoutes),
    bridgeToken: 'bridge', bridgeCapabilityTokens: { 'provider-model-invoke': 'invoke' },
    capabilityBootstrapToken: 'bootstrap', allowedOrigins: ['http://localhost:5173'], allowedCidrs: [],
    extensionOrigin: 'chrome-extension://test' });
  return async (headers = {}, body = input, url = '/augmentor/chat') => {
    const request = Readable.from([JSON.stringify(body)]);
    const merged = { host: '127.0.0.1:47773', origin: 'chrome-extension://test',
      'x-resonantos-bridge-token': 'bridge', 'x-resonantos-bridge-capability-token': 'invoke', ...headers };
    Object.assign(request, { method: 'POST', url, socket: { localPort: 47773 },
      rawHeaders: ['Host', merged.host], headers: merged });
    let status, text = '';
    const response = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
    response.writeHead = value => { status = value; response.headersSent = true; };
    await handler(request, response);
    return { status, payload: JSON.parse(text) };
  };
}

test('compatibility capability denial preserves the React token rotation regex before and after governance', async t => {
  const f = await fixture(t), call = compatibilityHttp(f);
  for (const governed of [false, true]) {
    if (governed) await installed(f);
    const response = await call({ 'x-resonantos-bridge-capability-token': 'rotated-token' });
    assert.equal(response.status, 403);
    assert.equal(response.payload.ok, false);
    assert.ok(/^Bridge route requires .+ capability\.$/.test(response.payload.error), 'capability denial must match the React token rotation regex');
    assert.equal(Object.hasOwn(response.payload, 'code'), false);
    assert.deepEqual(response.payload, { ok: false, error: 'Bridge route requires provider-model-invoke capability.' });
  }
  assert.equal(f.invokes(), 0);
});

test('ungoverned compatibility provider errors retain the 6876f20e status and body', async t => {
  let calls = 0;
  const f = await fixture(t, { providerHost: { executeBridgeChat: async () => { calls++; throw new Error('boom'); } } });
  const call = compatibilityHttp(f);
  assert.deepEqual(await call(), { status: 500, payload: { ok: false, error: 'boom' } });
  // Legacy chat did not opt into the harness Host or origin guards.
  assert.deepEqual(await call({ host: 'evil.test:47773', origin: 'https://evil.test' }),
    { status: 500, payload: { ok: false, error: 'boom' } });
  assert.equal(calls, 2);
});

test('compatibility transport refusals retain legacy payloads even with governance activated', async t => {
  const f = await fixture(t), call = compatibilityHttp(f);
  await installed(f);
  assert.deepEqual(await call({ 'x-resonantos-bridge-token': 'wrong' }),
    { status: 401, payload: { ok: false, error: 'Unauthorized browser-first bridge request.' } });
  assert.deepEqual(await call({}, input, '/augmentor/unknown'),
    { status: 404, payload: { ok: false, error: 'Unknown browser-first bridge route.' } });
  assert.deepEqual(await call({}, { capabilities: ['provider-model-invoke'] }, '/api/capability-tokens'),
    { status: 403, payload: { ok: false, error: 'Bridge route requires capability bootstrap authorization.' } });
  assert.equal(f.invokes(), 0);
});

test('governed compatibility handler itself rejects invalid Host before adapter readiness or invocation', async t => {
  let probes = 0, calls = 0;
  const f = await fixture(t, { providerHost: {
    executeRawProviderChat: async () => { calls++; return { reply: 'answer' }; },
    executeProviderStatus: async () => { probes++; return { providers: [{ configured: true, models: [{ allowed: true }] }] }; },
  } });
  await installed(f);
  await assert.rejects(f.host.executeBridgeChat(input, {
    method: 'POST', url: '/augmentor/chat', headers: { host: 'evil.test:47773' },
    rawHeaders: ['Host', 'evil.test:47773'], socket: { localPort: 47773 },
  }), { code: 'permission-denied' });
  assert.equal(probes, 0);
  assert.equal(calls, 0);
});

test('governed compatibility HTTP retains typed grant, Host, origin and turn failures', async t => {
  let probes = 0, calls = 0;
  const f = await fixture(t, { providerHost: {
    executeRawProviderChat: async () => { calls++; throw new Error('private-provider-error'); },
    executeProviderStatus: async () => { probes++; return { providers: [{ configured: true, models: [{ allowed: true }] }] }; },
  } });
  const manifest = await installed(f), call = compatibilityHttp(f);
  const denied = { status: 403, payload: { ok: false, code: 'permission-denied', error: 'Runtime permission denied.' } };
  assert.deepEqual(await call({ host: 'evil.test:47773' }), denied);
  assert.deepEqual(await call({ origin: 'https://evil.test' }), denied);
  assert.equal(probes, 0);
  assert.equal(calls, 0);
  const failure = await call({ origin: 'http://localhost:5173' });
  assert.equal(failure.status, 503);
  assert.equal(failure.payload.code, 'runtime-unavailable');
  assert.doesNotMatch(JSON.stringify(failure.payload), /private-provider-error/);
  assert.equal(calls, 1);
  await f.call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: false })),
    consent: true, expectedRevision: f.host.registry.snapshot().revision });
  assert.deepEqual(await call(), denied);
  assert.equal(calls, 1, 'revocation cannot fall back to the provider');
});

test('approved DSH composition exposes authorized operations and rejects malformed input before adapters', async t => {
  const manifest = await example('deepseek-harness'), calls = [];
  const f = await fixture(t, {
    bindings: [{ name: 'dsh.main', addonId: manifest.id, adapterId: 'dsh-typert-v1', authScheme: 'dsh-action-token', endpoint: manifest.agentRuntime.endpoint, source: { env: 'DSH_TEST' } }],
    transportFactory: async () => ({ dispose() {} }),
    dshAdapterFactory: () => ({
      createSession: async () => { calls.push('create'); return {}; }, dispose() {},
      async *invoke() { calls.push('invoke'); yield { type: 'delta', data: { text: 'partial' } }; await new Promise(() => {}); },
      cancel: async () => { calls.push('cancel'); },
      history: async () => { calls.push('history'); return []; },
      status: async () => { calls.push('status'); return { status: 'idle' }; },
      selectModel: async ({ input }) => { calls.push('selectModel'); return input; },
    }),
  });
  assert.equal((await f.call('/addons/install', { manifest, enabled: true })).status, 200);
  assert.equal((await f.call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: true })), consent: true, expectedRevision: 1 })).status, 200);
  assert.equal((await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: 0 })).status, 200);
  const session = (await f.call('/agent/session', { addonId: manifest.id })).payload.session;
  for (const [path, body] of [
    ['/agent/history', { session }], ['/agent/status', { session }], ['/agent/select-model', { session, model: { provider: 'test-provider', model: 'catalog/test-model' } }],
    [`/agent/events?${new URLSearchParams(session)}`, {}],
  ]) assert.equal((await f.call(path, body)).status, 200, path);
  const before = calls.length;
  for (const bad of [null, [], { messages: 'bad' }, { messages: [{ role: 'system', content: 'bad' }] }, { ...input, token: 'secret' }, { ...input, contextSources: [{ secret: 'secret' }] }]) {
    assert.equal((await f.call('/agent/turn', { session, input: bad })).status, 400);
  }
  assert.equal((await f.call('/agent/select-model', { session, model: { provider: 'test', model: 'test', endpoint: 'http://evil' } })).status, 400);
  assert.equal(calls.length, before, 'invalid payloads cannot call adapters');
  const events = f.host.boundary.events(session);
  const turn = (await f.call('/agent/turn', { session, input })).payload.turnId;
  assert.equal((await events.next()).value.type, 'delta');
  assert.equal((await f.call('/agent/cancel', { session, turnId: turn })).status, 200);
  assert.deepEqual(calls, ['create', 'history', 'status', 'selectModel', 'invoke', 'cancel']);
  assert.equal((await f.call('/addons/remove', { addonId: manifest.id })).payload.code, 'ownership-conflict');
  assert.equal((await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: null, expectedGeneration: 1, replace: true })).status, 200);
  assert.equal((await f.call('/addons/remove', { addonId: manifest.id })).status, 200);
});

test('enabled route validates shape and revision before changing state', async t => {
  const f = await fixture(t), manifest = await installed(f, false);
  const before = f.host.registry.snapshot();
  for (const body of [
    { addonId: manifest.id, enabled: false },
    { addonId: manifest.id, enabled: 'false', expectedRevision: 1 },
    { addonId: manifest.id, enabled: false, expectedRevision: -1 },
    { addonId: manifest.id, enabled: false, expectedRevision: 0 },
  ]) {
    const result = await f.call('/addons/enabled', body);
    assert.ok([400, 409].includes(result.status), 'invalid enable command must fail validation');
    assert.deepEqual(f.host.registry.snapshot(), before);
  }
  const result = await f.call('/addons/enabled', { addonId: manifest.id, enabled: false, expectedRevision: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.payload.installations[manifest.id].enabled, false);
});

test('client dispose route closes sessions idempotently and denies old generations', async t => {
  const f = await fixture(t); const manifest = await installed(f);
  const created = await f.call('/agent/session', { addonId: manifest.id });
  const session = created.payload.session;
  assert.equal((await f.call('/agent/dispose', { session })).status, 200, 'dispose route must exist');
  assert.equal((await f.call('/agent/dispose', { session })).status, 200);
  assert.notEqual((await f.call('/agent/history', { session })).status, 200);
  await f.call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: 1, replace: true });
  assert.notEqual((await f.call('/agent/dispose', { session })).status, 200);
});

test('reviewed OpenAI adapter resolves bound bearer credentials; unknown adapters remain denied', async t => {
  const manifest = await example('deepseek-harness');
  manifest.id = 'addon.compatible-registration';
  Object.assign(manifest.agentRuntime, { adapterId: 'openai-compatible-v1', authScheme: 'bearer', credentialBinding: 'compatible.registration' });
  const binding = { name: manifest.agentRuntime.credentialBinding, addonId: manifest.id, adapterId: manifest.agentRuntime.adapterId,
    authScheme: 'bearer', endpoint: manifest.agentRuntime.endpoint, source: { env: 'REGISTRATION_BEARER' } };
  let resolved = 0, disposed = 0;
  const f = await fixture(t, { bindings: [binding], env: { REGISTRATION_BEARER: 'ephemeral-test-value' },
    openaiAdapterFactory: async ({ credentials, addonId, runtime }) => {
      const lease = await credentials.acquire({ addonId, runtime }); resolved++;
      return { createSession: async () => ({}), dispose: async () => { disposed++; lease.dispose(); } };
    } });
  assert.equal((await f.call('/addons/install', { manifest, enabled: true })).status, 200);
  await f.host.registry.setGrants(manifest.id, manifest.requestedCapabilities.map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: 1 });
  await f.host.registry.assignSlot('primary-agent', manifest.id, { expectedGeneration: 0 });
  const result = await f.call('/agent/session', { addonId: manifest.id });
  assert.equal(result.status, 200);
  assert.equal(resolved, 1);
  await f.host.close();
  assert.equal(disposed, 1);
  const other = structuredClone(manifest); other.agentRuntime.adapterId = 'unreviewed-v1';
  const denied = await fixture(t, { bindings: [{ ...binding, adapterId: 'unreviewed-v1' }] });
  assert.equal((await denied.call('/addons/install', { manifest: other, enabled: true })).payload.code, 'permission-denied');
});
