// Client transport only. Adapter semantics, grants, routes and UI are separate.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicHarnessError } from './harness-adapter-contract.mjs';

const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });
const safe = error => fail(['permission-denied', 'deadline-exceeded'].includes(error?.code) ? error.code : 'runtime-unavailable');
const routes = new Set(['augmentor', ...['create', 'prompt', 'cancel', 'page', 'list', 'rename', 'selectModel', 'modelCatalog'].map(name => `session/${name}`)].map(name => `/api/${name}`));
const loopback = address => address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));
function originFor(endpoint) {
  let origin;
  try { origin = new URL(endpoint); } catch { throw fail('permission-denied'); }
  const host = origin.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(origin.protocol) || !origin.port || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash || (host !== 'localhost' && !loopback(host))) throw fail('permission-denied');
  return origin;
}

// All injected dependencies are trusted host/test dependencies, never request
// fields. The native Node 24 WebSocket refuses redirects during its handshake.
export async function createHarnessTransport({ credentials, addonId, runtime, lookup = dnsLookup,
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timeoutMs = 10000,
  maxResponseBytes = 1048576, maxMessageBytes = 1048576 } = {}) {
  if (runtime?.adapterId !== 'dsh-typert-v1' || runtime?.authScheme !== 'dsh-action-token') throw fail('permission-denied');
  if (![timeoutMs, maxResponseBytes, maxMessageBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) throw fail('permission-denied');
  const lease = await credentials.acquire({ addonId, runtime });
  let origin;
  try { origin = await lease.use(({ endpoint }) => originFor(endpoint)); }
  catch (error) { lease.dispose(); throw safe(error); }
  const lifetime = new AbortController(), streams = new Set();
  let cookie = '', authenticating = null;
  function check(signal) { if (lifetime.signal.aborted || signal?.aborted) throw fail(signal?.reason?.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'runtime-unavailable'); }
  async function bounded(operation, signal) {
    const deadline = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    let abort;
    const timer = setTimeout(() => deadline.abort(fail('deadline-exceeded')), timeoutMs);
    try {
      check(combined);
      return await Promise.race([
        Promise.resolve().then(() => { check(combined); return operation(combined); }),
        new Promise((_, reject) => {
          abort = () => reject(fail(combined.reason?.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'runtime-unavailable'));
          combined.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } catch (error) { throw safe(error); }
    finally { clearTimeout(timer); combined.removeEventListener('abort', abort); }
  }
  async function destination(path, signal, websocket = false) {
    check(signal);
    const host = origin.hostname.replace(/^\[|\]$/g, '');
    const answers = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    check(signal);
    if (!Array.isArray(answers) || !answers.length || answers.some(answer => !loopback(answer.address))) throw fail('permission-denied');
    const url = new URL(path, origin);
    // Connect using the validated IP, never trigger a second DNS lookup. Port
    // and scheme come from the approved binding; no caller selects a URL.
    url.hostname = isIP(answers[0].address) === 6 ? `[${answers[0].address}]` : answers[0].address;
    if (websocket) url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    return url;
  }
  async function readBody(response, signal) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        check(signal);
        const { done, value } = await reader.read();
        check(signal);
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) throw fail('runtime-unavailable');
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function requestRaw(path, { method = 'GET', headers = {}, body, signal, consumeBody = true } = {}, exchange = false) {
    const url = await destination(path, signal);
    check(signal);
    const response = await fetchImpl(url, { method, headers, body, signal, redirect: 'manual' });
    check(signal);
    if (response.status >= 300 && response.status < 400 && !(exchange && response.status === 303)) {
      await response.body?.cancel(); throw fail('runtime-unavailable');
    }
    // Status/header-only auth requests must not buffer DSH's potentially large SPA shell.
    if (!consumeBody) {
      await response.body?.cancel();
      return { status: response.status, headers: response.headers };
    }
    return { status: response.status, headers: response.headers, text: await readBody(response, signal) };
  }
  async function authorize(signal) {
    if (authenticating) { await authenticating; check(signal); return; }
    authenticating = (async () => {
      const probe = await requestRaw('/', { headers: cookie ? { cookie } : {}, signal, consumeBody: false });
      if (probe.status === 200 && cookie) return;
      if (![200, 401].includes(probe.status)) throw fail('runtime-unavailable');
      cookie = '';
      const bootstrap = await lease.use(({ actionToken }) => requestRaw('/api/augmentor/auth', {
        method: 'POST', headers: { 'x-augmentor-token': actionToken }, signal,
      }));
      if (bootstrap.status !== 200) throw fail('runtime-unavailable');
      const { token } = JSON.parse(bootstrap.text);
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/.test(token)) throw fail('runtime-unavailable');
      lease.remember(token);
      // This one URL query is DSH's existing host-to-host exchange protocol.
      // Never return it, follow its redirect, or expose response headers.
      const exchange = await requestRaw(`/?token=${encodeURIComponent(token)}`, { signal, consumeBody: false }, true);
      const location = exchange.headers.get('location');
      if (exchange.status !== 303 || (location && new URL(location, origin).href !== new URL('/', origin).href)) throw fail('runtime-unavailable');
      const sessionCookie = exchange.headers.getSetCookie().map(value => value.split(';')[0])
        .find(value => /^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/.test(value));
      if (!sessionCookie) throw fail('runtime-unavailable');
      check(signal);
      lease.remember(sessionCookie); lease.remember(sessionCookie.slice(sessionCookie.indexOf('=') + 1));
      cookie = sessionCookie;
    })();
    try { await authenticating; } finally { authenticating = null; }
  }
  return Object.freeze({
    async request(route, options = {}) {
      if (!routes.has(route) || Object.keys(options).some(key => !['body', 'signal', 'method'].includes(key)) ||
          (options.method !== undefined && !['GET', 'POST'].includes(options.method))) throw fail('permission-denied');
      return bounded(async signal => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        if (body !== undefined && Buffer.byteLength(body) > maxResponseBytes) throw fail('permission-denied');
        const send = () => requestRaw(route, { method: options.method ?? 'POST', body, signal,
          headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
        let response = await send();
        // Only an explicit 401 guarantees DSH rejected before dispatch. Never
        // replay a timeout, disconnect, redirect, parse error or arbitrary 5xx.
        if (response.status === 401) { await authorize(signal); check(signal); response = await send(); }
        if (response.status < 200 || response.status >= 300) throw fail('runtime-unavailable');
        return { status: response.status, body: lease.sanitize(JSON.parse(response.text)) };
      }, options.signal);
    },
    async openStream({ signal, onMessage = () => {}, onError = () => {}, onClose = () => {} } = {}) {
      return bounded(async openingSignal => {
        await authorize(openingSignal);
        const url = await destination('/api/remote.mux', openingSignal, true);
        check(openingSignal);
        return lease.use(({ actionToken }) => new Promise((resolve, reject) => {
          const socket = new WebSocketImpl(url, { headers: { 'x-augmentor-token': actionToken, cookie } });
          let opened = false, closed = false;
          const streamSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
          const report = error => { try { onError(safe(error)); } catch {} };
          function close() {
            if (closed) return;
            closed = true; streams.delete(close);
            openingSignal.removeEventListener('abort', abortOpening);
            streamSignal.removeEventListener('abort', close);
            socket.close();
            if (!opened) reject(fail('runtime-unavailable'));
          }
          function abortOpening() { close(); }
          streams.add(close);
          openingSignal.addEventListener('abort', abortOpening, { once: true });
          streamSignal.addEventListener('abort', close, { once: true });
          socket.addEventListener('open', () => {
            if (closed || openingSignal.aborted) { close(); return; }
            opened = true; openingSignal.removeEventListener('abort', abortOpening);
            resolve(Object.freeze({
              send(value) {
                try {
                  check(streamSignal);
                  const text = JSON.stringify(value);
                  if (closed || typeof text !== 'string' || Buffer.byteLength(text) > maxMessageBytes || socket.bufferedAmount > maxMessageBytes) throw fail('runtime-unavailable');
                  socket.send(text);
                } catch (error) { close(); throw safe(error); }
              },
              close,
            }));
          });
          socket.addEventListener('message', event => {
            if (closed || streamSignal.aborted) return;
            try {
              if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > maxMessageBytes) throw fail('runtime-unavailable');
              onMessage(lease.sanitize(JSON.parse(event.data)));
            } catch (error) { report(error); close(); }
          });
          socket.addEventListener('error', () => { if (!closed) report(fail('runtime-unavailable')); close(); });
          socket.addEventListener('close', () => { close(); try { onClose(); } catch {} });
        }));
      }, signal);
    },
    dispose() {
      lifetime.abort(); cookie = '';
      for (const close of [...streams]) close();
      lease.dispose();
    },
  });
}
