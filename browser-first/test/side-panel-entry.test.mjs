import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { selectAgentViewMode, bootSidePanel, mountEmbedView, probeEmbedAvailability }
  from '../resonantos-side-panel-extension/src/side-panel-entry.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('explicit query overrides local storage; unavailable preferences default to normal', async () => {
  const storage = value => ({ get: async () => ({ 'resonantos.agentView': value }) });
  assert.equal(await selectAgentViewMode('?agentView=embed', storage('normal')), 'embed');
  assert.equal(await selectAgentViewMode('?agentView=normal', storage('embed')), 'normal');
  assert.equal(await selectAgentViewMode('', storage('embed')), 'embed');
  assert.equal(await selectAgentViewMode('', storage('normal')), 'normal');
  assert.equal(await selectAgentViewMode('?agentView=unknown', storage('embed')), 'embed');
  let reads = 0;
  const unavailable = { get() { reads++; throw Error('unavailable'); } };
  assert.equal(await selectAgentViewMode('?agentView=normal', unavailable), 'normal');
  assert.equal(await selectAgentViewMode('?agentView=embed', unavailable), 'embed');
  assert.equal(reads, 0);
  assert.equal(await selectAgentViewMode('', unavailable), 'normal');
});

test('boot shows all embed controls without probing; normal shows only an available bar', async () => {
  for (const available of [true, false]) {
    const calls = [];
    const options = { storage: null,
      loadNormal: async () => calls.push('normal'), mountEmbed: async () => calls.push('embed'),
      probeAvailability: async () => { calls.push('probe'); return available; },
      mountNormalBar: () => calls.push('bar') };
    await bootSidePanel({ ...options, search: '?agentView=embed' });
    assert.deepEqual(calls, ['embed']);
    calls.length = 0;
    await bootSidePanel({ ...options, search: '?agentView=normal' });
    assert.deepEqual(calls, available ? ['normal', 'probe', 'bar'] : ['normal', 'probe']);
  }
});

test('availability projection fails closed and calls GET only', async () => {
  assert.equal(await probeEmbedAvailability(async () => ({ request: async (route, options) => {
    assert.equal(route, '/embed/status'); assert.equal(options.method, 'GET');
    return { available: true, profile: 'poc' };
  } })), true);
  assert.equal(await probeEmbedAvailability(async () => ({ request: async () => ({ available: false }) })), false);
  assert.equal(await probeEmbedAvailability(async () => { throw Error('private diagnostic'); }), false);
  const calls = [];
  await bootSidePanel({ search: '?agentView=normal', storage: null,
    loadNormal: async () => calls.push('normal'), probeAvailability: async () => { throw Error('failed'); },
    mountNormalBar: () => calls.push('bar') });
  assert.deepEqual(calls, ['normal']);
});

function fixture(t) {
  const dom = new JSDOM('<body><main id="normal-chat-root" class="chat-shell"></main></body>',
    { url: 'https://extension.test/src/side-panel.html?agentView=embed' });
  const calls = [], writes = [], assigned = [];
  const chromeApi = {
    runtime: { getURL: file => `chrome-extension://abc/${file}` },
    tabs: { query: async () => [], create: async value => calls.push(value),
      onActivated: fakeEvent(),
      onUpdated: fakeEvent(),
      onRemoved: fakeEvent() },
    windows: {}, storage: { local: { get: async () => ({}), set: async value => writes.push(value) },
      onChanged: fakeEvent() }
  };
  t.after(() => dom.window.close());
  return { dom, chromeApi, calls, writes, assigned, options: {
    documentRef: dom.window.document, windowRef: dom.window, chromeApi,
    locationRef: { href: dom.window.location.href, assign: url => assigned.push(url) }
  } };
}

test('mounted embed preserves relay boundaries, history and bar placement', async t => {
  const f = fixture(t);
  const sent = [];
  const view = await mountEmbedView({ ...f.options, getConnection: async () => ({
    bridgeUrl: 'http://127.0.0.1:18873', request: async (route, options) => {
      assert.equal(route, '/embed/session'); assert.equal(options.method, 'POST');
      return { hostPath: `/embed-host/?ticket=${'a'.repeat(43)}` };
    }
  }) });
  t.after(() => view.bar.destroy());
  const frame = view.root.querySelector('iframe');
  frame.contentWindow.postMessage = (...args) => sent.push(args);
  assert.equal(f.dom.window.document.body.firstElementChild, view.bar.root);
  assert.equal(view.bar.root.nextElementSibling, view.root);
  assert.equal(frame.src, `http://127.0.0.1:18873/embed-host/?ticket=${'a'.repeat(43)}`);
  const relay = (source, origin, data) => f.dom.window.dispatchEvent(
    new f.dom.window.MessageEvent('message', { source, origin, data }));
  relay({}, 'http://127.0.0.1:18873', { type: 'augmentor-ready' });
  relay(frame.contentWindow, 'http://evil.test', { type: 'augmentor-ready' });
  relay(frame.contentWindow, 'http://evil.test', { type: 'augmentor-status', online: true });
  assert.equal(view.state.ready, false); assert.equal(view.state.last.length, 0);
  assert.equal(view.bar.root.querySelector('[data-control=status]').textContent, 'Offline');
  relay(frame.contentWindow, 'http://127.0.0.1:18873', { type: 'augmentor-ready' });
  relay(frame.contentWindow, 'http://127.0.0.1:18873', { type: 'augmentor-status', online: true, busy: false });
  assert.equal(view.state.ready, true);
  assert.equal(view.bar.root.querySelector('[data-control=status]').textContent, 'Online · idle');
  for (let i = 0; i < 60; i++) relay(frame.contentWindow, 'http://127.0.0.1:18873', { type: 'augmentor-event', i });
  assert.equal(view.state.last.length, 50); assert.equal(view.state.last[0].i, 10);
  for (const type of ['augmentor-focus', 'augmentor-prompt', 'augmentor-new-chat', 'augmentor-context']) {
    assert.equal(view.state.send({ type }), true);
  }
  assert.equal(view.state.send({ type: 'execute' }), false);
  assert.equal(view.state.send({ type: 'augmentor-context', context: 'x'.repeat(16000) }), false);
  assert.equal(sent.length, 4);
  assert.ok(sent.every(([, origin]) => origin === 'http://127.0.0.1:18873'));
  frame.dispatchEvent(new f.dom.window.Event('error'));
  assert.equal(view.state.ready, false);
  assert.equal(view.state.send({ type: 'augmentor-focus' }), false);
  assert.equal(view.bar.root.querySelector('[data-control=status]').textContent, 'Offline');
});

test('session failure retains working Workspace and Assistant with offline status', async t => {
  const f = fixture(t);
  const view = await mountEmbedView({ ...f.options, getConnection: async () => {
    throw Error('private diagnostic');
  } });
  t.after(() => view.bar.destroy());
  assert.match(view.root.textContent, /Unable to open/);
  assert.equal(view.root.textContent.includes('private diagnostic'), false);
  assert.equal(view.bar.root.querySelector('[data-control=status]').textContent, 'Offline');
  view.bar.root.querySelector('[data-control=workspace]').click(); await settle();
  assert.equal(f.calls[0].url, 'chrome-extension://abc/src/main-workspace.html');
  view.bar.root.querySelector('[data-control=assistant]').click();
  view.bar.root.querySelector('[data-mode=normal]').click(); await settle();
  assert.deepEqual(f.writes, [{ 'resonantos.agentView': 'normal' }]);
  assert.equal(new URL(f.assigned[0]).searchParams.get('agentView'), 'normal');
});

function fakeEvent() {
  const listeners = new Set();
  return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => { for (const fn of listeners) fn(...args); } };
}
async function offlineView(f) {
  return mountEmbedView({ ...f.options, getConnection: async () => { throw Error('offline'); } });
}

test('tab updates refresh only for completed loads or URL changes', async t => {
  const f = fixture(t);
  let queries = 0;
  f.chromeApi.tabs.query = async () => { queries++; return []; };
  const { bar } = await offlineView(f); t.after(() => bar.destroy()); await bar.ready;
  const initial = queries;
  for (const change of [{ status: 'loading' }, { title: 'Title' }, { favIconUrl: 'icon' }, {}]) {
    f.chromeApi.tabs.onUpdated.emit(1, change);
  }
  await settle(); assert.equal(queries, initial);
  for (const change of [{ status: 'complete' }, { url: 'https://example.test/' }]) {
    f.chromeApi.tabs.onUpdated.emit(1, change);
    await settle();
  }
  assert.equal(queries, initial + 2);
});

test('refresh bursts keep one read in flight and one pending, dropping stale results', async t => {
  const f = fixture(t);
  const reads = [];
  f.chromeApi.tabs.query = () => new Promise(resolve => reads.push(resolve));
  const { bar } = await offlineView(f); t.after(() => bar.destroy());
  assert.equal(reads.length, 1);
  for (let i = 0; i < 20; i++) {
    f.chromeApi.tabs.onActivated.emit({ tabId: i });
    f.chromeApi.tabs.onUpdated.emit(i, { status: 'complete' });
    f.chromeApi.storage.onChanged.emit({ augmentorBrowserJobs: {} }, 'local');
  }
  await settle(); assert.equal(reads.length, 1);
  reads[0]([{ active: true, url: 'chrome-extension://abc/src/main-workspace.html' }]);
  await settle();
  assert.equal(reads.length, 2);
  assert.equal(bar.root.querySelector('[data-control=workspace]').getAttribute('aria-pressed'), 'false');
  reads[1]([]); await bar.ready; await settle();
  assert.equal(reads.length, 2);
  assert.equal(bar.root.querySelector('[data-control=workspace]').getAttribute('aria-pressed'), 'false');
  f.chromeApi.tabs.onRemoved.emit(1); await settle();
  assert.equal(reads.length, 3);
  reads[2]([{ active: true, url: 'chrome-extension://abc/src/main-workspace.html' }]);
  await settle();
  assert.equal(bar.root.querySelector('[data-control=workspace]').getAttribute('aria-pressed'), 'true');
});

test('destroy removes refresh listeners and cancels pending refresh work', async t => {
  const f = fixture(t);
  const reads = [];
  f.chromeApi.tabs.query = () => new Promise(resolve => reads.push(resolve));
  const { bar } = await offlineView(f);
  f.chromeApi.tabs.onActivated.emit({ tabId: 2 });
  bar.destroy();
  reads[0]([]); await bar.ready; await settle();
  assert.equal(reads.length, 1);
  for (const event of [f.chromeApi.tabs.onActivated, f.chromeApi.tabs.onUpdated,
    f.chromeApi.tabs.onRemoved, f.chromeApi.storage.onChanged]) assert.equal(event.listeners.size, 0);
});

test('normal mode registers no tab or storage listeners and performs no refresh reads', async t => {
  const f = fixture(t);
  const globals = { document: f.options.documentRef, window: f.options.windowRef,
    chrome: f.chromeApi, location: f.options.locationRef };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  let reads = 0, registrations = 0;
  f.chromeApi.tabs.query = async () => { reads++; return []; };
  f.chromeApi.storage.local.get = async () => { reads++; return {}; };
  for (const event of [f.chromeApi.tabs.onActivated, f.chromeApi.tabs.onUpdated,
    f.chromeApi.tabs.onRemoved, f.chromeApi.storage.onChanged]) {
    const add = event.addListener;
    event.addListener = fn => { registrations++; add(fn); };
  }
  await bootSidePanel({ search: '?agentView=normal', loadNormal: async () => {},
    probeAvailability: async () => true });
  t.after(() => f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide')));
  assert.equal(registrations, 0);
  await settle(); assert.equal(reads, 0);
  assert.deepEqual([...f.dom.window.document.querySelectorAll('[data-control]')]
    .map(node => node.dataset.control), ['assistant']);
});
