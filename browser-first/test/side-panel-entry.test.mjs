import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAgentViewMode, bootSidePanel } from '../resonantos-side-panel-extension/src/side-panel-entry.js';

test('embed mode is selected by query OR local storage; default remains normal', async () => {
  const storage = value => ({ get: async () => ({ 'resonantos.agentView': value }) });
  assert.equal(await selectAgentViewMode('?agentView=embed', storage('normal')), 'embed');
  assert.equal(await selectAgentViewMode('', storage('embed')), 'embed');
  assert.equal(await selectAgentViewMode('?agentView=normal', storage('embed')), 'embed');
  assert.equal(await selectAgentViewMode('', storage('normal')), 'normal');
  assert.equal(await selectAgentViewMode('', { get: async () => { throw Error('unavailable'); } }), 'normal');
});

test('bootstrap only loads the selected implementation', async () => {
  const calls = [];
  const options = { storage: null, loadNormal: async () => calls.push('normal'), mountEmbed: async () => calls.push('embed') };
  await bootSidePanel({ ...options, search: '' });
  await bootSidePanel({ ...options, search: '?agentView=embed' });
  assert.deepEqual(calls, ['normal', 'embed']);
});

test('mounted embed validates relay source/origin, bounds history and sends to bridge origin', async t => {
  const { mountEmbedView } = await import('../resonantos-side-panel-extension/src/side-panel-entry.js');
  const saved = Object.fromEntries(['window', 'document', 'fetch', '__RESONANTOS_BRIDGE_CONFIG__'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const children = [];
  const sent = [];
  const listeners = [];
  const frameWindow = { postMessage: (...args) => sent.push(args) };
  globalThis.window = { addEventListener: (_type, fn) => listeners.push(fn) };
  globalThis.document = { documentElement: { classList: { add() {} } }, body: { append: node => children.push(node) }, createElement: tag => ({ tag, contentWindow: tag === 'iframe' ? frameWindow : undefined, append: node => children.push(node) }) };
  globalThis.__RESONANTOS_BRIDGE_CONFIG__ = { bridgeUrl: 'http://127.0.0.1:18873', bridgeToken: 'test-bridge', bridgeCapabilityTokens: { 'addon-runtime-control': 'test-cap' } };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18873/embed/session');
    assert.equal(options.headers['X-ResonantOS-Bridge-Capability-Token'], 'test-cap');
    return { ok: true, json: async () => ({ ok: true, hostPath: `/embed-host/?ticket=${'a'.repeat(43)}` }) };
  };
  await mountEmbedView();
  const state = window.__resonantosEmbed;
  assert.equal(state.ready, false);
  const relay = (source, origin, data) => listeners.forEach(fn => fn({ source, origin, data }));
  relay({}, 'http://127.0.0.1:18873', { type: 'augmentor-ready' });
  relay(frameWindow, 'http://evil.test', { type: 'augmentor-ready' });
  assert.equal(state.ready, false);
  assert.equal(state.last.length, 0);
  relay(frameWindow, 'http://127.0.0.1:18873', { type: 'augmentor-ready' });
  assert.equal(state.ready, true);
  for (let i = 0; i < 60; i++) relay(frameWindow, 'http://127.0.0.1:18873', { type: 'augmentor-event', i });
  assert.equal(state.last.length, 50);
  assert.equal(state.last[0].i, 10);
  state.send({ type: 'augmentor-focus' });
  assert.deepEqual(sent, [[{ type: 'augmentor-focus' }, 'http://127.0.0.1:18873']]);
  assert.equal(children[1].src, `http://127.0.0.1:18873/embed-host/?ticket=${'a'.repeat(43)}`);
  globalThis.fetch = async () => { throw new Error('private diagnostic'); };
  await mountEmbedView();
  assert.match(children.at(-1).textContent, /Unable to open/);
  assert.ok(!children.at(-1).textContent.includes('private diagnostic'));
});
