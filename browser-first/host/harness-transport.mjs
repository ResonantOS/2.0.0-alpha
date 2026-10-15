// Client transport only. Adapter semantics, grants, routes and UI are separate.
import { createAgentRuntimeEndpoint } from './agent-runtime-endpoint.mjs';
import { publicHarnessError } from './harness-adapter-contract.mjs';
import { randomUUID } from 'node:crypto';

const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });
const safe = error => fail(['permission-denied', 'deadline-exceeded'].includes(error?.code) ? error.code : 'runtime-unavailable');
const routes = new Set(['augmentor', ...['create', 'prompt', 'cancel', 'page', 'list', 'rename', 'selectModel', 'modelCatalog'].map(name => `session/${name}`)].map(name => `/api/${name}`));
// All injected dependencies are trusted host/test dependencies, never request
// fields. The native Node 24 WebSocket refuses redirects during its handshake.
export async function createHarnessTransport({ credentials, credentialLease, addonId, runtime, lookup,
  fetchImpl, WebSocketImpl, signal: acquisitionSignal, timeoutMs = 10000,
  maxResponseBytes = 1048576, maxMessageBytes = 1048576 } = {}) {
  if (runtime?.adapterId !== 'dsh-typert-v1' || !['dsh-action-token', 'dsh-native-cookie'].includes(runtime?.authScheme)) throw fail('permission-denied');
  if (![timeoutMs, maxResponseBytes, maxMessageBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) throw fail('permission-denied');
  const lease = credentialLease ?? await credentials.acquire({ addonId, runtime, signal: acquisitionSignal });
  let endpointGuard;
  try { endpointGuard = await lease.use(({ endpoint }) => createAgentRuntimeEndpoint({ endpoint, lookup, fetchImpl, WebSocketImpl })); }
  catch (error) { lease.dispose(); throw safe(error); }
  const origin = endpointGuard.origin;
  const native = runtime.authScheme === 'dsh-native-cookie';
  const lifetime = new AbortController(), streams = new Set();
  let cookie = '', authenticating = null;
  let ownedSessionId, cleanupPending, cleanupClosed = false;
  function check(signal) { if (lifetime.signal.aborted || signal?.aborted) throw fail(signal?.reason?.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'runtime-unavailable'); }
  async function bounded(operation, signal) {
    const deadline = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, ...(native ? [lease.signal] : []), deadline.signal, ...(signal ? [signal] : [])]);
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
    check(signal);
    const response = await endpointGuard.connectHttp(path, { method, headers, body, signal },
      exchange ? response => response.status === 303 : undefined);
    check(signal);
    // Status/header-only auth requests must not buffer DSH's potentially large SPA shell.
    if (!consumeBody) {
      await response.body?.cancel();
      return { status: response.status, headers: response.headers };
    }
    return { status: response.status, headers: response.headers, text: await readBody(response, signal) };
  }
  async function nativeExchange({ endpoint, loginToken, signal }) {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const response = await endpointGuard.connectHttp(`/?token=${encodeURIComponent(loginToken)}`, {
      method: 'GET', headers: {}, signal: boundedSignal,
    }, response => response.status === 303);
    try {
      const location = response.headers.get('location');
      if (response.status !== 303 || (location && new URL(location, endpoint).href !== endpoint + '/')) throw fail('runtime-unavailable');
      const auth = response.headers.getSetCookie().filter(value => /^\s*dsh-auth-/i.test(value));
      if (auth.length !== 1) throw fail('runtime-unavailable');
      const [pair, ...attributes] = auth[0].split(';');
      if (Buffer.byteLength(pair) > 8192 || !/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/.test(pair)) throw fail('runtime-unavailable');
      const seen = new Set();
      for (const attribute of attributes) {
        const at = attribute.indexOf('='), name = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
        const value = at < 0 ? '' : attribute.slice(at + 1).trim();
        if (['expires', 'max-age'].includes(name)) {
          if (seen.has(name)) throw fail('runtime-unavailable'); seen.add(name);
          if (name === 'max-age' && (!/^[0-9]+$/.test(value) || Number(value) <= 0)) throw fail('runtime-unavailable');
          if (name === 'expires' && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())) throw fail('runtime-unavailable');
        }
      }
      if (boundedSignal.aborted) throw fail('runtime-unavailable');
      return pair;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  async function authorize(signal) {
    if (native) return lease.authenticate(nativeExchange, { signal });
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
    ...(native ? { epoch: lease.epoch, runtimeSignal: lease.signal, deadline: lease.deadline, version: lease.version,
      markReady: () => lease.ready(), failRuntime: code => lease.fail(code), readinessLease: () => lease.readinessLease() } : {}),
    authenticate: ({ signal } = {}) => bounded(authorize, signal),
    sanitize: value => lease.sanitize(value),
    ...(native ? {
      bindSession(sessionId) {
        if (ownedSessionId || !/^resonantos-[0-9a-f-]{36}$/.test(sessionId)) throw fail('permission-denied');
        ownedSessionId = sessionId;
      },
      cancelOwnedSession(sessionId, { signal } = {}) {
        if (cleanupClosed || !ownedSessionId || sessionId !== ownedSessionId || !lease.cleanupUse) throw fail('permission-denied');
        if (cleanupPending) return cleanupPending;
        const cleanupSignal = AbortSignal.any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])]);
        const operation = Promise.resolve().then(() => lease.cleanupUse(async currentCookie => {
          const response = await endpointGuard.connectHttp('/api/session/cancel', {
            method: 'POST', signal: cleanupSignal,
            headers: { cookie: currentCookie, 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: `augmentor-${randomUUID()}`,
              method: 'session/cancel', payload: { args: { request: { sessionId: ownedSessionId } } } }),
          });
          if (response.status < 200 || response.status >= 300) throw fail('runtime-unavailable');
          await response.body?.cancel();
        }, cleanupSignal));
        let abort;
        cleanupPending = Promise.race([operation, new Promise((_, reject) => {
          abort = () => reject(fail('runtime-unavailable'));
          if (cleanupSignal.aborted) abort(); else cleanupSignal.addEventListener('abort', abort, { once: true });
        })]).finally(() => { cleanupSignal.removeEventListener('abort', abort); cleanupPending = null; });
        return cleanupPending;
      },
    } : {}),
    async request(route, options = {}) {
      if (!routes.has(route) || (native && route === '/api/augmentor') || Object.keys(options).some(key => !['body', 'signal', 'method'].includes(key)) ||
          (options.method !== undefined && !['GET', 'POST'].includes(options.method))) throw fail('permission-denied');
      return bounded(async signal => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        if (body !== undefined && Buffer.byteLength(body) > maxResponseBytes) throw fail('permission-denied');
        if (native) await authorize(signal);
        let usedGeneration;
        const send = async () => {
          const value = native ? await lease.use(value => ({ cookie: value.cookie, generation: value.generation })) : { cookie };
          usedGeneration = value.generation;
          return requestRaw(route, { method: options.method ?? 'POST', body, signal,
            headers: { 'content-type': 'application/json', ...(value.cookie ? { cookie: value.cookie } : {}) } });
        };
        let response = await send();
        if (response.status === 401) {
          if (native) await lease.authenticate(nativeExchange, { signal, generation: usedGeneration, refresh: true });
          else await authorize(signal);
          check(signal); response = await send();
          if (native && response.status === 401) await lease.fail('runtime-unavailable');
        }
        if (response.status < 200 || response.status >= 300) throw fail('runtime-unavailable');
        return { status: response.status, body: lease.sanitize(JSON.parse(response.text)) };
      }, options.signal);
    },
    async openStream({ signal, onMessage = () => {}, onError = () => {}, onClose = () => {} } = {}) {
      return bounded(async openingSignal => {
        await authorize(openingSignal); check(openingSignal);
        let attempted;
        const opaqueOpeningFailure = Symbol('opaque-opening-failure');
        const observedOpening401 = Symbol('observed-opening-401');
        async function openOnce() {
          const values = await lease.use(value => ({ actionToken: value.actionToken, cookie: native ? value.cookie : cookie, generation: value.generation }));
          attempted = values;
          return endpointGuard.connectWebSocket('/api/remote.mux', {
            headers: native ? { cookie: values.cookie } : { 'x-augmentor-token': values.actionToken, cookie: values.cookie }, signal: openingSignal,
          }, socket => new Promise((resolve, reject) => {
            let opened = false, closed = false;
            const streamSignal = AbortSignal.any([lifetime.signal, ...(native ? [lease.signal] : []), ...(signal ? [signal] : [])]);
            function close(openingError = fail('runtime-unavailable')) {
              if (closed) return;
              closed = true; streams.delete(close);
              openingSignal.removeEventListener('abort', close); streamSignal.removeEventListener('abort', close);
              socket.close(); if (!opened) reject(openingError);
            }
            streams.add(close); openingSignal.addEventListener('abort', close, { once: true }); streamSignal.addEventListener('abort', close, { once: true });
            socket.addEventListener('open', () => {
              if (closed || openingSignal.aborted) { close(); return; }
              opened = true; openingSignal.removeEventListener('abort', close);
              resolve(Object.freeze({
                send(value) {
                  try {
                    check(streamSignal); const text = JSON.stringify(value);
                    if (closed || typeof text !== 'string' || Buffer.byteLength(text) > maxMessageBytes || socket.bufferedAmount > maxMessageBytes) throw fail('runtime-unavailable');
                    socket.send(text);
                  } catch (error) { close(); throw safe(error); }
                }, close,
              }));
            });
            socket.addEventListener('message', event => {
              if (closed || streamSignal.aborted) return;
              try {
                if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > maxMessageBytes) throw fail('runtime-unavailable');
                onMessage(lease.sanitize(JSON.parse(event.data)));
              } catch (error) { try { onError(safe(error)); } catch {} close(); }
            });
            function openingFailure(event) {
              const error = fail('runtime-unavailable');
              // Undici has no stable public handshake status. A trusted connector
              // exposing a status must not fall through to the opaque diagnostic.
              if (!opened && !closed && !openingSignal.aborted && !streamSignal.aborted &&
                  (event?.status ?? event?.error?.status) === 401) error[observedOpening401] = true;
              if (!opened && !closed && !openingSignal.aborted && !streamSignal.aborted &&
                  event?.status === undefined && event?.error?.status === undefined) error[opaqueOpeningFailure] = true;
              return error;
            }
            socket.addEventListener('error', event => { if (opened && !closed) { try { onError(fail('runtime-unavailable')); } catch {} } close(openingFailure(event)); });
            socket.addEventListener('close', event => { const notify = opened && !closed; close(openingFailure(event)); if (notify) { try { onClose(); } catch {} } });
          }));
        }
        try { return await openOnce(); }
        catch (error) {
          if (!native || openingSignal.aborted || error?.code === 'permission-denied') throw error;
          if (error?.[observedOpening401] !== true) {
            if (error?.[opaqueOpeningFailure] !== true) throw error;
            const diagnostic = await requestRaw('/api/session/modelCatalog', {
              method: 'POST', headers: { cookie: attempted.cookie, 'content-type': 'application/json' }, signal: openingSignal, consumeBody: false,
              body: JSON.stringify({ type: 'client-request', rpcId: 'native-auth-diagnostic', method: 'session/modelCatalog', payload: { args: {} } }),
            });
            if (diagnostic.status !== 401) throw fail('runtime-unavailable');
          }
          await lease.authenticate(nativeExchange, { signal: openingSignal, generation: attempted.generation, refresh: true });
          try { return await openOnce(); }
          catch (error) {
            let second401 = error?.[observedOpening401] === true;
            if (!second401 && error?.[opaqueOpeningFailure] === true && !openingSignal.aborted) {
              try {
                const diagnostic = await requestRaw('/api/session/modelCatalog', {
                  method: 'POST', headers: { cookie: attempted.cookie, 'content-type': 'application/json' },
                  signal: openingSignal, consumeBody: false,
                  body: JSON.stringify({ type: 'client-request', rpcId: 'native-auth-diagnostic', method: 'session/modelCatalog', payload: { args: {} } }),
                });
                second401 = diagnostic.status === 401;
              } catch { /* An uncertain replacement failure has no epoch-wide authority. */ }
            }
            if (second401 && !openingSignal.aborted) {
              try { await lease.fail('runtime-unavailable'); } catch { /* Preserve the replacement opening error. */ }
            }
            throw error;
          }
        }
      }, signal);
    },
    async dispose() {
      lifetime.abort(); cookie = '';
      for (const close of [...streams]) close();
      const release = lease.dispose();
      await Promise.allSettled([release, cleanupPending]);
      cleanupClosed = true;
    },
  });
}
