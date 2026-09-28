// Recorded protocol shapes from apps/augmentor/shared/dsh-remote.mjs and
// test/dsh-remote.test.mjs, test/chat-render.test.mjs (DSH 0.1.5 client).
// Synthetic public text/IDs only; no live DSH or captured credentials.
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createHarnessCredentials } from '../host/harness-credentials.mjs';
import { createHarnessTransport } from '../host/harness-transport.mjs';
export const snapshot = { type: 'snapshot', cursor: 1, records: [], hasMore: false, header: { id: 'fixture' } };
export const event = (type, seq, data = {}) => ({ type: 'event', event: { type, seq, time: 1, data } });
export const chunk = text => ({ type: 'assistant-stream', frame: { type: 'chunk', time: 1, chunk: { type: 'text-delta', text } } });
export const message = (text, seq = 3) => event('assistant/message', seq, { message: { content: [{ type: 'text', text }] } });
export const catalog = { groups: [{ provider: 'deepseek', models: [{ model: 'deepseek-chat', name: 'DeepSeek Chat' }] }], default: { provider: 'deepseek', model: 'deepseek-chat' } };
export async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.ok(predicate(), 'expected observed operation to occur');
}
export async function wire({ autoSnapshot = true } = {}) {
  const action = randomBytes(24).toString('base64url'), launch = randomBytes(24).toString('base64url');
  const cookie = `dsh-auth-test=${randomBytes(24).toString('base64url')}`;
  const requests = [], opens = [], sockets = [], upgrades = [];
  let promptOutcome = 'accepted', page = { records: [{ type: 'event', event: message('hello').event }], hasMore: false };
  let responseOverride, modelCatalog = catalog, onPrompt = () => {}, onCancel = () => {};
  const emit = (value, index = sockets.length - 1) => sockets[index].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'item', streamId: 'augmentor', value }) }));
  class Socket extends EventTarget {
    bufferedAmount = 0;
    closed = false;
    constructor(url, options) { super(); sockets.push(this); upgrades.push({ url: String(url), ...options }); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) { opens.push(JSON.parse(raw)); if (autoSnapshot) queueMicrotask(() => emit(snapshot)); }
    close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event('close')); } }
  }
  const runtime = { adapterId: 'dsh-typert-v1', authScheme: 'dsh-action-token', credentialBinding: 'dsh.main', endpoint: 'http://127.0.0.1:3080' };
  const credentials = createHarnessCredentials({ bindings: [{ name: 'dsh.main', addonId: 'addon.dsh', ...runtime, source: { env: 'TOKEN' } }], env: { TOKEN: action } });
  const transport = await createHarnessTransport({ credentials, addonId: 'addon.dsh', runtime, WebSocketImpl: Socket,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      requests.push({ path, url: String(url), ...options, body: options.body ? JSON.parse(options.body) : undefined });
      assert.equal(options.redirect, 'manual');
      if (path === '/api/augmentor/auth') { assert.equal(options.headers['x-augmentor-token'], action); return Response.json({ token: launch }); }
      if (new URL(url).search) return new Response(null, { status: 303, headers: { 'set-cookie': `${cookie}; HttpOnly`, location: '/' } });
      if (options.headers.cookie !== cookie) return new Response(null, { status: 401 });
      if (path === '/') return new Response(null);
      const body = JSON.parse(options.body);
      if (path === '/api/session/prompt') {
        onPrompt();
        if (promptOutcome === 'lost') throw new Error(`uncertain ${action}`);
        if (promptOutcome === '401') { promptOutcome = 'accepted'; return new Response(null, { status: 401 }); }
      }
      if (path === '/api/session/cancel') await onCancel();
      const value = path.endsWith('/page') ? page : path.endsWith('/modelCatalog') ? modelCatalog : path.endsWith('/prompt') ? { accepted: promptOutcome !== 'rejected' } : {};
      return Response.json(responseOverride ?? { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
    },
  });
  return { transport, requests, opens, sockets, upgrades, emit, cookie, action, launch,
    rpc: method => requests.filter(row => row.path === `/api/${method}` && row.headers.cookie === cookie),
    catalog(value) { modelCatalog = value; },
    onCancel(callback) { onCancel = callback; },
    onPrompt(callback) { onPrompt = callback; }, outcome(value) { promptOutcome = value; }, page(value) { page = value; }, response(value) { responseOverride = value; },
  };
}
